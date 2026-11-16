// Cursor model for one project: prepared events, cursor image at a time, the smoothed path
// (planned in 10 s chunks), rotation, press, visibility, typing and recent clicks
// (spec: cursor.md).

import { resolveSpring, settleTime } from '../animation/spring';
import { removeShakes } from '../camera/zoom';
import { atOrAfter, atOrBefore, sliceBetween } from '../geometry/search';
import type { Vec2 } from '../geometry/rect';
import type { MouseEvent, Project } from '../project/model';
import { TimeMap } from '../project/timemap';
import { type PathPoint, PLANNER, type PlannedPath, planCursorPath, type SyncPoint } from './planner';
import { type Keyframe, interpKeyframes, tiltKeyframes } from './rotation';
import { isUserTyping, optimizeTypes } from './rules';

const CHUNK_MS = 10000;
const PLAN_MARGIN_MS = PLANNER.maxLeadMs + PLANNER.approachWindowMs;
const TOLERANCE = { click: 2, drag: 2, hover: 4, cursorImage: 6 } as const;
const rt = (e: { recordingTimeMs: number }) => e.recordingTimeMs;

interface Chunk {
  playbackStartMs: number;
  path: PlannedPath;
  drawnEvents: MouseEvent[];
  rotation: Keyframe[];
}

export class CursorModel {
  readonly project: Project;
  readonly timeMap: TimeMap;
  readonly events: MouseEvent[]; // shake-filtered, windowed, loop-appended (source time)
  readonly clicks: MouseEvent[];
  readonly typeEvents: MouseEvent[];
  readonly imageChangeTimes: number[];
  hoverChangeTimes: number[] = [];
  private chunks = new Map<number, Chunk>();

  constructor(project: Project, hoverChangeTimes: number[] = []) {
    this.project = project;
    this.timeMap = new TimeMap(project.slices);
    this.hoverChangeTimes = hoverChangeTimes;
    this.events = this.prepareEvents();
    this.clicks = this.events.filter((e) => e.type === 'mouseDown' || e.type === 'mouseUp');
    this.typeEvents = project.config.cursor.optimizeOriginalTypes ? optimizeTypes(project.recording.mouseEvents) : project.recording.mouseEvents;
    this.imageChangeTimes = [];
    let last: string | null = null;
    for (const e of this.typeEvents) {
      if (last !== null && e.cursorId !== last) this.imageChangeTimes.push(e.recordingTimeMs);
      last = e.cursorId;
    }
  }

  private prepareEvents(): MouseEvent[] {
    const cfg = this.project.config.cursor;
    const all = removeShakes(this.project.recording.mouseEvents, cfg.removeShakeTreshold);
    const from = this.timeMap.playbackToSource(0);
    const to = this.timeMap.playbackToSource(Math.max(0, this.timeMap.playbackDurationMs - (cfg.loopPositionBeforeEndMs ?? 0)));
    let s = sliceBetween(all, from, to, rt).map((e) => ({ ...e }));
    if (s.length === 0) {
      const e = atOrBefore(all, from, rt) ?? atOrAfter(all, from, rt);
      s = e ? [{ ...e }] : [];
    }
    if (s.length) s[0] = { ...s[0], recordingTimeMs: from };
    if (cfg.loopPositionBeforeEndMs !== null && s.length) {
      s.push({ ...s[0], recordingTimeMs: s[s.length - 1].recordingTimeMs + 1 });
    }
    return s;
  }

  get smoothing(): boolean {
    return this.project.config.animations.mouseMovementSpring !== null;
  }

  cursorIdAt(sourceT: number): string {
    return atOrBefore(this.typeEvents, sourceT, rt)?.cursorId ?? this.typeEvents[0]?.cursorId ?? 'arrow';
  }

  // ---- Chunked path ----

  private chunk(k: number): Chunk | null {
    const hit = this.chunks.get(k);
    if (hit) {
      this.chunks.delete(k);
      this.chunks.set(k, hit);
      return hit;
    }
    const c = this.planChunk(k);
    if (!c) return null;
    this.chunks.set(k, c);
    if (this.chunks.size > 8) this.chunks.delete(this.chunks.keys().next().value as number);
    return c;
  }

  private planChunk(k: number): Chunk | null {
    if (this.events.length === 0) return null;
    const springCfg = this.project.config.animations.mouseMovementSpring;
    // With smoothing off the spring is unused (everything is an instant range).
    const spring = resolveSpring(springCfg);
    const start = k * CHUNK_MS;
    const plannedFrom = start - settleTime(spring) - PLAN_MARGIN_MS;
    const plannedTo = start + CHUNK_MS + PLAN_MARGIN_MS;
    const parts = this.timeMap.links
      .filter((l) => !(l.playbackEndMs <= plannedFrom || l.playbackStartMs >= plannedTo))
      .map((l, i, arr) => {
        const a = Math.max(l.playbackStartMs, plannedFrom);
        const b = Math.min(l.playbackEndMs, plannedTo);
        const prev = this.timeMap.links[l.index - 1];
        return {
          link: l,
          sourceStartMs: l.playbackToSource(a),
          sourceEndMs: l.playbackToSource(b),
          startMs: a - start,
          endMs: b - start,
          isAfterCut: prev !== undefined && prev.sourceEndMs !== l.sourceStartMs && a === l.playbackStartMs,
          toChunk: (t: number) => l.sourceToPlayback(t) - start,
          first: i === 0 && arr.length > 0,
        };
      });
    const points: PathPoint[] = [];
    const inSlice: { e: MouseEvent; t: number }[] = [];
    const startEvents: MouseEvent[] = [];
    for (const p of parts) {
      const se = atOrBefore(this.events, p.sourceStartMs, rt) ?? this.events[0];
      startEvents.push({ ...se, recordingTimeMs: p.startMs });
      points.push({ timeMs: p.startMs, x: se.x, y: se.y });
      for (const e of sliceBetween(this.events, p.sourceStartMs, p.sourceEndMs, rt)) {
        const t = p.toChunk(e.recordingTimeMs);
        inSlice.push({ e, t });
        points.push({ timeMs: t, x: e.x, y: e.y });
      }
    }
    points.sort((a, b) => a.timeMs - b.timeMs);
    const mapTimes = (times: number[]) =>
      parts.flatMap((p) => times.filter((t) => t >= p.sourceStartMs && t <= p.sourceEndMs).map((t) => p.toChunk(t)));
    const sync: SyncPoint[] = [];
    for (const { e, t } of inSlice) {
      if (e.type === 'mouseDown' || e.type === 'mouseUp') sync.push({ timeMs: t, reason: 'click', tolerancePt: TOLERANCE.click });
      else if (e.type === 'mouseDragged') sync.push({ timeMs: t, reason: 'drag', tolerancePt: TOLERANCE.drag });
    }
    if (this.smoothing) for (const t of mapTimes(this.hoverChangeTimes)) sync.push({ timeMs: t, reason: 'hover', tolerancePt: TOLERANCE.hover });
    for (const t of mapTimes(this.imageChangeTimes)) sync.push({ timeMs: t, reason: 'cursorImage', tolerancePt: TOLERANCE.cursorImage });
    const path = planCursorPath({
      points,
      syncPoints: sync,
      spring,
      durationMs: Math.min(plannedTo, this.timeMap.playbackDurationMs) - start,
      cutTimesMs: parts.filter((p) => p.isAfterCut).map((p) => p.startMs),
      instantRanges:
        springCfg === null
          ? [{ startMs: -Infinity, endMs: Infinity }]
          : parts.filter((p) => p.link.slice.disableSmoothMouseMovement).map((p) => ({ startMs: p.startMs, endMs: p.endMs })),
    });
    const drawn = [startEvents[0], ...inSlice.map(({ e, t }) => ({ ...e, recordingTimeMs: path.getTargetTimeOf(t) }))]
      .filter(Boolean)
      .sort((a, b) => a.recordingTimeMs - b.recordingTimeMs);
    const ratio = this.project.config.cursor.rotationMode === 'none' ? 0 : this.project.config.cursor.rotateOnXMovementRatio;
    return { playbackStartMs: start, path, drawnEvents: drawn, rotation: tiltKeyframes(drawn, ratio) };
  }

  // Smoothed cursor position (source points, crop-relative) at playback time t.
  positionAt(playbackT: number): Vec2 | null {
    const c = this.chunk(Math.floor(playbackT / CHUNK_MS));
    return c ? c.path.positionAt(playbackT - c.playbackStartMs) : null;
  }

  rotationTargetAt(playbackT: number): number {
    const base = (this.project.config.cursor.baseRotation * Math.PI) / 180;
    const c = this.chunk(Math.floor(playbackT / CHUNK_MS));
    if (!c) return base;
    return base + interpKeyframes(c.rotation, playbackT - c.playbackStartMs);
  }

  // ---- State at source time ----

  isPressed(sourceT: number): boolean {
    let e: MouseEvent | null = null;
    if (this.smoothing) {
      const c = atOrAfter(this.clicks, sourceT, rt);
      if (c && c.recordingTimeMs - sourceT <= 500) e = c;
    }
    if (!e) e = atOrBefore(this.events, sourceT, rt);
    return e?.type === 'mouseDown' || e?.type === 'mouseDragged';
  }

  isVisible(sourceT: number): boolean {
    const first = this.events[0];
    if (!first || sourceT < first.recordingTimeMs) return false;
    if (this.timeMap.sliceAtSource(sourceT)?.hideCursor) return false;
    const idle = this.project.config.cursor.hideNotMovingAfterMs;
    if (idle === null) return true;
    const last = atOrBefore(this.events, sourceT, rt);
    return !!last && Math.abs(last.recordingTimeMs - sourceT) <= idle;
  }

  isTyping(sourceT: number): boolean {
    return isUserTyping(this.project.recording.keystrokes, this.project.recording.mouseEvents, sourceT);
  }

  // Up to the 3 most recent mouseDowns in [t - 1000, t], at their recorded time and position.
  recentClicks(sourceT: number): { center01: Vec2; startedAtMs: number }[] {
    const downs = this.clicks.filter((e) => e.type === 'mouseDown');
    const size = this.project.recording.displayBounds;
    return sliceBetween(downs, sourceT - 1000, sourceT, rt)
      .slice(-3)
      .map((e) => ({ center01: { x: e.x / size.width, y: e.y / size.height }, startedAtMs: e.recordingTimeMs }));
  }
}
