// Figma-style smoothed corners ("squircles"), as the reference draws the screen and webcam
// (render.md §4.1, B39sgn5K.js:10617-10880). The corner outline is line → cubic → arc → cubic →
// line. The shader cannot trace that path, so we sample it into a 16-entry table: for rays from
// the corner centre, the outline distance divided by the corner extent p. The shader then uses a
// rounded-rect SDF whose radius is p × table(angle).

export const SQUIRCLE_SAMPLES = 16;

// Corner extent: how far from the edge the smoothed corner starts.
export function squircleExtent(w: number, h: number, r: number, roundness: number): number {
  const m = Math.min(w, h);
  return Math.min(m / 2, (1 + roundness) * Math.min(r, m / 2));
}

interface CornerParams {
  p: number;
  a: number;
  b: number;
  c: number;
  d: number;
  arcAngle: number; // degrees
  radius: number;
}

function cornerParams(w: number, h: number, r0: number, roundness: number): CornerParams {
  const m = Math.min(w, h);
  const radius = Math.min(r0, m / 2);
  const p = squircleExtent(w, h, r0, roundness);
  let arcMeasure: number;
  let angleBezier: number;
  if (radius > m / 4) {
    const k = (radius - m / 4) / (m / 4);
    arcMeasure = (1 - roundness * (1 - k)) * 90;
    angleBezier = roundness * 45 * (1 - k);
  } else {
    arcMeasure = (1 - roundness) * 90;
    angleBezier = roundness * 45;
  }
  const deg = Math.PI / 180;
  const arcAngle = (90 - arcMeasure) / 2;
  const tanHalf = radius * Math.tan((arcAngle / 2) * deg);
  const arcSection = Math.sin((arcMeasure / 2) * deg) * radius * Math.SQRT2;
  const c = tanHalf * Math.cos(angleBezier * deg);
  const d = c * Math.tan(angleBezier * deg);
  const b = (p - arcSection - c - d) / 3;
  return { p, a: 2 * b, b, c, d, arcAngle, radius };
}

type Pt = { x: number; y: number };

const cubic = (s: Pt, c1: Pt, c2: Pt, e: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * s.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * e.x,
    y: u * u * u * s.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * e.y,
  };
};

// Points along the top-right corner outline (y down), from the top edge to the right edge.
function cornerOutline(w: number, cp: CornerParams): Pt[] {
  const { p, a, b, c, d, arcAngle, radius } = cp;
  const pts: Pt[] = [];
  const N = 64;
  const s1: Pt = { x: w - p, y: 0 };
  const e1: Pt = { x: w - p + a + b + c, y: d };
  for (let i = 0; i <= N; i++) pts.push(cubic(s1, { x: w - p + a, y: 0 }, { x: w - p + a + b, y: 0 }, e1, i / N));
  const centre: Pt = { x: w - radius, y: radius };
  const deg = Math.PI / 180;
  const from = (270 + arcAngle) * deg;
  const to = (360 - arcAngle) * deg;
  for (let i = 0; i <= N; i++) {
    const t = from + ((to - from) * i) / N;
    pts.push({ x: centre.x + radius * Math.cos(t), y: centre.y + radius * Math.sin(t) });
  }
  const s2: Pt = { x: w - d, y: p - a - b - c };
  for (let i = 0; i <= N; i++) pts.push(cubic(s2, { x: w, y: p - a - b }, { x: w, y: p - a }, { x: w, y: p }, i / N));
  return pts;
}

// Ray-length table: entry i is for the ray at angle i/15 · 45° from straight up (entry 0 = 1).
export function squircleLut(w: number, h: number, r: number, roundness = 1): Float32Array {
  const lut = new Float32Array(SQUIRCLE_SAMPLES).fill(1);
  if (r <= 0 || w <= 0 || h <= 0) return lut;
  const cp = cornerParams(w, h, r, roundness);
  if (cp.p <= 0) return lut;
  const origin = { x: w - cp.p, y: cp.p };
  // The outline is star-shaped around the corner centre: tabulate (angle, distance).
  const polar = cornerOutline(w, cp)
    .map((q) => ({ angle: Math.atan2(q.x - origin.x, origin.y - q.y), dist: Math.hypot(q.x - origin.x, q.y - origin.y) }))
    .filter((q) => q.angle >= 0 && q.angle <= Math.PI / 2)
    .sort((m, n) => m.angle - n.angle);
  for (let i = 1; i < SQUIRCLE_SAMPLES; i++) {
    const target = (i / (SQUIRCLE_SAMPLES - 1)) * (Math.PI / 4);
    let k = polar.findIndex((q) => q.angle >= target);
    if (k <= 0) k = Math.max(1, k);
    const lo = polar[k - 1];
    const hi = polar[k] ?? lo;
    const f = hi.angle > lo.angle ? (target - lo.angle) / (hi.angle - lo.angle) : 0;
    lut[i] = (lo.dist + (hi.dist - lo.dist) * f) / cp.p;
  }
  return lut;
}

const cache = new Map<string, Float32Array>();

// Cached: in practice the table only depends on the radius relative to the short side.
export function squircleLutCached(w: number, h: number, r: number): Float32Array {
  const key = `${Math.round((r / Math.max(1e-6, Math.min(w, h))) * 1000)}`;
  let lut = cache.get(key);
  if (!lut) {
    const m = Math.min(w, h);
    lut = squircleLut(m, m, (r / Math.max(1e-6, m)) * m);
    if (cache.size > 64) cache.clear();
    cache.set(key, lut);
  }
  return lut;
}
