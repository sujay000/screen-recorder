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
    type: 'color' | 'gradient' | 'mesh' | 'image';
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
  clickStyle: 'none' | 'circle' | 'ripple';
  ripplePull01: number;
  loupe: LoupeInputs | null;
  camera: null | { now: RectV; before: RectV; radius: number; opacity: number; mirror: boolean; focus: [number, number]; grain: number; grainSeed: number; lutIntensity: number };
}

// Glass loupe in screen-video pixels (the reference does its lens math in video pixels, and its
// 1-pixel minimums only mean the same thing there).
export interface LoupeInputs {
  videoSize: [number, number];
  center: [number, number];
  radius: number;
  bevel: number;
  zoom: number;
  chromaticAberration: number;
  lightDirection: [number, number]; // unit vector from the lens centre toward the light
  shineExponent: number;
  lightTilt: number;
  shadowAlpha: number;
  shadowSize: number;
  presence: number;
  fringeReads: number; // colour-fringe samples: 16 on export, 4 in the preview
  magnifyCenter: [number, number]; // lens centre in stage units
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
const LOUPE_LIGHT_SIZE = 0.1;
const LOUPE_SHADOW_SIZE = 0.9;
const RIPPLE_MS = 1000;

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
  videoSize: { width: number; height: number },
  playbackMs = sourceTimeMs,
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

  const radius = cfg.output.paddingRatio01 === 0 ? 0 : cfg.styles.screenBorderRadius * layout.sourcePixelScale * zoomRatio * Math.max(0, now.screenRoundness);

  const sh = cfg.styles.shadow;
  const rad = (sh.angle * Math.PI) / 180;
  const blur = sh.blur * SHADOW_BLUR_SCALE * zoomRatio;
  const offset: [number, number] = [sh.distance * Math.cos(rad), sh.distance * Math.sin(rad)];
  const halfDiag = Math.hypot(stage.width / 2, stage.height / 2);
  const light: [number, number] = [stage.width / 2 - Math.cos(rad) * LIGHT_DISTANCE * halfDiag, stage.height / 2 - Math.sin(rad) * LIGHT_DISTANCE * halfDiag];

  const bg = cfg.styles.background;
  const stops =
    bg.type === 'gradient' || bg.type === 'mesh'
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
  // Effects sit on the recorded click time and position, moving with the zoomed screen.
  const effectMs = clickEffect?.type === 'circle' ? CIRCLE_MS : clickEffect?.type === 'ripple' ? RIPPLE_MS : 0;
  const clicks = effectMs
    ? scene.cursor
        .recentClicks(sourceTimeMs)
        .map((c) => ({ x: now.screen.x + c.center01.x * now.screen.width, y: now.screen.y + c.center01.y * now.screen.height, age01: (sourceTimeMs - c.startedAtMs) / effectMs }))
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
    clickStyle: clickEffect?.type ?? 'none',
    ripplePull01: clickEffect?.type === 'ripple' ? (clickEffect.pullSize01 ?? 0.04) : 0.04,
    loupe: loupeInputs(now, light, stage, videoSize, q),
    camera: cameraInputs(scene, now, prev, strength, playbackMs),
  };
}

// Webcam bubble or panel; rect, radius and opacity are animated by the scene springs.
// Film grain is reseeded 24 times a second, cycling through 1024 seeds (B39 Hf).
const GRAIN_SEED_FPS = 24;
const GRAIN_SEED_CYCLE = 1024;

function cameraInputs(scene: Scene, now: FrameStyle, prev: FrameStyle, strength: number, playbackMs: number): FrameInputs['camera'] {
  const cam = now.camera;
  if (!cam || cam.opacity <= 0.001) return null;
  const before = prev.camera ? lerpRect(cam.rect, prev.camera.rect, strength) : cam.rect;
  const cfg = scene.project.config.camera;
  const grainSeed = ((Math.floor((playbackMs * GRAIN_SEED_FPS) / 1000) % GRAIN_SEED_CYCLE) + GRAIN_SEED_CYCLE) % GRAIN_SEED_CYCLE;
  return {
    now: cam.rect,
    before: nearlySame(cam.rect, before) ? cam.rect : before,
    radius: Math.max(0, cam.radius),
    opacity: Math.min(1, cam.opacity),
    mirror: cfg.mirror,
    focus: [Math.min(1, Math.max(0, cam.focusX)), Math.min(1, Math.max(0, cam.focusY))],
    grain: Math.max(0, cfg.grain),
    grainSeed,
    lutIntensity: cfg.lutPath ? Math.min(1, Math.max(0, cfg.lutIntensity)) : 0,
  };
}

// Spec: render.md §5 (the reference's loupe uniform encoder).
function loupeInputs(style: FrameStyle, light: [number, number], stage: { width: number; height: number }, video: { width: number; height: number }, q: QualityOptions): LoupeInputs | null {
  const l = style.loupe;
  const v = style.screen;
  const W = video.width;
  const H = video.height;
  const radius = Math.max(0, l.radius) * W;
  const bevel = radius * Math.min(1, Math.max(0, l.bevelRatio));
  const zoom = Math.max(l.zoom, 0.05);
  const shadowAlpha = Math.min(1, Math.max(0, l.shadowAlpha));
  const visible = radius > 0.5 && (bevel > 0.05 || Math.abs(zoom - 1) > 0.001 || shadowAlpha > 0.001);
  if (!visible) return null;
  const center: [number, number] = [l.x01 * W, l.y01 * H];
  // The same light as the screen shadow, expressed relative to the screen.
  const dx = ((light[0] - v.x) / v.width) * W - center[0];
  const dy = ((light[1] - v.y) / v.height) * H - center[1];
  const dist = Math.hypot(dx, dy);
  const lightHeight = (Math.max(stage.width, stage.height) / v.width) * W;
  return {
    videoSize: [W, H],
    center,
    radius,
    bevel,
    zoom,
    chromaticAberration: Math.min(1, Math.max(0, l.chromaticAberration)),
    lightDirection: dist < 0.001 ? [0, -1] : [dx / dist, dy / dist],
    shineExponent: Math.min(24, Math.max(1.5, dist / (LOUPE_LIGHT_SIZE * W))),
    lightTilt: Math.min(dist / Math.max(lightHeight, 0.05 * W), 2),
    shadowAlpha,
    shadowSize: LOUPE_SHADOW_SIZE * W,
    presence: Math.min(1, Math.max(0, l.presence)),
    fringeReads: q.motionBlurTaps >= 16 ? 16 : 4,
    magnifyCenter: [v.x + l.x01 * v.width, v.y + l.y01 * v.height],
  };
}
