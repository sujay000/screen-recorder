// Scene: computes, for any playback time, the target style of every animated part (screen
// rect, webcam, cursor, background) before springs are applied (spec: zoom-camera.md §3-5,
// cursor.md §4, render.md §4.4). Springs are applied by animation/timeline.ts.

import { Layout } from '../camera/layout';
import { decimate, groupAt, groupSamples, isInInstantSnapWindow, type MovementGroup, screenMovingZoom, zoomSamples } from '../camera/zoom';
import { type ResolvedSpringConfig, SPRING_PRESETS, resolveSpring } from '../animation/spring';
import { CursorModel } from '../cursor/cursor';
import type { MouseEvent, Project, Zoom } from '../project/model';
import type { Vec2 } from '../geometry/rect';
import type { FrameStyle } from './frame-style';

const INSTANT = resolveSpring(SPRING_PRESETS.instant);
const FADE = resolveSpring(SPRING_PRESETS.medium);
const TYPING_FADE = resolveSpring(SPRING_PRESETS.typingFade);
const TILT_ROTATION = resolveSpring({ stiffness: 120, damping: 8, mass: 1 });
const FOLLOW_ROTATION = resolveSpring({ stiffness: 320, damping: 28, mass: 1 });
const PRESS_SCALE = 0.9;
const FADE_BLUR_PX = 10;
const BG_ZOOM_GROWTH = 0.125;

export interface SceneOptions {
  hasCamera: boolean;
  hoverChangeTimes?: number[];
  // Reuse a cursor model built for the same cursor settings (planning the path is the slow part,
  // and zoom or style edits do not change it).
  cursor?: CursorModel;
}

// Everything the cursor model depends on; equal keys mean the model can be reused.
export function cursorModelKey(project: Project, hoverChangeTimes: number[] = []): string {
  return JSON.stringify([project.config.cursor, project.config.animations.mouseMovementSpring, project.slices, hoverChangeTimes.length]);
}

export class Scene {
  readonly project: Project;
  readonly layout: Layout;
  readonly cursor: CursorModel;
  private decimated: MouseEvent[];
  private zoomGroups = new Map<string, MovementGroup[]>();
  private restGroups: MovementGroup[];

  constructor(project: Project, opts: SceneOptions) {
    this.project = project;
    const cfg = project.config;
    const src = project.recording.displayBounds;
    this.layout = new Layout({
      sourceSize: { width: src.width, height: src.height },
      aspectRatio: cfg.output.aspectRatio,
      paddingRatio01: cfg.output.paddingRatio01,
      avoidEmptyZoomArea: cfg.output.avoidEmptyZoomArea,
      camera:
        opts.hasCamera && !cfg.camera.hide
          ? { sizeRatio01: cfg.camera.sizeRatio01, paddingRatio01: 0.5, aspectRatio: cfg.camera.aspectRatio, position01: cfg.camera.position01, zoomedScale: 0.8 }
          : null,
    });
    this.cursor = opts.cursor ?? new CursorModel(project, opts.hoverChangeTimes ?? []);
    this.decimated = decimate(this.cursor.events, 10);
    const restSamples = this.decimated.map((e) => ({ t: e.recordingTimeMs, x: e.x, y: e.y }));
    const rd = this.layout.getVisibleSourcePart(1);
    this.restGroups = groupSamples(restSamples, { x: rd.x * 0.5, y: rd.y * 0.5 });
  }

  get playbackDurationMs(): number {
    return this.cursor.timeMap.playbackDurationMs;
  }

  private groupsFor(z: Zoom): MovementGroup[] {
    let g = this.zoomGroups.get(z.id);
    if (!g) {
      const vis = this.layout.getVisibleSourcePart(z.zoom);
      g = groupSamples(zoomSamples(this.decimated, this.cursor.events, z, this.cursor.smoothing), { x: vis.x * 0.5, y: vis.y * 0.5 });
      this.zoomGroups.set(z.id, g);
    }
    return g;
  }

  invalidateZooms(): void {
    this.zoomGroups.clear();
  }

  zoomPointAt(sourceT: number): { position01: Vec2; scale: number } | null {
    const z = screenMovingZoom(this.project.zooms, sourceT, this.project.config.zooms.startAnimationEarly);
    if (!z) return null;
    if (z.type === 'manual') return { position01: z.manualTargetPoint, scale: z.zoom };
    const groups = this.groupsFor(z);
    const g = groupAt(groups, sourceT) ?? groups[0];
    if (!g) return { position01: { x: 0.5, y: 0.5 }, scale: z.zoom };
    const c = g.center;
    const size = this.project.recording.displayBounds;
    return { position01: { x: c.x / size.width, y: c.y / size.height }, scale: z.zoom };
  }

  restingFocus01(sourceT: number): Vec2 {
    const g = groupAt(this.restGroups, sourceT);
    if (!g) return { x: 0.5, y: 0.5 };
    const c = g.center;
    const size = this.project.recording.displayBounds;
    return { x: c.x / size.width, y: c.y / size.height };
  }

  // Target style at playback time t (springs are applied by the timeline).
  targetAt(playbackT: number): FrameStyle {
    const t = this.cursor.timeMap.playbackToSource(playbackT);
    const point = this.zoomPointAt(t);
    const screen = point ? this.layout.getScreenRect(point.position01, point.scale) : this.layout.getScreenRect(this.restingFocus01(t), 1);
    const zoom = point?.scale ?? 1;
    const focus = point?.position01 ?? { x: 0.5, y: 0.5 };
    const pos = this.cursor.positionAt(playbackT);
    const size = this.project.recording.displayBounds;
    const cfg = this.project.config;
    const drawn = !cfg.cursor.hide && pos !== null;
    const visible = drawn && this.cursor.isVisible(t);
    const typing = drawn && this.cursor.isTyping(t);
    const camera = point ? this.layout.zoomedCameraRect : this.layout.cameraRect;
    return {
      screen: screen.raw,
      camera: camera ? camera.raw : null,
      cursor: {
        x01: pos ? pos.x / size.width : 0.5,
        y01: pos ? pos.y / size.height : 0.5,
        opacity: drawn && visible && !typing ? 1 : 0,
        scale: drawn ? (this.cursor.isPressed(t) ? PRESS_SCALE : 1) : 0,
        rotation: this.cursor.rotationTargetAt(playbackT),
        fadeBlur: visible && !typing ? 0 : FADE_BLUR_PX,
      },
      background: {
        scale: 1 + (zoom - 1) * BG_ZOOM_GROWTH,
        originX: focus.x,
        originY: focus.y,
        blur: cfg.styles.background.blur > 0 || zoom <= 1 ? 0 : 8 * zoom,
      },
      zoom,
    };
  }

  springFor(playbackT: number): (key: string) => ResolvedSpringConfig {
    const t = this.cursor.timeMap.playbackToSource(playbackT);
    const cfg = this.project.config;
    const screenSpring = isInInstantSnapWindow(this.project.zooms, t) ? INSTANT : resolveSpring(cfg.animations.screenMovementSpring);
    const slice = this.cursor.timeMap.sliceAtSource(t);
    const cursorSpring = cfg.animations.mouseMovementSpring === null || slice?.disableSmoothMouseMovement ? INSTANT : resolveSpring(cfg.animations.mouseMovementSpring);
    const typing = this.cursor.isTyping(t);
    return (key: string) => {
      switch (key) {
        case 'cx01':
        case 'cy01':
          return INSTANT; // smoothing already happened in the planner
        case 'cop':
          return typing ? TYPING_FADE : FADE;
        case 'cblur':
          return FADE;
        case 'csc':
          return cursorSpring;
        case 'crot':
          return cfg.cursor.rotationMode === 'directional' ? FOLLOW_ROTATION : TILT_ROTATION;
        default:
          return screenSpring;
      }
    };
  }

  isAnimationDisabled(playbackT: number): boolean {
    return isInInstantSnapWindow(this.project.zooms, this.cursor.timeMap.playbackToSource(playbackT));
  }
}
