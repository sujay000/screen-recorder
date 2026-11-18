// Hover-change detector (spec: cursor.md §2.6.1, the reference's native HoverDetector). Finds the
// moments when moving the mouse made something under it change, like a button highlighting.
// Those become "hover" sync points so the drawn cursor is where the real one was.
//
// It works on small YCbCr patches cut out of the decoded screen video around the cursor, so the
// whole frame never has to stay in memory.

import type { MouseEvent } from '../project/model';
import { atOrBefore, sliceBetween } from '../geometry/search';

export const HOVER = {
  probeRadiusPt: 8,
  referenceLagMs: 120,
  settledForMs: 150,
  pixelChangeThreshold: 10,
  coherenceTolerance01: 0.35,
  minimumCoherenceTolerance: 6,
  minimumChangedFraction: 0.4,
  minimumCoherentFraction: 0.3,
  minimumSurroundingQuarters: 3,
  minimumQuarterCoherentFraction: 0.15,
  maximumSettledChangedFraction: 0.08,
  scrollProbeRadiusPt: 24,
  maximumScrollPt: 32,
  scrollExplainedResidual01: 0.5,
  minimumMovementPt: 3,
  movementWindowMs: 150,
  clickExclusionBeforeMs: 300,
  clickExclusionAfterMs: 80,
  movementJoinGapMs: 1000,
};

// A YCbCr patch of one frame: pixels [x0, x0 + w) × [y0, y0 + h) of a frame `frameW × frameH`.
export interface Patch {
  timeMs: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
}

export interface FrameSize {
  width: number;
  height: number;
}

const rt = (e: { recordingTimeMs: number }) => e.recordingTimeMs;

// Pixel rect to cut from the frame at time t: later frames compare against this one (as reference
// or settled frame) around *their* cursor positions, so cover the cursor path over the next
// lag + settle window, plus the scroll probe and its largest shift.
export function patchRectFor(moves: MouseEvent[], t: number, ppp: number, frame: FrameSize): { x0: number; y0: number; w: number; h: number } | null {
  const ahead = HOVER.referenceLagMs + HOVER.settledForMs + 50;
  const pts = sliceBetween(moves, t, t + ahead, rt);
  const prev = atOrBefore(moves, t, rt);
  if (prev) pts.unshift(prev);
  if (!pts.length) return null;
  const margin = Math.ceil((HOVER.scrollProbeRadiusPt + HOVER.maximumScrollPt + 2) * ppp);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of pts) {
    minX = Math.min(minX, e.x * ppp);
    minY = Math.min(minY, e.y * ppp);
    maxX = Math.max(maxX, e.x * ppp);
    maxY = Math.max(maxY, e.y * ppp);
  }
  const x0 = Math.max(0, Math.floor(minX) - margin);
  const y0 = Math.max(0, Math.floor(minY) - margin);
  const x1 = Math.min(frame.width, Math.ceil(maxX) + margin + 1);
  const y1 = Math.min(frame.height, Math.ceil(maxY) + margin + 1);
  return x1 > x0 && y1 > y0 ? { x0, y0, w: x1 - x0, h: y1 - y0 } : null;
}

// Time spans in which the pointer moved (joined across short pauses), plus a tail.
export function movementSpans(moves: MouseEvent[]): { startMs: number; endMs: number }[] {
  const spans: { startMs: number; endMs: number }[] = [];
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1];
    const b = moves[i];
    if (a.x === b.x && a.y === b.y) continue;
    const last = spans[spans.length - 1];
    if (last && a.recordingTimeMs - last.endMs <= HOVER.movementJoinGapMs) last.endMs = b.recordingTimeMs + HOVER.movementWindowMs;
    else spans.push({ startMs: a.recordingTimeMs, endMs: b.recordingTimeMs + HOVER.movementWindowMs });
  }
  return spans;
}

function pixel(p: Patch, x: number, y: number): number {
  const lx = x - p.x0;
  const ly = y - p.y0;
  if (lx < 0 || ly < 0 || lx >= p.w || ly >= p.h) return -1;
  return ly * p.w + lx;
}

function contains(p: Patch, x0: number, y0: number, x1: number, y1: number): boolean {
  return x0 >= p.x0 && y0 >= p.y0 && x1 < p.x0 + p.w && y1 < p.y0 + p.h;
}

export interface Comparison {
  changedFraction: number;
  coherentFraction: number;
  quadrantFractions: [number, number, number, number];
}

// Compares two frames in a square window around the cursor. Returns null if a patch does not
// cover the window.
export function compare(a: Patch, b: Patch, cx: number, cy: number, ppp: number, frame: FrameSize): Comparison | null {
  let r = Math.trunc(HOVER.probeRadiusPt * ppp);
  if (r < 3) r = 2;
  const x0 = Math.max(0, Math.round(cx) - r);
  const y0 = Math.max(0, Math.round(cy) - r);
  const x1 = Math.min(frame.width - 1, Math.round(cx) + r);
  const y1 = Math.min(frame.height - 1, Math.round(cy) + r);
  if (x1 < x0 || y1 < y0 || !contains(a, x0, y0, x1, y1) || !contains(b, x0, y0, x1, y1)) return null;
  const qCount = [0, 0, 0, 0];
  const changed: { dy: number; dcb: number; dcr: number; q: number }[] = [];
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      total++;
      const q = (y >= cy ? 2 : 0) + (x >= cx ? 1 : 0);
      qCount[q]++;
      const ia = pixel(a, x, y);
      const ib = pixel(b, x, y);
      const dy = a.y[ia] - b.y[ib];
      const dcb = a.cb[ia] - b.cb[ib];
      const dcr = a.cr[ia] - b.cr[ib];
      if (Math.abs(dy) + Math.abs(dcb) + Math.abs(dcr) >= HOVER.pixelChangeThreshold) changed.push({ dy, dcb, dcr, q });
    }
  }
  const qCoherent = [0, 0, 0, 0];
  let coherent = 0;
  if (changed.length) {
    const median = (v: number[]) => v.sort((m, n) => m - n)[v.length >> 1];
    const my = median(changed.map((c) => c.dy));
    const mcb = median(changed.map((c) => c.dcb));
    const mcr = median(changed.map((c) => c.dcr));
    const raw = HOVER.coherenceTolerance01 * (Math.abs(my) + Math.abs(mcb) + Math.abs(mcr));
    const tol = Math.max(HOVER.minimumCoherenceTolerance, Math.sign(raw) * Math.round(Math.abs(raw))); // round half away from zero
    for (const c of changed) {
      if (Math.abs(c.dy - my) + Math.abs(c.dcb - mcb) + Math.abs(c.dcr - mcr) <= tol) {
        coherent++;
        qCoherent[c.q]++;
      }
    }
  }
  return {
    changedFraction: changed.length / total,
    coherentFraction: coherent / total,
    quadrantFractions: qCoherent.map((n, i) => (qCount[i] ? n / qCount[i] : 0)) as Comparison['quadrantFractions'],
  };
}

// True if shifting the reference vertically or horizontally by up to 32 pt explains the change
// (scrolling, not hovering). Luma only, one sample per point.
export function isExplainedByScrolling(frame: Patch, ref: Patch, cx: number, cy: number, ppp: number, size: FrameSize): boolean {
  const step = Math.max(1, Math.round(ppp));
  const r = Math.round(HOVER.scrollProbeRadiusPt * ppp);
  const maxShift = Math.round(HOVER.maximumScrollPt * ppp);
  const sad = (dx: number, dy: number): number | null => {
    let s = 0;
    for (let y = Math.round(cy) - r; y <= Math.round(cy) + r; y += step) {
      for (let x = Math.round(cx) - r; x <= Math.round(cx) + r; x += step) {
        const rx = x + dx;
        const ry = y + dy;
        if (x < 0 || y < 0 || rx < 0 || ry < 0 || x >= size.width || rx >= size.width || y >= size.height || ry >= size.height) return null;
        const i = pixel(frame, x, y);
        const j = pixel(ref, rx, ry);
        if (i < 0 || j < 0) return null;
        s += Math.abs(frame.y[i] - ref.y[j]);
      }
    }
    return s;
  };
  const base = sad(0, 0);
  if (!base) return false;
  let best = Infinity;
  for (let s = -maxShift; s <= maxShift; s += step) {
    if (s === 0) continue;
    for (const v of [sad(0, s), sad(s, 0)]) if (v !== null && v < best) best = v;
  }
  return best < HOVER.scrollExplainedResidual01 * base;
}

function movementPtBetween(moves: MouseEvent[], from: number, to: number): number {
  const s = sliceBetween(moves, from, to, rt);
  const prev = atOrBefore(moves, from, rt);
  const pts = prev ? [prev, ...s] : s;
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

export class HoverDetector {
  private history: Patch[] = [];
  readonly changes: number[] = [];
  // Debug aid: called with the reason a frame was rejected (or 'change').
  onEvaluate?: (t: number, reason: string, detail?: unknown) => void;

  constructor(
    private readonly moves: MouseEvent[], // points, recording time
    private readonly clicks: MouseEvent[],
    private readonly ppp: number, // pixels per point
    private readonly size: FrameSize,
  ) {}

  // Cursor position in video pixels at time t (last recorded position).
  cursorPx(t: number): { x: number; y: number } | null {
    const e = atOrBefore(this.moves, t, rt);
    return e ? { x: e.x * this.ppp, y: e.y * this.ppp } : null;
  }

  // Feed frames in time order. Each patch must be centred on cursorPx(patch.timeMs).
  push(p: Patch): void {
    this.history.push(p);
    const keepFrom = p.timeMs - HOVER.referenceLagMs - HOVER.settledForMs - 200;
    while (this.history.length > 2 && this.history[0].timeMs < keepFrom) this.history.shift();
    const t = p.timeMs;
    const c = this.cursorPx(t);
    if (!c) return;
    const moved = movementPtBetween(this.moves, t - HOVER.movementWindowMs, t);
    if (moved < HOVER.minimumMovementPt) return this.onEvaluate?.(t, 'not moving', moved);
    if (this.clicks.some((k) => k.recordingTimeMs >= t - HOVER.clickExclusionBeforeMs && k.recordingTimeMs < t + HOVER.clickExclusionAfterMs)) return this.onEvaluate?.(t, 'near click');
    const ref = this.newestAtOrBefore(t - HOVER.referenceLagMs);
    if (!ref) return this.onEvaluate?.(t, 'no reference');
    const settled = this.newestAtOrBefore(ref.timeMs - HOVER.settledForMs);
    const cmp = compare(p, ref, c.x, c.y, this.ppp, this.size);
    if (!cmp || cmp.changedFraction < HOVER.minimumChangedFraction || cmp.coherentFraction < HOVER.minimumCoherentFraction) return this.onEvaluate?.(t, 'weak change', cmp);
    if (cmp.quadrantFractions.filter((f) => f >= HOVER.minimumQuarterCoherentFraction).length < HOVER.minimumSurroundingQuarters) return this.onEvaluate?.(t, 'not surrounding', cmp);
    if (settled && settled !== ref) {
      const still = compare(ref, settled, c.x, c.y, this.ppp, this.size);
      if (!still || still.changedFraction > HOVER.maximumSettledChangedFraction) return this.onEvaluate?.(t, 'not settled before', still);
    }
    if (isExplainedByScrolling(p, ref, c.x, c.y, this.ppp, this.size)) return this.onEvaluate?.(t, 'scrolling');
    // Until the reference frame passes the change, the same change keeps matching. The reference
    // reports only the first frame (inferred from its caches: 4 of 5 detections identical, the
    // fifth one frame apart), so suppress repeats within the reference lag.
    const last = this.changes[this.changes.length - 1];
    if (last !== undefined && t - last <= HOVER.referenceLagMs) return this.onEvaluate?.(t, 'repeat of previous change');
    this.changes.push(t);
    this.onEvaluate?.(t, 'change', cmp);
  }

  private newestAtOrBefore(t: number): Patch | null {
    let r: Patch | null = null;
    for (const h of this.history) if (h.timeMs <= t) r = h;
    return r;
  }
}
