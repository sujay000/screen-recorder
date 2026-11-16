// Axis-aligned rect with the same operation semantics as the reference editor's geometry
// (spec: zoom-camera.md §5, render.md §4.2). Immutable; every op returns a new Rect.

export interface Vec2 {
  x: number;
  y: number;
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const CENTER: Vec2 = { x: 0.5, y: 0.5 };
export const ORIGIN: Vec2 = { x: 0, y: 0 };

// Padding for a ratio: shrinking divides by (1 + 2|r|), growing multiplies by it; half of the
// size change goes on each side.
export function paddingFromRatio(size: number, ratio: number): number {
  const factor = 1 + Math.abs(ratio) * 2;
  const resized = ratio < 0 ? size / factor : size * factor;
  return (resized - size) / 2;
}

export class Rect implements RectLike {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;

  constructor(r: Partial<RectLike> & { width: number; height: number }) {
    this.x = r.x ?? 0;
    this.y = r.y ?? 0;
    this.width = r.width;
    this.height = r.height;
  }

  static from(r: RectLike): Rect {
    return r instanceof Rect ? r : new Rect(r);
  }

  static fromAspectRatio(aspect: number, size: { width: number } | { height: number }): Rect {
    if ('width' in size) {
      return new Rect({ width: size.width, height: size.width / aspect });
    }
    return new Rect({ width: size.height * aspect, height: size.height });
  }

  get endX(): number {
    return this.x + this.width;
  }

  get endY(): number {
    return this.y + this.height;
  }

  get aspectRatio(): number {
    return this.width / this.height;
  }

  get shortestSide(): number {
    return Math.min(this.width, this.height);
  }

  get center(): Vec2 {
    return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
  }

  get raw(): RectLike {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  pointAt(p01: Vec2): Vec2 {
    return { x: this.x + p01.x * this.width, y: this.y + p01.y * this.height };
  }

  padByRatio(ratio: number): Rect {
    const p = paddingFromRatio(Math.min(this.width, this.height), ratio);
    return new Rect({ x: this.x - p, y: this.y - p, width: this.width + p * 2, height: this.height + p * 2 });
  }

  align(container: RectLike, at: Vec2): Rect {
    return new Rect({
      x: container.x + at.x * (container.width - this.width),
      y: container.y + at.y * (container.height - this.height),
      width: this.width,
      height: this.height,
    });
  }

  fitInside(container: RectLike, at: Vec2 = CENTER, allowUpscale = false): Rect {
    let s = Math.min(container.width / this.width, container.height / this.height);
    if (s > 1 && !allowUpscale) s = 1;
    const w = this.width * s;
    const h = this.height * s;
    return new Rect({
      x: container.x + (container.width - w) * at.x,
      y: container.y + (container.height - h) * at.y,
      width: w,
      height: h,
    });
  }

  cover(container: RectLike, at: Vec2 = CENTER): Rect {
    const s = Math.max(container.width / this.width, container.height / this.height);
    const w = this.width * s;
    const h = this.height * s;
    const overX = w - container.width;
    const overY = h - container.height;
    return new Rect({
      x: lerp(container.x, container.x - overX, at.x),
      y: lerp(container.y, container.y - overY, at.y),
      width: w,
      height: h,
    });
  }

  moveBy(d: Vec2): Rect {
    return new Rect({ x: this.x + d.x, y: this.y + d.y, width: this.width, height: this.height });
  }

  // Scales about origin01 (a relative point of this rect), keeping that point fixed.
  scale(s: number | Vec2, origin01: Vec2 = ORIGIN): Rect {
    const sv = typeof s === 'number' ? { x: s, y: s } : s;
    const ox = origin01.x * this.width;
    const oy = origin01.y * this.height;
    return new Rect({
      x: this.x + ox * (1 - sv.x),
      y: this.y + oy * (1 - sv.y),
      width: this.width * sv.x,
      height: this.height * sv.y,
    });
  }

  // Per axis: larger than the area -> clamp so the area stays covered; otherwise centre it.
  containInZoomArea(area: RectLike): Rect {
    let x = this.x;
    let y = this.y;
    if (this.width > area.width) {
      x = clamp(x, area.x + area.width - this.width, area.x);
    } else {
      x = area.x + (area.width - this.width) / 2;
    }
    if (this.height > area.height) {
      y = clamp(y, area.y + area.height - this.height, area.y);
    } else {
      y = area.y + (area.height - this.height) / 2;
    }
    return new Rect({ x, y, width: this.width, height: this.height });
  }

  // Moves so focus01 of this rect lands on target (default: area centre), scales by z about
  // focus01, then contains in area.
  zoom(z: number, focus01: Vec2 = ORIGIN, area: RectLike = this, target?: Vec2): Rect {
    const p = this.pointAt(focus01);
    const t = target ?? Rect.from(area).center;
    return this.moveBy({ x: t.x - p.x, y: t.y - p.y })
      .scale(z, focus01)
      .containInZoomArea(area);
  }

  getFitsInside(other: RectLike): boolean {
    return (
      other.x <= this.x &&
      other.x + other.width >= this.endX &&
      other.y <= this.y &&
      other.y + other.height >= this.endY
    );
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Linear remap of v from [a0, a1] to [b0, b1], clamped to the output range.
export function remap(v: number, a0: number, a1: number, b0: number, b1: number): number {
  if (a1 === a0) return b0;
  const t = clamp((v - a0) / (a1 - a0), 0, 1);
  return b0 + (b1 - b0) * t;
}
