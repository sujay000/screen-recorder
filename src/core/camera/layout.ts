// Stage layout: stage rect, zoom area, screen rect for a focus point and zoom, webcam overlay
// (spec: zoom-camera.md §5, §5b; render.md §4.2).

import { Rect, type RectLike, type Vec2, remap } from '../geometry/rect';

export const STAGE_HEIGHT = 1080;

export interface LayoutInput {
  sourceSize: { width: number; height: number }; // cropped recording size, in points
  aspectRatio: 'auto' | number;
  paddingRatio01: number;
  avoidEmptyZoomArea: boolean;
  camera: null | {
    sizeRatio01: number;
    paddingRatio01: number;
    aspectRatio: number;
    position01: Vec2;
    zoomedScale: number;
  };
}

export class Layout {
  readonly input: LayoutInput;
  readonly source: Rect;
  readonly stage: Rect;
  readonly zoomArea: Rect;
  readonly initialScreenRect: Rect;
  readonly cameraRect: Rect | null;
  readonly zoomedCameraRect: Rect | null;

  constructor(input: LayoutInput) {
    this.input = input;
    this.source = new Rect({ width: input.sourceSize.width, height: input.sourceSize.height });
    const aspect = input.aspectRatio === 'auto' ? this.source.padByRatio(input.paddingRatio01).aspectRatio : input.aspectRatio;
    this.stage = Rect.fromAspectRatio(aspect, { height: STAGE_HEIGHT });
    this.zoomArea = this.stage.padByRatio(-input.paddingRatio01);
    this.initialScreenRect = input.avoidEmptyZoomArea ? this.source.cover(this.zoomArea) : this.source.fitInside(this.zoomArea, undefined, true);
    this.cameraRect = input.camera ? this.cameraRectFor(1, 1) : null;
    this.zoomedCameraRect = input.camera ? this.cameraRectFor(input.camera.zoomedScale, 0.5) : null;
  }

  // Camera-overlay bubble: square-fitted rect of the camera aspect, aligned inside the stage
  // padded by the resolved padding.
  private cameraRectFor(scale: number, padMul: number): Rect {
    const cam = this.input.camera!;
    const stagePad = this.input.paddingRatio01;
    const resolvedPad = stagePad < 0.1 ? remap(cam.paddingRatio01, 0, 1, 0.025, 0.1) : remap(cam.paddingRatio01, 0, 1, 0.025, stagePad);
    const area = this.stage.padByRatio(-resolvedPad * padMul);
    const w = this.stage.shortestSide * cam.sizeRatio01 * scale;
    return Rect.fromAspectRatio(cam.aspectRatio, { width: w })
      .fitInside({ x: 0, y: 0, width: w, height: w })
      .align(area, cam.position01);
  }

  get sourcePixelScale(): number {
    return this.initialScreenRect.width / this.source.width;
  }

  getScreenRect(focus01: Vec2, zoom: number): Rect {
    const target = avoidCameraTarget(this.zoomArea, this.cameraRect);
    return this.initialScreenRect.zoom(zoom, focus01, this.zoomArea, target);
  }

  // Part of the source (in source units) visible at a zoom level. Mixes stage pixels and source
  // points exactly like the reference does.
  getVisibleSourcePart(zoom: number): Vec2 {
    const zoomed = this.source.zoom(zoom, { x: 0.5, y: 0.5 }, this.zoomArea);
    return {
      x: Math.min(1, this.stage.width / zoomed.width) * this.source.width,
      y: Math.min(1, this.stage.height / zoomed.height) * this.source.height,
    };
  }
}

// Zoom-area point that keeps the zoom focus clear of the webcam bubble.
export function avoidCameraTarget(area: RectLike, cam: RectLike | null): Vec2 {
  const c = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  if (!cam || area.width <= 0 || area.height <= 0) return c;
  const aL = area.x;
  const aT = area.y;
  const aR = area.x + area.width;
  const aB = area.y + area.height;
  const iL = Math.max(cam.x, aL);
  const iT = Math.max(cam.y, aT);
  const iR = Math.min(cam.x + cam.width, aR);
  const iB = Math.min(cam.y + cam.height, aB);
  if (iL >= iR || iT >= iB || (iL <= aL && iT <= aT && iR >= aR && iB >= aB)) return c;
  const inter = { left: iL, top: iT, right: iR, bottom: iB };
  const bounds = { left: aL, top: aT, right: aR, bottom: aB };
  const centerInside = c.x >= iL && c.x <= iR && c.y >= iT && c.y <= iB;
  const cands: { point: Vec2; room: number; dist: number }[] = [];
  const consider = (p: Vec2) => {
    if (p.x < aL || p.x > aR || p.y < aT || p.y > aB) return;
    if (p.x >= iL && p.x <= iR && p.y >= iT && p.y <= iB) return;
    cands.push({ point: p, room: breathingRoom(p, bounds, inter), dist: Math.hypot(p.x - c.x, p.y - c.y) });
  };
  if (!centerInside) consider(c);
  if (iT > aT) consider({ x: aL + area.width / 2, y: (aT + iT) / 2 });
  if (iB < aB) consider({ x: aL + area.width / 2, y: (iB + aB) / 2 });
  if (iL > aL) consider({ x: (aL + iL) / 2, y: aT + area.height / 2 });
  if (iR < aR) consider({ x: (iR + aR) / 2, y: aT + area.height / 2 });
  if (cands.length === 0) return c;
  cands.sort((a, b) => {
    const d = b.room - a.room;
    return Math.abs(d) > 1e-9 ? d : a.dist - b.dist;
  });
  return cands[0].point;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function breathingRoom(p: Vec2, b: Edges, cam: Edges): number {
  let left = p.x - b.left;
  let right = b.right - p.x;
  let top = p.y - b.top;
  let bottom = b.bottom - p.y;
  if (p.y > cam.top && p.y < cam.bottom) {
    if (p.x < cam.left) right = Math.min(right, cam.left - p.x);
    if (p.x > cam.right) left = Math.min(left, p.x - cam.right);
  }
  if (p.x > cam.left && p.x < cam.right) {
    if (p.y < cam.top) bottom = Math.min(bottom, cam.top - p.y);
    if (p.y > cam.bottom) top = Math.min(top, p.y - cam.bottom);
  }
  return Math.min(left, right, top, bottom);
}
