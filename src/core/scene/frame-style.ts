// The animated values of one frame. Springs work on a flat record of numbers, so styles are
// flattened to short keys and back.

import type { RectLike } from '../geometry/rect';

export interface FrameStyle {
  screen: RectLike;
  camera: RectLike | null;
  cursor: { x01: number; y01: number; opacity: number; scale: number; rotation: number; fadeBlur: number };
  background: { scale: number; originX: number; originY: number; blur: number };
  zoom: number;
  loupe: LoupeStyle;
}

// Glass loupe, in recording coordinates: centre 0..1 of width/height, radius as a fraction of
// the recording width. presence 0 = invisible (but still placed, so it can grow in place).
export interface LoupeStyle {
  x01: number;
  y01: number;
  radius: number;
  zoom: number;
  bevelRatio: number;
  chromaticAberration: number;
  shadowAlpha: number;
  presence: number;
}

export function flatten(s: FrameStyle): Record<string, number> {
  const r: Record<string, number> = {
    sx: s.screen.x,
    sy: s.screen.y,
    sw: s.screen.width,
    sh: s.screen.height,
    cx01: s.cursor.x01,
    cy01: s.cursor.y01,
    cop: s.cursor.opacity,
    csc: s.cursor.scale,
    crot: s.cursor.rotation,
    cblur: s.cursor.fadeBlur,
    bgs: s.background.scale,
    bgx: s.background.originX,
    bgy: s.background.originY,
    bgb: s.background.blur,
    zoom: s.zoom,
    lx: s.loupe.x01,
    ly: s.loupe.y01,
    lr: s.loupe.radius,
    lz: s.loupe.zoom,
    lb: s.loupe.bevelRatio,
    lc: s.loupe.chromaticAberration,
    ls: s.loupe.shadowAlpha,
    lp: s.loupe.presence,
  };
  if (s.camera) {
    r.kx = s.camera.x;
    r.ky = s.camera.y;
    r.kw = s.camera.width;
    r.kh = s.camera.height;
  }
  return r;
}

export function unflatten(r: Record<string, number>): FrameStyle {
  return {
    screen: { x: r.sx, y: r.sy, width: r.sw, height: r.sh },
    camera: 'kx' in r ? { x: r.kx, y: r.ky, width: r.kw, height: r.kh } : null,
    cursor: { x01: r.cx01, y01: r.cy01, opacity: r.cop, scale: r.csc, rotation: r.crot, fadeBlur: r.cblur },
    background: { scale: r.bgs, originX: r.bgx, originY: r.bgy, blur: r.bgb },
    zoom: r.zoom,
    loupe: { x01: r.lx, y01: r.ly, radius: r.lr, zoom: r.lz, bevelRatio: r.lb, chromaticAberration: r.lc, shadowAlpha: r.ls, presence: r.lp },
  };
}
