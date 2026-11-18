// Project data model: the recording (events, sessions, media tracks) and the editable project
// config. Loading from disk lives in loader.ts.

import type { SpringConfig } from '../animation/spring';
import type { Vec2 } from '../geometry/rect';

export type MouseEventType = 'mouseMoved' | 'mouseDragged' | 'mouseDown' | 'mouseUp';

export interface RawMouseEvent {
  type: MouseEventType;
  x: number;
  y: number;
  cursorId: string;
  processTimeMs: number;
  button?: string;
}

export interface MouseEvent {
  type: MouseEventType;
  x: number;
  y: number;
  cursorId: string;
  recordingTimeMs: number;
  button?: string;
}

export interface RawKeyEvent {
  type: 'keyDown' | 'keyUp';
  character?: string;
  processTimeMs: number;
  isARepeat?: boolean;
}

export interface KeyEvent {
  type: 'keyDown' | 'keyUp';
  character?: string;
  recordingTimeMs: number;
}

export interface CursorInfo {
  id: string;
  hotSpot: Vec2;
  standardSize: { width: number; height: number };
  systemCursor?: boolean;
}

export interface Session {
  processTimeStartMs: number;
  processTimeEndMs: number;
  recordingStartMs: number;
  durationMs: number;
}

export interface MediaTrack {
  // Either an HLS playlist (init + segments) or a single media file, relative to recording/.
  playlist?: string;
  file?: string;
  sessionIndex: number;
  // Recording time at which the track's first sample plays.
  startOffsetMs: number;
}

export interface Recording {
  sessions: Session[];
  durationMs: number;
  mouseEvents: MouseEvent[]; // moves + clicks, time ordered
  mouseclicks: MouseEvent[]; // mouseDown + mouseUp
  keystrokes: KeyEvent[];
  cursors: CursorInfo[];
  displayBounds: { x: number; y: number; width: number; height: number }; // points
  recordingScale: number; // points per pixel
  displayRefreshRate: number;
  screenVideo: MediaTrack[];
  microphone: MediaTrack[];
  systemAudio: MediaTrack[];
  webcam: MediaTrack[];
  isExternalDeviceMode: boolean;
}

export interface Zoom {
  id: string;
  sourceStartMs: number;
  sourceEndMs: number;
  zoom: number;
  type: 'follow-click-groups' | 'manual';
  manualTargetPoint: Vec2;
  isDisabled: boolean;
  hasInstantAnimation: boolean;
}

export interface GradientStop {
  color: string;
  at: number;
}

export interface BackgroundConfig {
  type: 'color' | 'gradient' | 'mesh' | 'image'; // mesh: 4 corner colours from gradient.stops
  color: string;
  gradient: { start: Vec2; end: Vec2; stops: GradientStop[] };
  imagePath: string | null; // relative to recording/, e.g. backgrounds/photo.jpg
  blur: number; // 0..100
}

export interface ProjectConfig {
  cursor: {
    hide: boolean;
    size: number;
    rotationMode: 'velocity' | 'directional' | 'none'; // tilt / follow / off
    rotateOnXMovementRatio: number;
    baseRotation: number;
    hideNotMovingAfterMs: number | null;
    loopPositionBeforeEndMs: number | null;
    removeShakeTreshold: number;
    optimizeOriginalTypes: boolean;
    clickEffect: null | { type: 'circle' } | { type: 'ripple'; pullSize01?: number };
  };
  animations: {
    mouseMovementSpring: SpringConfig | null;
    screenMovementSpring: SpringConfig;
    motionBlurAmount: number;
  };
  zooms: { startAnimationEarly: boolean };
  output: { aspectRatio: 'auto' | number; paddingRatio01: number; avoidEmptyZoomArea: boolean };
  styles: {
    screenBorderRadius: number;
    shadow: { intensity: number; distance: number; angle: number; blur: number; isDirectional: boolean };
    background: BackgroundConfig;
  };
  camera: { hide: boolean; sizeRatio01: number; position01: Vec2; aspectRatio: number; borderRadiusRatio01: number; mirror: boolean };
  audio: { muteMicrophone: boolean; muteSystemAudio: boolean; volume: number };
}

export interface Slice {
  sourceStartMs: number;
  sourceEndMs: number;
  timeScale: number;
  hideCursor: boolean;
  disableSmoothMouseMovement: boolean;
}

export interface Project {
  path: string;
  name: string;
  recording: Recording;
  config: ProjectConfig;
  zooms: Zoom[];
  slices: Slice[];
}

export function defaultConfig(): ProjectConfig {
  return {
    cursor: {
      hide: false,
      size: 48,
      rotationMode: 'velocity',
      rotateOnXMovementRatio: 0.5,
      baseRotation: 0,
      hideNotMovingAfterMs: null,
      loopPositionBeforeEndMs: null,
      removeShakeTreshold: 500,
      optimizeOriginalTypes: true,
      clickEffect: null,
    },
    animations: {
      mouseMovementSpring: { stiffness: 125, damping: 12, mass: 1.5, clamp: true, precision: 0.002 },
      screenMovementSpring: { stiffness: 125, damping: 12, mass: 1.5, clamp: true, precision: 0.002 },
      motionBlurAmount: 1,
    },
    zooms: { startAnimationEarly: false },
    output: { aspectRatio: 'auto', paddingRatio01: 0.1, avoidEmptyZoomArea: false },
    styles: {
      screenBorderRadius: 16,
      shadow: { intensity: 0.3, distance: 25, angle: 45, blur: 20, isDirectional: true },
      background: {
        type: 'gradient',
        color: '#4776e6',
        gradient: {
          start: { x: 0, y: 0 },
          end: { x: 1, y: 1 },
          stops: [
            { color: '#4776e6', at: 0 },
            { color: '#8e54e9', at: 1 },
          ],
        },
        imagePath: null,
        blur: 0,
      },
    },
    camera: { hide: false, sizeRatio01: 0.5, position01: { x: 1, y: 1 }, aspectRatio: 1, borderRadiusRatio01: 0.15, mirror: false },
    audio: { muteMicrophone: false, muteSystemAudio: false, volume: 1 },
  };
}

export function defaultSlices(rec: Recording): Slice[] {
  return [{ sourceStartMs: 0, sourceEndMs: rec.durationMs, timeScale: 1, hideCursor: false, disableSmoothMouseMovement: false }];
}
