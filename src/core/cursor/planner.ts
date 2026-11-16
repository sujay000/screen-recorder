// Smoothed cursor path planner (spec: cursor.md §2.3-2.5). The drawn cursor is a 2D spring that
// follows the recorded path sampled `lead` ms ahead, with a per-group look-ahead and speed boost
// chosen so it lands within tolerance at clicks, hovers and cursor-image changes.

import { type ResolvedSpringConfig } from '../animation/spring';
import { indexAtOrAfter, indexAtOrBefore } from '../geometry/search';
import type { Vec2 } from '../geometry/rect';

export const PLANNER = {
  groupGapMs: 100,
  mergeGapMs: 400,
  maxLeadMs: 600,
  approachWindowMs: 1500,
  compressionWindowMs: 400,
  maxCompressionRate: 1.4,
  leadDecayPerMs: 0.35,
  speedLevels: [1, 1.25, 1.6, 2, 2.5, 3.2, 4, 5, 6.4, 8, 10, 13, 16, 20, 25, 32],
  speedBlendInMs: 250,
  speedBlendOutMs: 300,
  acceptedErrorRatio: 0.75,
};
type Settings = typeof PLANNER;

const INTERP_GAP_MS = 40;
const SNAP = 0.01;
const SPEED_GRID_MS = 4;
const KNOT_EPS = 0.001;

export interface PathPoint {
  timeMs: number;
  x: number;
  y: number;
}

export type SyncReason = 'click' | 'drag' | 'hover' | 'cursorImage';

export interface SyncPoint {
  timeMs: number;
  reason: SyncReason;
  tolerancePt: number;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

// ---- Recorded path ----------------------------------------------------------------------------

export class RecordedPath {
  readonly points: PathPoint[];
  readonly movingRanges: TimeRange[];
  private hint = 0;

  constructor(points: PathPoint[]) {
    this.points = points;
    this.movingRanges = movingRangesOf(points);
  }

  get startMs(): number {
    return this.points[0]?.timeMs ?? 0;
  }

  get endMs(): number {
    return this.points[this.points.length - 1]?.timeMs ?? 0;
  }

  positionAt(t: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    const pts = this.points;
    const i = this.findIndex(t);
    if (i < 0) {
      out.x = pts[0]?.x ?? 0;
      out.y = pts[0]?.y ?? 0;
      return out;
    }
    const a = pts[i];
    const b = pts[i + 1];
    if (!b || b.timeMs - a.timeMs > INTERP_GAP_MS || b.timeMs === a.timeMs) {
      out.x = a.x;
      out.y = a.y;
      return out;
    }
    const f = (t - a.timeMs) / (b.timeMs - a.timeMs);
    out.x = a.x + (b.x - a.x) * f;
    out.y = a.y + (b.y - a.y) * f;
    return out;
  }

  private findIndex(t: number): number {
    const pts = this.points;
    for (let i = this.hint; i <= this.hint + 1 && i < pts.length; i++) {
      if (pts[i].timeMs <= t && (i + 1 >= pts.length || pts[i + 1].timeMs > t)) {
        this.hint = i;
        return i;
      }
    }
    const i = indexAtOrBefore(pts, t, (p) => p.timeMs) ?? -1;
    this.hint = i < 0 ? 0 : i;
    return i;
  }

  isStillBetween(a: number, b: number): boolean {
    if (b < a) return this.isStillBetween(b, a);
    const i = indexAtOrBefore(this.movingRanges, b, (r) => r.startMs);
    if (i === null) return true;
    return this.movingRanges[i].endMs <= a;
  }

  lastRestEndingBy(t: number): TimeRange | null {
    const i = indexAtOrBefore(this.movingRanges, t, (r) => r.startMs);
    if (i === null) return null;
    return { startMs: this.movingRanges[i - 1]?.endMs ?? -Infinity, endMs: this.movingRanges[i].startMs };
  }
}

function movingRangesOf(points: PathPoint[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const c = points[i];
    if (c.x === p.x && c.y === p.y) continue;
    const start = c.timeMs - p.timeMs <= INTERP_GAP_MS ? p.timeMs : c.timeMs;
    const last = out[out.length - 1];
    if (last && last.endMs >= start) {
      last.endMs = Math.max(last.endMs, c.timeMs);
    } else {
      out.push({ startMs: start, endMs: Math.max(c.timeMs, start + 0.000001) });
    }
  }
  return out;
}

// ---- Lead and speed schedules -----------------------------------------------------------------

interface Knot {
  timeMs: number;
  leadMs: number;
}

export class LeadSchedule {
  knots: Knot[] = [];
  readonly cutTimesMs: number[];
  private hint = 0;

  constructor(cutTimesMs: number[] = []) {
    this.cutTimesMs = [...cutTimesMs];
  }

  add(timeMs: number, leadMs: number): void {
    const last = this.knots[this.knots.length - 1];
    if (last && timeMs < last.timeMs) throw new Error(`Lead knots must ascend: ${timeMs} after ${last.timeMs}`);
    this.knots.push({ timeMs, leadMs });
  }

  clone(): LeadSchedule {
    const c = new LeadSchedule(this.cutTimesMs);
    c.knots.push(...this.knots);
    return c;
  }

  plannedAt(t: number): number {
    const k = this.knots;
    const i = this.findIndex(t);
    if (i < 0) return 0;
    const a = k[i];
    const b = k[i + 1];
    if (!b || b.timeMs === a.timeMs) return a.leadMs;
    return a.leadMs + ((b.leadMs - a.leadMs) * (t - a.timeMs)) / (b.timeMs - a.timeMs);
  }

  // The look-ahead never crosses a cut.
  at(t: number): number {
    const p = this.plannedAt(t);
    if (p <= 0 || this.cutTimesMs.length === 0) return Math.max(0, p);
    const ci = indexAtOrAfter(this.cutTimesMs, t + 1e-9, (x) => x);
    if (ci === null) return p;
    return Math.min(p, this.cutTimesMs[ci] - t);
  }

  private findIndex(t: number): number {
    const k = this.knots;
    for (let i = this.hint; i <= this.hint + 1 && i < k.length; i++) {
      if (k[i].timeMs <= t && (i + 1 >= k.length || k[i + 1].timeMs > t)) {
        this.hint = i;
        return i;
      }
    }
    const i = indexAtOrBefore(k, t, (x) => x.timeMs) ?? -1;
    this.hint = Math.max(0, i);
    return i;
  }
}

export interface SpeedBump {
  rampInStartMs: number;
  fullStartMs: number;
  fullEndMs: number;
  rampOutEndMs: number;
  speed: number;
}

interface StoredBump extends SpeedBump {
  logSpeed: number;
}

export class SpeedSchedule {
  bumps: StoredBump[] = [];
  longestBumpMs = 0;

  add(b: SpeedBump): void {
    if (!(b.speed <= 1)) {
      this.bumps.push({ ...b, logSpeed: Math.log(b.speed) });
      this.bumps.sort((x, y) => x.rampInStartMs - y.rampInStartMs);
      this.longestBumpMs = Math.max(this.longestBumpMs, b.rampOutEndMs - b.rampInStartMs);
    }
  }

  clone(): SpeedSchedule {
    const c = new SpeedSchedule();
    c.bumps.push(...this.bumps);
    c.longestBumpMs = this.longestBumpMs;
    return c;
  }

  at(t: number): number {
    const b = this.bumps;
    if (b.length === 0) return 1;
    let best = 0;
    for (let i = indexAtOrBefore(b, t, (x) => x.rampInStartMs) ?? -1; i >= 0; i--) {
      const x = b[i];
      if (x.rampInStartMs < t - this.longestBumpMs) break;
      if (x.rampOutEndMs > t) best = Math.max(best, rampLog(x, t));
    }
    return Math.exp(best);
  }
}

function rampLog(b: StoredBump, t: number): number {
  if (t < b.fullStartMs) {
    const len = b.fullStartMs - b.rampInStartMs;
    return len <= 0 ? b.logSpeed : (b.logSpeed * (t - b.rampInStartMs)) / len;
  }
  if (t <= b.fullEndMs) return b.logSpeed;
  const len = b.rampOutEndMs - b.fullEndMs;
  return len <= 0 ? 0 : (b.logSpeed * (b.rampOutEndMs - t)) / len;
}

// ---- Simulation -------------------------------------------------------------------------------

export interface SimState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

function inRanges(ranges: TimeRange[], t: number): boolean {
  return ranges.some((r) => t >= r.startMs && t < r.endMs);
}

export class Simulation {
  constructor(
    readonly path: RecordedPath,
    readonly spring: ResolvedSpringConfig,
    readonly instantRanges: TimeRange[],
  ) {}

  get lagMs(): number {
    return (this.spring.damping / this.spring.stiffness) * 1000;
  }

  restingAt(p: Vec2): SimState {
    return { x: p.x, y: p.y, velocityX: 0, velocityY: 0 };
  }

  targetAt(lead: LeadSchedule, t: number, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    return this.path.positionAt(t + lead.at(t), out);
  }

  run(lead: LeadSchedule, speed: SpeedSchedule, from: number, to: number, s: SimState, onMs?: (t: number, x: number, y: number) => void): SimState {
    let { x, y, velocityX: vx, velocityY: vy } = s;
    const { stiffness: k, damping: c, mass: m, clamp } = this.spring;
    let t = from;
    const tgt = { x: 0, y: 0 };
    const hasInstant = this.instantRanges.length > 0;
    let gridT = NaN;
    let k2 = 0;
    let c2 = 0;
    let w = 0;
    let cCrit = 0;
    while (t < to) {
      const tn = Math.min(to, Math.floor(t) + 1);
      const dt = tn - t;
      this.targetAt(lead, tn, tgt);
      if (m === 0 || (hasInstant && inRanges(this.instantRanges, tn))) {
        x = tgt.x;
        y = tgt.y;
        vx = 0;
        vy = 0;
      } else if (x !== tgt.x || y !== tgt.y || vx !== 0 || vy !== 0) {
        const g = Math.floor(tn / SPEED_GRID_MS) * SPEED_GRID_MS;
        if (g !== gridT) {
          gridT = g;
          const sp = speed.at(g);
          k2 = k * sp * sp;
          c2 = c * sp;
          w = Math.sqrt(k2 / m);
          cCrit = Math.max(c2, Math.sqrt(m * k2) * 2);
        }
        const h = dt / 1000;
        const dx = tgt.x - x;
        const dy = tgt.y - y;
        const cx = clamp && vx * dx > 0 && Math.abs(vx) > Math.abs(dx) * w ? cCrit : c2;
        const cy = clamp && vy * dy > 0 && Math.abs(vy) > Math.abs(dy) * w ? cCrit : c2;
        vx += ((dx * k2 - vx * cx) / m) * h;
        vy += ((dy * k2 - vy * cy) / m) * h;
        x += vx * h;
        y += vy * h;
        if (Math.abs(vx) < SNAP && Math.abs(x - tgt.x) < SNAP) {
          x = tgt.x;
          vx = 0;
        }
        if (Math.abs(vy) < SNAP && Math.abs(y - tgt.y) < SNAP) {
          y = tgt.y;
          vy = 0;
        }
      }
      t = tn;
      if (onMs && t === Math.floor(t)) onMs(t, x, y);
    }
    return { x, y, velocityX: vx, velocityY: vy };
  }
}

// ---- Planner ----------------------------------------------------------------------------------

interface Group {
  startMs: number;
  endMs: number;
  points: SyncPoint[];
}

function groupSyncPoints(points: SyncPoint[], gap: number): Group[] {
  const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs);
  const out: Group[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.timeMs - last.endMs <= gap) {
      last.points.push(p);
      last.endMs = p.timeMs;
    } else {
      out.push({ startMs: p.timeMs, endMs: p.timeMs, points: [p] });
    }
  }
  return out;
}

function decayKnots(path: RecordedPath, anchor: number, prevLead: number, s: Settings): [number, number][] {
  if (prevLead <= 0) return [[anchor, 0]];
  if (path.isStillBetween(anchor, anchor + prevLead)) return [[anchor, prevLead], [anchor + KNOT_EPS, 0]];
  return [[anchor, prevLead], [anchor + prevLead / s.leadDecayPerMs, 0]];
}

function addDecay(path: RecordedPath, lead: LeadSchedule, anchor: number, prevLead: number, s: Settings): void {
  for (const [t, l] of decayKnots(path, anchor, prevLead, s)) lead.add(t, l);
}

class Choice {
  constructor(
    readonly leadMs: number,
    readonly speed: number,
    readonly errorRatio: number,
    readonly endState: SimState,
    readonly leadKnots: [number, number][],
    readonly speedBump: SpeedBump | null,
  ) {}

  get endLeadMs(): number {
    return this.leadKnots[this.leadKnots.length - 1]?.[1] ?? 0;
  }

  commitTo(lead: LeadSchedule, speed: SpeedSchedule): void {
    for (const [t, l] of this.leadKnots) lead.add(t, l);
    if (this.speedBump) speed.add(this.speedBump);
  }
}

interface Context {
  anchorMs: number;
  anchorLeadMs: number;
  anchorState: SimState;
  lead: LeadSchedule;
  speed: SpeedSchedule;
}

class GroupPlanner {
  readonly windowStartMs: number;
  private committed: Float64Array | null = null;

  constructor(
    readonly path: RecordedPath,
    readonly sim: Simulation,
    readonly s: Settings,
    readonly group: Group,
    readonly ctx: Context,
  ) {
    this.windowStartMs = Math.floor(Math.max(ctx.anchorMs, group.startMs - s.approachWindowMs - s.maxLeadMs));
  }

  choose(): Choice {
    const levels = this.s.speedLevels;
    const accept = this.s.acceptedErrorRatio;
    const cache = new Map<number, Choice>();
    const at = (i: number): Choice => {
      let c = cache.get(i);
      if (!c) {
        c = this.chooseLeadFor(levels[i]);
        cache.set(i, c);
      }
      return c;
    };
    const first = at(0);
    if (first.errorRatio <= accept) return first;
    let lo = 0;
    let hi = levels.length - 1;
    if (at(hi).errorRatio > accept) {
      return [...cache.values()].reduce((best, c) => (c.errorRatio < best.errorRatio ? c : best));
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at(mid).errorRatio <= accept) hi = mid;
      else lo = mid;
    }
    return at(hi);
  }

  private chooseLeadFor(speed: number): Choice {
    const { maxLeadMs, acceptedErrorRatio } = this.s;
    const lag = this.sim.lagMs / speed;
    const set = new Set<number>([0]);
    for (let l = lag / 8; l < maxLeadMs; l *= 2) set.add(l);
    set.add(maxLeadMs);
    const cands = [...set].sort((a, b) => a - b);
    const tried: (Choice | null)[] = [];
    let bestIdx = -1;
    for (let i = 0; i < cands.length; i++) {
      const bestErr = bestIdx < 0 ? Infinity : tried[bestIdx]!.errorRatio;
      const c = this.tryKnobs(cands[i], speed, Math.max(acceptedErrorRatio, bestErr));
      tried.push(c);
      if (c) {
        if (c.errorRatio <= acceptedErrorRatio) {
          return i === 0 ? c : this.refineLead(cands[i - 1], cands[i], c, speed);
        }
        if (c.errorRatio < bestErr) bestIdx = i;
      }
    }
    if (bestIdx < 0) return this.tryKnobs(0, speed) ?? tried[0]!;
    return this.minimizeLead(cands[Math.max(0, bestIdx - 1)], cands[Math.min(cands.length - 1, bestIdx + 1)], tried[bestIdx]!, speed);
  }

  private refineLead(lo: number, hi: number, best: Choice, speed: number): Choice {
    let r = best;
    for (let i = 0; i < 6 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2;
      const c = this.tryKnobs(mid, speed);
      if (c && c.errorRatio <= this.s.acceptedErrorRatio) {
        r = c;
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return r;
  }

  private minimizeLead(lo: number, hi: number, best: Choice, speed: number): Choice {
    const phi = (Math.sqrt(5) - 1) / 2;
    let r = best;
    let a = lo;
    let b = hi;
    for (let i = 0; i < 12 && b - a > 0.25; i++) {
      const x1 = b - (b - a) * phi;
      const x2 = a + (b - a) * phi;
      const c1 = this.tryKnobs(x1, speed);
      const c2 = this.tryKnobs(x2, speed);
      const e1 = c1?.errorRatio ?? Infinity;
      const e2 = c2?.errorRatio ?? Infinity;
      if (c1 && e1 < r.errorRatio) r = c1;
      if (c2 && e2 < r.errorRatio) r = c2;
      if (r.errorRatio <= this.s.acceptedErrorRatio) return r;
      if (e1 < e2) b = x2;
      else a = x1;
    }
    return r;
  }

  private tryKnobs(leadMs: number, speed: number, abortAbove = Infinity): Choice | null {
    const lk = this.leadKnots(leadMs);
    if (!lk) return null;
    const { group, ctx, s } = this;
    const lead = ctx.lead.clone();
    for (const [t, l] of lk.knots) lead.add(t, l);
    const sp = ctx.speed.clone();
    const bump: SpeedBump | null =
      speed > 1
        ? {
            rampInStartMs: Math.max(ctx.anchorMs, group.startMs - s.speedBlendInMs),
            fullStartMs: group.startMs,
            fullEndMs: group.endMs,
            rampOutEndMs: group.endMs + s.speedBlendOutMs,
            speed,
          }
        : null;
    if (bump) sp.add(bump);
    const changes = Math.min(lk.changesFromMs, bump?.rampInStartMs ?? Infinity, group.startMs);
    let t = Math.max(this.windowStartMs, Math.floor(changes));
    let state = this.committedStateAt(t);
    let err = 0;
    for (const p of group.points) {
      state = this.sim.run(lead, sp, t, p.timeMs, state);
      t = p.timeMs;
      const pos = this.path.positionAt(p.timeMs);
      err = Math.max(err, Math.hypot(state.x - pos.x, state.y - pos.y) / p.tolerancePt);
      if (err > abortAbove) break;
    }
    return new Choice(leadMs, speed, err, state, lk.knots, bump);
  }

  private committedStateAt(t: number): SimState {
    if (!this.committed) {
      const { ctx, group } = this;
      const lead = ctx.lead.clone();
      addDecay(this.path, lead, ctx.anchorMs, ctx.anchorLeadMs, this.s);
      let st = this.sim.run(lead, ctx.speed, ctx.anchorMs, this.windowStartMs, ctx.anchorState);
      const n = Math.max(1, Math.ceil(group.startMs) - this.windowStartMs + 1);
      const arr = new Float64Array(n * 4);
      arr.set([st.x, st.y, st.velocityX, st.velocityY]);
      for (let i = 1; i < n; i++) {
        st = this.sim.run(lead, ctx.speed, this.windowStartMs + i - 1, this.windowStartMs + i, st);
        arr.set([st.x, st.y, st.velocityX, st.velocityY], i * 4);
      }
      this.committed = arr;
    }
    const arr = this.committed;
    const i = Math.min(arr.length / 4 - 1, Math.max(0, t - this.windowStartMs));
    return { x: arr[i * 4], y: arr[i * 4 + 1], velocityX: arr[i * 4 + 2], velocityY: arr[i * 4 + 3] };
  }

  private leadKnots(leadMs: number): { knots: [number, number][]; changesFromMs: number } | null {
    const { path, group, ctx, s } = this;
    const base = new LeadSchedule();
    addDecay(path, base, ctx.anchorMs, ctx.anchorLeadMs, s);
    const planned = (t: number) => base.plannedAt(t);
    const decay = decayKnots(path, ctx.anchorMs, ctx.anchorLeadMs, s);
    if (leadMs <= 0) {
      return { knots: [...decay.filter(([t]) => t < group.endMs), [group.endMs, planned(group.endMs)]], changesFromMs: group.startMs };
    }
    const raise = this.findLeadRaise(leadMs, planned);
    if (!raise) return null;
    return {
      knots: [
        ...decay.filter(([t]) => t < raise.atMs),
        [raise.atMs, planned(raise.atMs)],
        [raise.atMs + KNOT_EPS, raise.jumpToMs],
        [group.startMs, leadMs],
        [group.endMs, leadMs],
      ],
      changesFromMs: raise.atMs,
    };
  }

  private findLeadRaise(leadMs: number, planned: (t: number) => number): { atMs: number; jumpToMs: number } | null {
    const { path, group, ctx, s } = this;
    const start = group.startMs;
    const approachStart = Math.max(ctx.anchorMs, start - s.approachWindowMs);
    const rateOk = (at: number, jump: number) => {
      const r = (start + leadMs - (at + jump)) / (start - at);
      return r >= 1 - s.leadDecayPerMs && r <= s.maxCompressionRate;
    };
    for (let rest = path.lastRestEndingBy(start + leadMs); rest && rest.endMs > approachStart; rest = path.lastRestEndingBy(rest.startMs)) {
      const at = Math.min(start - 1, Math.max(approachStart, rest.endMs - leadMs));
      const p = planned(at);
      const jump = Math.min(leadMs, rest.endMs - at);
      if (at + Math.min(jump, p) >= rest.startMs && at + Math.max(jump, p) <= rest.endMs && rateOk(at, jump)) {
        return { atMs: at, jumpToMs: jump };
      }
    }
    const at = Math.max(ctx.anchorMs, start - s.compressionWindowMs);
    if (at >= start) return null;
    const p = planned(at);
    return rateOk(at, p) ? { atMs: at, jumpToMs: p } : null;
  }
}

// ---- Baked result -----------------------------------------------------------------------------

interface Run {
  startMs: number;
  xs: Float32Array;
  ys: Float32Array;
}

export class PlannedPath {
  constructor(
    readonly runs: Run[],
    readonly initialPosition: Vec2,
    readonly lead: LeadSchedule,
  ) {}

  positionAt(t: number): Vec2 {
    const i = indexAtOrBefore(this.runs, t, (r) => r.startMs);
    if (i === null) return this.initialPosition;
    const r = this.runs[i];
    const off = t - r.startMs;
    const last = r.xs.length - 1;
    if (off >= last) return { x: r.xs[last], y: r.ys[last] };
    const f0 = Math.floor(off);
    const f = off - f0;
    return { x: r.xs[f0] + (r.xs[f0 + 1] - r.xs[f0]) * f, y: r.ys[f0] + (r.ys[f0 + 1] - r.ys[f0]) * f };
  }

  // Earliest t with t + lead(t) >= T (24 bisection steps in [T - 601, T]).
  getTargetTimeOf(T: number): number {
    let lo = T - PLANNER.maxLeadMs - 1;
    let hi = T;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (mid + this.lead.at(mid) >= T) hi = mid;
      else lo = mid;
    }
    return hi;
  }
}

export interface PlanInput {
  points: PathPoint[];
  syncPoints: SyncPoint[];
  spring: ResolvedSpringConfig;
  durationMs: number;
  cutTimesMs: number[];
  instantRanges: TimeRange[];
}

export function planCursorPath(input: PlanInput, s: Settings = PLANNER): PlannedPath {
  const path = new RecordedPath(input.points);
  const sim = new Simulation(path, input.spring, input.instantRanges);
  const groups = groupSyncPoints(
    input.syncPoints.filter((p) => !inRanges(input.instantRanges, p.timeMs)),
    s.groupGapMs,
  );
  const start0 = Math.min(0, path.startMs);
  const chosen: { group: Group; choice: Choice; leadBefore: LeadSchedule; speedBefore: SpeedSchedule }[] = [];
  let lead = new LeadSchedule(input.cutTimesMs);
  let speed = new SpeedSchedule();
  for (let i = 0; i < groups.length; ) {
    const g = groups[i];
    const prev = chosen[chosen.length - 1];
    const choice = new GroupPlanner(path, sim, s, g, {
      anchorMs: prev?.group.endMs ?? start0,
      anchorLeadMs: prev?.choice.endLeadMs ?? 0,
      anchorState: prev?.choice.endState ?? sim.restingAt(path.positionAt(start0)),
      lead,
      speed,
    }).choose();
    if (choice.errorRatio > 1 && prev && g.startMs - prev.group.endMs <= s.mergeGapMs) {
      chosen.pop();
      lead = prev.leadBefore;
      speed = prev.speedBefore;
      groups[i] = { startMs: prev.group.startMs, endMs: g.endMs, points: [...prev.group.points, ...g.points] };
      continue;
    }
    const leadBefore = lead.clone();
    const speedBefore = speed.clone();
    choice.commitTo(lead, speed);
    chosen.push({ group: g, choice, leadBefore, speedBefore });
    i++;
  }
  const last = chosen[chosen.length - 1];
  addDecay(path, lead, last?.group.endMs ?? start0, last?.choice.endLeadMs ?? 0, s);

  // Bake per-ms runs from a full simulation starting at rest.
  const t0 = Math.min(0, Math.floor(path.startMs));
  const init = sim.targetAt(lead, t0);
  const initial = { x: init.x, y: init.y };
  const runs: Run[] = [];
  let runStart = 0;
  let xs: number[] = [];
  let ys: number[] = [];
  let lx = initial.x;
  let ly = initial.y;
  const flush = () => {
    if (xs.length) runs.push({ startMs: runStart, xs: Float32Array.from(xs), ys: Float32Array.from(ys) });
    xs = [];
    ys = [];
  };
  sim.run(lead, speed, t0, Math.max(t0, Math.ceil(input.durationMs)), sim.restingAt(initial), (t, x, y) => {
    if (x === lx && y === ly) {
      flush();
      return;
    }
    if (!xs.length) runStart = t;
    xs.push(x);
    ys.push(y);
    lx = x;
    ly = y;
  });
  flush();
  return new PlannedPath(runs, initial, lead);
}
