// Face position in the webcam over time (from the face detector, cached in the bundle), used to
// keep the face in the visible part of the cropped webcam bubble.

import type { Vec2 } from '../geometry/rect';

export interface FaceSample {
  t: number; // recording (source) time, ms
  x01: number; // face centre, 0..1 of the webcam frame
  y01: number;
}

const CENTRE: Vec2 = { x: 0.5, y: 0.5 };
const HOLD_MS = 1500; // without detections for this long, drift back to the centre

// Linear interpolation between detections; the springs in the scene smooth the result.
export function faceAt(samples: FaceSample[], t: number): Vec2 {
  if (samples.length === 0) return CENTRE;
  let lo = 0;
  let hi = samples.length - 1;
  if (t <= samples[0].t) return samples[0].t - t > HOLD_MS ? CENTRE : { x: samples[0].x01, y: samples[0].y01 };
  if (t >= samples[hi].t) return t - samples[hi].t > HOLD_MS ? CENTRE : { x: samples[hi].x01, y: samples[hi].y01 };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (b.t - a.t > HOLD_MS * 2) return t - a.t < HOLD_MS ? { x: a.x01, y: a.y01 } : b.t - t < HOLD_MS ? { x: b.x01, y: b.y01 } : CENTRE;
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.x01 + (b.x01 - a.x01) * f, y: a.y01 + (b.y01 - a.y01) * f };
}
