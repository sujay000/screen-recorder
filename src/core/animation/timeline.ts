// Deterministic style timeline: frames on a fixed grid, one live spring advanced frame by
// frame, re-seeded at rest 1000 ms before a requested time on a seek (spec: zoom-camera.md §6).
// Export renders frames in order from frame 0, so an export is one continuous simulation.

import { RecordSpring } from './spring';
import { type FrameStyle, flatten, unflatten } from '../scene/frame-style';
import type { Scene } from '../scene/scene';

export class StyleTimeline {
  readonly fps: number;
  private spring: RecordSpring | null = null;
  private cache = new Map<number, Record<string, number>>();

  constructor(
    readonly scene: Scene,
    fps: number,
  ) {
    this.fps = fps;
  }

  private frameTime(f: number): number {
    return roundEps((1000 / this.fps) * f);
  }

  private frameOf(t: number): number {
    return Math.floor(roundEps(t / (1000 / this.fps)));
  }

  invalidate(): void {
    this.spring = null;
    this.cache.clear();
  }

  private styleForFrame(f: number): Record<string, number> {
    const hit = this.cache.get(f);
    if (hit) return hit;
    const t = this.frameTime(f);
    if (!this.spring || t < this.spring.time || t > this.spring.time + 1000) {
      const tf = this.frameTime(this.frameOf(Math.max(0, t - 1000)));
      this.spring = new RecordSpring(flatten(this.scene.targetAt(tf)));
      this.spring.time = tf;
      this.cache.clear();
      this.cache.set(this.frameOf(tf), { ...this.spring.value });
    }
    for (let fr = this.frameOf(this.spring.time) + 1; fr <= f; fr++) {
      const ft = this.frameTime(fr);
      const targets = flatten(this.scene.targetAt(ft));
      this.spring.setTarget(targets, this.scene.springFor(ft));
      this.spring.advanceTo(ft);
      if (this.scene.isAnimationDisabled(ft)) this.spring.snapToTarget();
      this.cache.set(fr, { ...this.spring.value });
    }
    // Keep the cache bounded: drop frames more than 2 s behind.
    const keep = f - Math.ceil(2000 / (1000 / this.fps));
    for (const k of this.cache.keys()) if (k < keep) this.cache.delete(k);
    return this.cache.get(f)!;
  }

  styleAt(t: number): FrameStyle {
    const fFloat = roundEps(t / (1000 / this.fps));
    const f0 = Math.floor(fFloat);
    const frac = fFloat - f0;
    const a = this.styleForFrame(f0);
    if (frac === 0 || this.scene.isAnimationDisabled(this.frameTime(f0))) return unflatten(a);
    const b = this.styleForFrame(f0 + 1);
    const out: Record<string, number> = {};
    for (const k of Object.keys(a)) out[k] = k in b ? a[k] + (b[k] - a[k]) * frac : a[k];
    return unflatten(out);
  }

  previousFrameStyle(t: number): FrameStyle {
    return this.styleAt(Math.max(0, t - 1000 / this.fps));
  }
}

// Snaps values within 1e-7 of an integer, so frame math is stable against float error.
function roundEps(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-7 ? r : v;
}
