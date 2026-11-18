// Stage layout: stage rect, zoom area, screen rect for a focus point and zoom, and the webcam:
// a bubble over the screen (camera-overlay) or a panel beside it (split-screen)
// (spec: zoom-camera.md §5, §5b; render.md §4.2; reference layouts DgH-sR-Y2.js:6511-7990).

import { Rect, type RectLike, type Vec2, remap } from '../geometry/rect';

export const STAGE_HEIGHT = 1080;

export interface LayoutInput {
  sourceSize: { width: number; height: number }; // cropped recording size, in points
  aspectRatio: 'auto' | number;
  paddingRatio01: number;
  avoidEmptyZoomArea: boolean;
  camera: null | {
    layout?: 'overlay' | 'split' | 'cutout';
    sourceAspectRatio?: number; // webcam frame aspect, for the cutout
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
  // Split-screen only: the screen side, and the bubble layout used while zoomed.
  readonly split: null | { screenSide: Side; zoomed: Layout };

  constructor(input: LayoutInput) {
    this.input = input;
    this.source = new Rect({ width: input.sourceSize.width, height: input.sourceSize.height });
    const isSplit = input.camera?.layout === 'split';
    // Split screen has no padding (its enablePadding option defaults to off).
    const autoAspect = isSplit ? splitAutoAspect(this.source.aspectRatio) : this.source.padByRatio(input.paddingRatio01).aspectRatio;
    const aspect = input.aspectRatio === 'auto' ? autoAspect : input.aspectRatio;
    this.stage = Rect.fromAspectRatio(aspect, { height: STAGE_HEIGHT });
    if (isSplit) {
      const direction = this.stage.aspectRatio >= 1 ? 'horizontal' : 'vertical';
      const g = splitGeometry(this.stage, this.source.aspectRatio, direction);
      this.zoomArea = g.zoomArea;
      this.initialScreenRect = g.screen;
      this.cameraRect = g.camera;
      // While zoomed the panel collapses into a bubble in the corner on the camera's side.
      const zoomed = new Layout({
        ...input,
        aspectRatio: this.stage.aspectRatio,
        paddingRatio01: 0,
        camera: {
          layout: 'overlay',
          sizeRatio01: 0.5,
          paddingRatio01: 0.5,
          aspectRatio: Math.min(16 / 9, Math.max(9 / 16, g.camera.aspectRatio)),
          position01: { x: 1, y: 1 }, // bottom-right for both split directions (cs)
          zoomedScale: 1,
        },
      });
      this.zoomedCameraRect = zoomed.cameraRect;
      this.split = { screenSide: direction === 'horizontal' ? 'left' : 'top', zoomed };
      return;
    }
    this.split = null;
    this.zoomArea = this.stage.padByRatio(-input.paddingRatio01);
    this.initialScreenRect = input.avoidEmptyZoomArea ? this.source.cover(this.zoomArea) : this.source.fitInside(this.zoomArea, undefined, true);
    if (input.camera?.layout === 'cutout') {
      this.cameraRect = this.cutoutRectFor(1);
      this.zoomedCameraRect = this.cutoutRectFor(input.camera.zoomedScale);
      return;
    }
    this.cameraRect = input.camera ? this.cameraRectFor(1, 1) : null;
    this.zoomedCameraRect = input.camera ? this.cameraRectFor(input.camera.zoomedScale, 0.5) : null;
  }

  // Cutout (po): the webcam at its own aspect, standing on the bottom edge of the stage, at the
  // chosen horizontal position inside the padding.
  private cutoutRectFor(scale: number): Rect {
    const cam = this.input.camera!;
    const w = this.stage.shortestSide * cam.sizeRatio01 * scale;
    const padded = this.stage.padByRatio(-this.input.paddingRatio01);
    const band = new Rect({ x: padded.x, y: this.stage.y, width: padded.width, height: this.stage.height });
    return Rect.fromAspectRatio(cam.sourceAspectRatio ?? 1, { width: w })
      .fitInside({ x: 0, y: 0, width: w, height: w })
      .align(band, { x: cam.position01.x, y: 1 });
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
    if (this.split) {
      if (zoom > 1) return this.split.zoomed.getScreenRect(focus01, zoom);
      // Un-zoomed, the cropped screen rests against its own side of the split.
      const rest = this.split.screenSide === 'left' ? { x: 0, y: focus01.y } : { x: focus01.x, y: 0 };
      return this.initialScreenRect.zoom(zoom, rest, this.zoomArea, avoidCameraTarget(this.zoomArea, null));
    }
    const target = avoidCameraTarget(this.zoomArea, this.cameraRect);
    return this.initialScreenRect.zoom(zoom, focus01, this.zoomArea, target);
  }

  // Part of the source (in source units) visible at a zoom level. Mixes stage pixels and source
  // points exactly like the reference does.
  getVisibleSourcePart(zoom: number): Vec2 {
    if (this.split) return this.split.zoomed.getVisibleSourcePart(zoom);
    const zoomed = this.source.zoom(zoom, { x: 0.5, y: 0.5 }, this.zoomArea);
    return {
      x: Math.min(1, this.stage.width / zoomed.width) * this.source.width,
      y: Math.min(1, this.stage.height / zoomed.height) * this.source.height,
    };
  }
}

type Side = 'left' | 'top';

// Auto stage aspect for split screen (Ao): 16:9 if the screen plus a camera panel 0.4..16/9 of
// the height fit a 1920×1080 stage, else wide enough for the screen and a 9:16 panel, 1..2.4.
export function splitAutoAspect(screenAspect: number): number {
  const panel = (1920 - screenAspect * 1080) / 1080;
  if (!(panel < 0.4) && !(panel > 16 / 9)) return 16 / 9;
  return Math.min(2.4, Math.max(1, (screenAspect * 1000 + (9 / 16) * 1000) / 1000));
}

// Screen on the left (or top), camera panel on the right (or bottom), no padding (Uo / Bo / Ro).
function splitGeometry(area: Rect, screenAspect: number, direction: 'horizontal' | 'vertical'): { screen: Rect; camera: Rect; zoomArea: Rect } {
  let camera: Rect;
  if (direction === 'horizontal') {
    // Screen sized to the full height; the camera takes what is left, if that is wide enough.
    const screenW = Rect.fromAspectRatio(screenAspect, { height: area.height }).width;
    const left = area.width - screenW;
    camera = left / area.height > 0.4 ? new Rect({ width: left, height: area.height }) : Rect.fromAspectRatio(0.5, { height: area.height });
    camera = camera.align(area, { x: 1, y: 0.5 });
  } else {
    const half = area.height * 0.5;
    camera = area.width / half < 2.5 ? new Rect({ width: area.width, height: half }) : Rect.fromAspectRatio(2.5, { width: area.width });
    camera = camera.align(area, { x: 0.5, y: 1 });
  }
  const zoomArea =
    direction === 'horizontal'
      ? new Rect({ width: area.width - camera.width, height: area.height }).align(area, { x: 0, y: 0.5 })
      : new Rect({ width: area.width, height: area.height - camera.height }).align(area, { x: 0.5, y: 0 });
  const screen = Rect.fromAspectRatio(screenAspect, { width: 1 }).cover(zoomArea);
  return { screen, camera, zoomArea };
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
