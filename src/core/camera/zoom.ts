// Automatic zooms and camera targeting (spec: zoom-camera.md §1-4).

import type { MouseEvent, Recording, Zoom } from '../project/model';
import type { Vec2 } from '../geometry/rect';

export const ZOOM_LEVEL = 2;
const CLICK_BEFORE_MS = 300;
const CLICK_AFTER_MS = 2500;
const FILL_GAP_MS = 2500;

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `z${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function makeZoom(sourceStartMs: number, sourceEndMs: number, zoom = ZOOM_LEVEL): Zoom {
  return {
    id: newId(),
    sourceStartMs,
    sourceEndMs,
    zoom,
    type: 'follow-click-groups',
    manualTargetPoint: { x: 0.5, y: 0.5 },
    isDisabled: false,
    hasInstantAnimation: false,
  };
}

// Fuse exactly adjacent integer ranges, then ranges whose start is within `gap` of the previous
// end (end takes the later range's end). Repeat until the count stops changing.
export function mergeRanges(ranges: [number, number][], gap: number): [number, number][] {
  let r = ranges.map((x) => [x[0], x[1]] as [number, number]);
  for (;;) {
    const n = r.length;
    r = fuse(r, (prev, cur) => prev[1] + 1 === cur[0]);
    r = fuse(r, (prev, cur) => prev[1] + gap >= cur[0]);
    if (r.length === n) return r;
  }
}

function fuse(r: [number, number][], test: (a: [number, number], b: [number, number]) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (const cur of r) {
    const prev = out[out.length - 1];
    if (prev && test(prev, cur)) {
      prev[1] = cur[1];
    } else {
      out.push([cur[0], cur[1]]);
    }
  }
  return out;
}

// Every mouseDown AND mouseUp makes a [t-300, t+2500] window; clicks in the last second are
// ignored; windows merge when within 2.5 s.
export function generateAutoZooms(rec: Recording, zoomLevel = ZOOM_LEVEL): Zoom[] {
  if (rec.isExternalDeviceMode) return [];
  const d = rec.durationMs;
  const windows: [number, number][] = [];
  for (const e of rec.mouseclicks) {
    if (!(e.recordingTimeMs < d - 1000)) continue;
    const t = Math.floor(e.recordingTimeMs);
    windows.push([Math.max(t - CLICK_BEFORE_MS, 1), Math.min(t + CLICK_AFTER_MS, d - 800)]);
  }
  return mergeRanges(windows, FILL_GAP_MS).map(([a, b]) => makeZoom(Math.floor(a), Math.floor(b), zoomLevel));
}

// ---- Which zoom is active ---------------------------------------------------------------------

export function zoomAt(zooms: Zoom[], t: number): Zoom | null {
  for (const z of zooms) {
    if (!z.isDisabled && z.sourceStartMs <= t && t <= z.sourceEndMs) return z;
  }
  return null;
}

export function screenMovingZoom(zooms: Zoom[], t: number, startAnimationEarly: boolean): Zoom | null {
  const active = zoomAt(zooms, t);
  if (active) return active;
  const leadIn = startAnimationEarly ? 350 : 0;
  if (leadIn > 0) {
    const next = zooms
      .filter((z) => !z.isDisabled && z.sourceStartMs >= t)
      .sort((a, b) => a.sourceStartMs - b.sourceStartMs)[0];
    if (next && !next.hasInstantAnimation && t >= next.sourceStartMs - leadIn) return next;
  }
  return null;
}

export function isInInstantSnapWindow(zooms: Zoom[], t: number): boolean {
  return zooms.some((z) => !z.isDisabled && z.hasInstantAnimation && z.sourceStartMs <= t && t <= z.sourceEndMs + 50);
}

// ---- Cursor samples and movement groups for camera targeting ----------------------------------

// Drop spikes: an event far (Manhattan) from both of the next two events. A dropped mouseDown
// also drops the next mouseUp.
export function removeShakes(events: MouseEvent[], threshold: number): MouseEvent[] {
  if (threshold === 0) return events;
  const out: MouseEvent[] = [];
  let dropNextUp = false;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (dropNextUp && e.type === 'mouseUp') {
      dropNextUp = false;
      continue;
    }
    const a = events[i + 1];
    const b = events[i + 2];
    if (a && b) {
      const da = Math.abs(e.x - a.x) + Math.abs(e.y - a.y);
      const db = Math.abs(e.x - b.x) + Math.abs(e.y - b.y);
      if (da > threshold && db > threshold) {
        if (e.type === 'mouseDown') dropNextUp = true;
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

// Keep the first event, every click and any event at least `minDist` (Euclidean) from the last
// kept one.
export function decimate(events: MouseEvent[], minDist: number): MouseEvent[] {
  const out: MouseEvent[] = [];
  let last: MouseEvent | null = null;
  for (const e of events) {
    if (!last || e.type === 'mouseDown' || e.type === 'mouseUp' || Math.hypot(e.x - last.x, e.y - last.y) >= minDist) {
      out.push(e);
      last = e;
    }
  }
  return out;
}

export interface Sample {
  t: number;
  x: number;
  y: number;
}

export class MovementGroup {
  samples: Sample[] = [];
  finishedTimeMs: number | null = null;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  canAdd(p: Sample, maxD: Vec2): boolean {
    if (this.samples.length === 0) return true;
    const w = Math.max(this.maxX, p.x) - Math.min(this.minX, p.x);
    const h = Math.max(this.maxY, p.y) - Math.min(this.minY, p.y);
    return w <= maxD.x && h <= maxD.y;
  }

  add(p: Sample): void {
    this.samples.push(p);
    this.minX = Math.min(this.minX, p.x);
    this.minY = Math.min(this.minY, p.y);
    this.maxX = Math.max(this.maxX, p.x);
    this.maxY = Math.max(this.maxY, p.y);
  }

  get startMs(): number {
    return this.samples[0].t;
  }

  // Dwell-weighted mean position.
  get center(): Vec2 {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const next = this.samples[i + 1]?.t ?? this.finishedTimeMs ?? s.t + 100;
      const w = next - s.t;
      sx += s.x * w;
      sy += s.y * w;
      sw += w;
    }
    if (sw <= 0) return { x: this.samples[this.samples.length - 1].x, y: this.samples[this.samples.length - 1].y };
    return { x: sx / sw, y: sy / sw };
  }
}

export function groupSamples(samples: Sample[], maxD: Vec2): MovementGroup[] {
  const groups: MovementGroup[] = [];
  let g = new MovementGroup();
  groups.push(g);
  for (const p of samples) {
    if (g.canAdd(p, maxD)) {
      g.add(p);
    } else {
      g.finishedTimeMs = p.t;
      g = new MovementGroup();
      g.add(p);
      groups.push(g);
    }
  }
  return groups.filter((x) => x.samples.length > 0);
}

export function groupAt(groups: MovementGroup[], t: number): MovementGroup | null {
  let found: MovementGroup | null = null;
  for (const g of groups) {
    if (g.startMs <= t) found = g;
    else break;
  }
  return found;
}

function lastAtOrBefore(list: MouseEvent[], t: number): MouseEvent | null {
  let r: MouseEvent | null = null;
  for (const e of list) {
    if (e.recordingTimeMs <= t) r = e;
    else break;
  }
  return r;
}

function firstAfter(list: MouseEvent[], t: number): MouseEvent | null {
  for (const e of list) if (e.recordingTimeMs > t) return e;
  return null;
}

// Samples used to target one zoom. Note the reference looks up "last at or before start" inside
// the already-sliced list, so it only duplicates a sample sitting exactly at the start.
export function zoomSamples(decimated: MouseEvent[], all: MouseEvent[], z: Zoom, smoothing: boolean): Sample[] {
  const s = decimated.filter((e) => e.recordingTimeMs >= z.sourceStartMs && e.recordingTimeMs <= z.sourceEndMs);
  const atStart = lastAtOrBefore(s, z.sourceStartMs);
  const out: Sample[] = s.map((e) => ({ t: e.recordingTimeMs, x: e.x, y: e.y }));
  if (atStart) out.unshift({ t: z.sourceStartMs - 1, x: atStart.x, y: atStart.y });
  if (out.length === 0) {
    let e: MouseEvent | null = null;
    if (smoothing) {
      const c = all.find((x) => (x.type === 'mouseDown' || x.type === 'mouseUp') && x.recordingTimeMs >= z.sourceStartMs);
      if (c && c.recordingTimeMs - z.sourceStartMs <= 500) e = c;
    }
    if (!e) e = lastAtOrBefore(all, z.sourceStartMs) ?? firstAfter(all, z.sourceStartMs);
    if (e) out.push({ t: e.recordingTimeMs, x: e.x, y: e.y });
  }
  return out;
}
