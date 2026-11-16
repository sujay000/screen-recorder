// Turns the animated style of a frame (and of the previous frame, for motion blur) into the
// numbers the GPU compositor needs: screen rect and corner radius, shadow, background, cursor
// quad and click effects (spec: render.md §1-4, cursor.md §4).

import type { Scene } from './scene';
import type { FrameStyle } from './frame-style';
import type { RectLike } from '../geometry/rect';

export type RectV = RectLike;

export interface FrameInputs {
  stage: { width: number; height: number };
  screenNow: RectV;
  screenBefore: RectV;
  screenRadius: number;
  hasScreen: boolean;
  motionBlurTaps: number; // 1 = no motion blur
  shadow: {
    color: [number, number, number];
    alpha: number;
    offset: [number, number];
    blur: number;
    directional: boolean;
    light: [number, number];
    lightRadius: number;
    falloff: number;
  };
  background: {
    type: 'color' | 'gradient' | 'image';
    stops: { rgb: [number, number, number]; at: number }[]; // linear sRGB
    start: [number, number];
    end: [number, number];
    blur: number;
    scale: number;
    origin: [number, number];
  };
  cursor: null | {
    now: RectV;
    before: RectV;
    pivotNow: [number, number];
    pivotBefore: [number, number];
    angleNow: number;
    angleBefore: number;
    opacity: number;
    fadeBlur: number;
  };
  clicks: { x: number; y: number; age01: number }[];
  clickStyle: 'none' | 'circle';
}

// Image facts the cursor size math needs.
export interface CursorImageInfo {
  aspect: number; // width / height of the image
  hotspot01: { x: number; y: number }; // hotspot inside the image, 0..1
  visibleHeight01: number; // glyph height / image height (alpha >= mean-alpha box)
}

export interface QualityOptions {
  fps: number;
  motionBlurTaps: number; // export 16, preview playback 6
  motionBlurEnabled: boolean;
}

const SHADOW_BLUR_SCALE = 8;
const LIGHT_DISTANCE = 1.5;
const CIRCLE_MS = 450;

export function srgbHexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
}

function lerpRect(a: RectLike, b: RectLike, t: number): RectLike {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t };
}

function nearlySame(a: RectLike, b: RectLike): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

interface CursorQuad {
  rect: RectLike;
  pivot: [number, number];
}

// The visible glyph is `size` source points tall at zoom 1, and scales with the zoomed screen.
function cursorQuad(scene: Scene, style: FrameStyle, img: CursorImageInfo): CursorQuad {
  const cfg = scene.project.config.cursor;
  const layout = scene.layout;
  const init = layout.initialScreenRect;
  const heightStage = (cfg.size * layout.sourcePixelScale) / img.visibleHeight01;
  const widthStage = heightStage * img.aspect;
  const v = style.screen;
  const scale = style.cursor.scale;
  const W = (widthStage / init.width) * scale * v.width;
  const H = (heightStage / init.height) * scale * v.height;
  const x = v.x + style.cursor.x01 * v.width - img.hotspot01.x * W;
  const y = v.y + style.cursor.y01 * v.height - img.hotspot01.y * H;
  return { rect: { x, y, width: W, height: H }, pivot: [x + img.hotspot01.x * W, y + img.hotspot01.y * H] };
}

export function buildFrameInputs(
  scene: Scene,
  now: FrameStyle,
  prev: FrameStyle,
  cursorImage: CursorImageInfo | null,
  q: QualityOptions,
  sourceTimeMs: number,
): FrameInputs {
  const cfg = scene.project.config;
  const layout = scene.layout;
  const stage = layout.stage;
  const init = layout.initialScreenRect;
  const zoomRatio = now.screen.width / init.width;

  const instant = scene.isAnimationDisabled(sourceTimeMs);
  const strength = q.motionBlurEnabled && !instant ? cfg.animations.motionBlurAmount * (q.fps / 60) : 0;
  const before = lerpRect(now.screen, prev.screen, strength);
  const screenStatic = strength === 0 || nearlySame(now.screen, before);

  const radius = cfg.output.paddingRatio01 === 0 ? 0 : cfg.styles.screenBorderRadius * layout.sourcePixelScale * zoomRatio;

  const sh = cfg.styles.shadow;
  const rad = (sh.angle * Math.PI) / 180;
  const blur = sh.blur * SHADOW_BLUR_SCALE * zoomRatio;
  const offset: [number, number] = [sh.distance * Math.cos(rad), sh.distance * Math.sin(rad)];
  const halfDiag = Math.hypot(stage.width / 2, stage.height / 2);
  const light: [number, number] = [stage.width / 2 - Math.cos(rad) * LIGHT_DISTANCE * halfDiag, stage.height / 2 - Math.sin(rad) * LIGHT_DISTANCE * halfDiag];

  const bg = cfg.styles.background;
  const stops =
    bg.type === 'gradient'
      ? bg.gradient.stops.map((s) => ({ rgb: srgbHexToLinear(s.color), at: s.at }))
      : [{ rgb: srgbHexToLinear(bg.color), at: 0 }];
  const userBlur = stage.width * (bg.blur / 100) * 0.05;

  let cursor: FrameInputs['cursor'] = null;
  if (cursorImage && now.cursor.opacity > 0.001 && now.cursor.scale > 0) {
    const a = cursorQuad(scene, now, cursorImage);
    const b = cursorQuad(scene, prev, cursorImage);
    const rb = lerpRect(a.rect, b.rect, strength);
    const pb: [number, number] = [a.pivot[0] + (b.pivot[0] - a.pivot[0]) * strength, a.pivot[1] + (b.pivot[1] - a.pivot[1]) * strength];
    const angB = now.cursor.rotation + (prev.cursor.rotation - now.cursor.rotation) * strength;
    cursor = {
      now: a.rect,
      before: rb,
      pivotNow: a.pivot,
      pivotBefore: pb,
      angleNow: now.cursor.rotation,
      angleBefore: angB,
      opacity: now.cursor.opacity,
      fadeBlur: now.cursor.fadeBlur,
    };
  }

  const clickEffect = cfg.cursor.clickEffect;
  const clicks =
    clickEffect?.type === 'circle'
      ? scene.cursor
          .recentClicks(sourceTimeMs)
          .map((c) => ({ x: now.screen.x + c.center01.x * now.screen.width, y: now.screen.y + c.center01.y * now.screen.height, age01: (sourceTimeMs - c.startedAtMs) / CIRCLE_MS }))
          .filter((c) => c.age01 >= 0 && c.age01 < 1)
      : [];

  const cursorMoved = cursor ? !nearlySame(cursor.now, cursor.before) || Math.abs(cursor.angleNow - cursor.angleBefore) > 0.001 : false;
  const taps = screenStatic && !cursorMoved ? 1 : Math.max(1, q.motionBlurTaps);

  return {
    stage: { width: stage.width, height: stage.height },
    screenNow: now.screen,
    screenBefore: screenStatic ? now.screen : before,
    screenRadius: radius,
    hasScreen: true,
    motionBlurTaps: taps,
    shadow: {
      color: [0, 0, 0],
      alpha: sh.intensity,
      offset,
      blur,
      directional: sh.isDirectional,
      light,
      lightRadius: Math.max(blur * 2.5, 4),
      falloff: Math.max(Math.hypot(offset[0], offset[1]) * 6, 40),
    },
    background: {
      type: bg.type,
      stops,
      start: [bg.gradient.start.x, bg.gradient.start.y],
      end: [bg.gradient.end.x, bg.gradient.end.y],
      blur: userBlur > 0 ? userBlur : now.background.blur,
      scale: now.background.scale,
      origin: [now.background.originX, now.background.originY],
    },
    cursor,
    clicks,
    clickStyle: clickEffect?.type === 'circle' ? 'circle' : 'none',
  };
}
