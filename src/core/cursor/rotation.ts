// Cursor tilt: keyframes of a rotation that leans with horizontal velocity (spec: cursor.md §4.2,
// "velocity" mode). Computed from retimed raw events, not from the smoothed path.

import { indexAtOrAfter } from '../geometry/search';
import type { MouseEvent } from '../project/model';

export interface Keyframe {
  recordingTimeMs: number;
  rotationRad: number;
}

const rt = (e: { recordingTimeMs: number }) => e.recordingTimeMs;

const TILT = { velocitySmoothingMs: 120, tiltDegPerVelocity: 12, maxTiltDeg: 20, startupCalmMs: 500, entryTeleportSpeedPxPerMs: 15 };
const DEDUPE_RAD = 0.0015;

class KeyframeSink {
  keyframes: Keyframe[] = [];
  private last = NaN;
  private pending: Keyframe | null = null;

  emit(t: number, rad: number, force = false): void {
    if (!force && Math.abs(rad - this.last) < DEDUPE_RAD) {
      this.pending = { recordingTimeMs: t, rotationRad: rad };
      return;
    }
    if (this.pending && this.pending.recordingTimeMs < t) this.keyframes.push(this.pending);
    this.pending = null;
    const lk = this.keyframes[this.keyframes.length - 1];
    if (lk && lk.recordingTimeMs === t) lk.rotationRad = rad;
    else this.keyframes.push({ recordingTimeMs: t, rotationRad: rad });
    this.last = rad;
  }
}

export function tiltKeyframes(events: MouseEvent[], ratio: number): Keyframe[] {
  const sink = new KeyframeSink();
  if (!events.length || !ratio) return sink.keyframes;
  const teleport =
    events.length >= 2 &&
    events[1].recordingTimeMs - events[0].recordingTimeMs > 0 &&
    Math.hypot(events[1].x - events[0].x, events[1].y - events[0].y) / (events[1].recordingTimeMs - events[0].recordingTimeMs) >
      TILT.entryTeleportSpeedPxPerMs;
  const start = teleport ? 2 : 1;
  let v = initialVelocity(events, TILT.velocitySmoothingMs, start);
  const tilt = (x: number) => (Math.max(-TILT.maxTiltDeg, Math.min(TILT.maxTiltDeg, x * TILT.tiltDegPerVelocity * ratio)) * Math.PI) / 180;
  sink.emit(events[0].recordingTimeMs, tilt(v), true);
  const step = (t0: number, dt: number, target: number) => {
    const n = Math.max(1, Math.ceil(dt / 16));
    const h = dt / n;
    const alpha = 1 - Math.exp(-h / TILT.velocitySmoothingMs);
    for (let i = 1; i <= n; i++) {
      v += (target - v) * alpha;
      sink.emit(t0 + i * h, tilt(v));
    }
  };
  let prev = events[0];
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const dt = e.recordingTimeMs - prev.recordingTimeMs;
    if (dt > 0) step(prev.recordingTimeMs, dt, i < start ? 0 : (e.x - prev.x) / dt);
    prev = e;
  }
  const tail = TILT.velocitySmoothingMs * 6;
  step(prev.recordingTimeMs, tail, 0);
  sink.emit(prev.recordingTimeMs + tail, 0, true);
  return startupCalm(sink.keyframes, TILT.startupCalmMs);
}

function initialVelocity(events: MouseEvent[], windowMs: number, start: number): number {
  const base = events[start - 1];
  if (!base) return 0;
  for (let i = start; i < events.length; i++) {
    const dt = events[i].recordingTimeMs - base.recordingTimeMs;
    if (!(dt < windowMs) || !(i < events.length - 1)) return dt > 0 ? (events[i].x - base.x) / dt : 0;
  }
  return 0;
}

function startupCalm(k: Keyframe[], calmMs: number): Keyframe[] {
  if (k.length < 2 || calmMs <= 0) return k;
  const t0 = k[0].recordingTimeMs;
  const t1 = t0 + calmMs;
  const a = interpKeyframes(k, t1);
  return [{ recordingTimeMs: t0, rotationRad: a }, { recordingTimeMs: t1, rotationRad: a }, ...k.filter((x) => x.recordingTimeMs > t1)];
}

export function interpKeyframes(k: Keyframe[], t: number): number {
  if (!k.length) return 0;
  const i = indexAtOrAfter(k, t, rt);
  // Same lookup as "at or before" with lower-bound semantics.
  let idx: number | null;
  if (i !== null && k[i].recordingTimeMs === t) idx = i;
  else if (i === null) idx = k.length - 1;
  else idx = i > 0 ? i - 1 : null;
  if (idx === null) return k[0].rotationRad;
  const a = k[idx];
  const b = k[idx + 1];
  if (!b) return a.rotationRad;
  const span = b.recordingTimeMs - a.recordingTimeMs;
  const f = span > 0 ? Math.max(0, Math.min(1, (t - a.recordingTimeMs) / span)) : 0;
  return a.rotationRad + (b.rotationRad - a.rotationRad) * f;
}

// ---- Follow ("directional") rotation -------------------------------------------------------------

const FOLLOW = {
  alignRatePerPx: 0.00005,
  speedSaturationPxPerMs: 3,
  angularDampingMs: 100,
  maxTurnRateDegPerMs: 0.4,
  maxFromNeutralDeg: 135,
  minTravelPx: 4,
  neutralPullHeadingDeg: -112.5,
  startupCalmMs: 500,
  entryTeleportSpeedPxPerMs: 15,
};
const rad = (d: number) => (d * Math.PI) / 180;
const wrapPi = (a: number) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const clampAbs = (v: number, m: number) => Math.max(-m, Math.min(m, v));

function isEntryTeleport(events: MouseEvent[]): boolean {
  if (events.length < 2) return false;
  const dt = events[1].recordingTimeMs - events[0].recordingTimeMs;
  return dt > 0 && Math.hypot(events[1].x - events[0].x, events[1].y - events[0].y) / dt > FOLLOW.entryTeleportSpeedPxPerMs;
}

// Bearing of the first >= 4 px travel, relative to the neutral heading.
function initialBearing(events: MouseEvent[], start: number): number {
  const base = events[start - 1];
  if (!base) return 0;
  for (let i = start; i < events.length; i++) {
    const dx = events[i].x - base.x;
    const dy = events[i].y - base.y;
    if (!(Math.hypot(dx, dy) < FOLLOW.minTravelPx)) return clampAbs(wrapPi(Math.atan2(dy, dx) - rad(FOLLOW.neutralPullHeadingDeg)), rad(FOLLOW.maxFromNeutralDeg));
  }
  return 0;
}

// The cursor turns toward its direction of travel, with angular damping and a turn-rate limit.
export function followKeyframes(events: MouseEvent[], startRotation?: number): Keyframe[] {
  const sink = new KeyframeSink();
  if (!events.length) return sink.keyframes;
  const neutral = rad(FOLLOW.neutralPullHeadingDeg);
  const maxRot = rad(FOLLOW.maxFromNeutralDeg);
  const maxTurn = rad(FOLLOW.maxTurnRateDegPerMs);
  const start = isEntryTeleport(events) ? 2 : 1;
  let rot = startRotation ?? initialBearing(events, start);
  let omega = 0;
  let ax = 0;
  let ay = 0;
  let at = 0;
  sink.emit(events[0].recordingTimeMs, rot, true);
  const step = (t0: number, dt: number, heading: number | null, speed: number) => {
    const n = Math.max(1, Math.ceil(dt / 16));
    const h = dt / n;
    const damp = Math.exp(-h / FOLLOW.angularDampingMs);
    for (let i = 1; i <= n; i++) {
      if (heading !== null) omega += FOLLOW.alignRatePerPx * Math.min(speed, FOLLOW.speedSaturationPxPerMs) * Math.sin(heading - (neutral + rot)) * h;
      omega *= damp;
      omega = clampAbs(omega, maxTurn);
      rot += omega * h;
      if (Math.abs(rot) > maxRot) {
        rot = clampAbs(rot, maxRot);
        omega = 0;
      }
      sink.emit(t0 + i * h, rot);
    }
  };
  let prev = events[0];
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const dt = e.recordingTimeMs - prev.recordingTimeMs;
    if (dt > 0) {
      if (i < start) {
        step(prev.recordingTimeMs, dt, null, 0);
        prev = e;
        continue;
      }
      ax += e.x - prev.x;
      ay += e.y - prev.y;
      at += dt;
      const travel = Math.hypot(ax, ay);
      if (travel >= FOLLOW.minTravelPx) {
        step(prev.recordingTimeMs, dt, Math.atan2(ay, ax), travel / at);
        ax = 0;
        ay = 0;
        at = 0;
      } else {
        step(prev.recordingTimeMs, dt, null, 0);
      }
    }
    prev = e;
  }
  const tail = FOLLOW.angularDampingMs * 8;
  step(prev.recordingTimeMs, tail, null, 0);
  sink.emit(prev.recordingTimeMs + tail, rot, true);
  return startupCalm(sink.keyframes, FOLLOW.startupCalmMs);
}
