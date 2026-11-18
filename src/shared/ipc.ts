// Contract between the main process and the renderer. The preload script exposes exactly this
// API on window.recorder; nothing else from Node is reachable from the page.

import type { Project } from '../core/project/model';
import type { FaceSample } from '../core/camera/face-track';

export interface OpenedProject {
  project: Project;
  hoverChangeTimes: number[];
  // false when no hover data exists yet (the editor then analyses the video)
  hasHoverData: boolean;
  // media:// URL prefix for files inside <bundle>/recording/
  mediaBase: string;
  // Webcam face positions, or null until the face tracker has run.
  faceTrack: FaceSample[] | null;
}

export interface RecorderStatus {
  state: 'idle' | 'recording' | 'stopping' | 'unsupported';
  message?: string;
  bundlePath?: string;
}

export interface MediaTrackInfo {
  kind: 'microphone' | 'systemAudio' | 'webcam';
  unixStartMs: number;
  durationMs: number;
}

export interface DisplayInfo {
  id: string;
  name: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export interface RecorderApi {
  platform: NodeJS.Platform;
  openProjectDialog(): Promise<OpenedProject | null>;
  openProject(bundlePath: string): Promise<OpenedProject>;
  saveProject(project: Project): Promise<void>;
  listDisplays(): Promise<DisplayInfo[]>;
  startRecording(opts: { displayId: string; microphone: boolean; systemAudio: boolean }): Promise<RecorderStatus>;
  // Resolves once the native recorder has finished writing. bundle is null when nothing usable was
  // written; error carries the exact cause either way.
  stopRecording(): Promise<{ bundle: string | null; error?: string } | null>;
  saveMediaTrack(bundlePath: string, fileName: string, data: ArrayBuffer, info: MediaTrackInfo): Promise<void>;
  chooseExportPath(defaultName: string): Promise<string | null>;
  exportOpen(filePath: string): Promise<number>; // returns a handle
  exportWrite(handle: number, position: number, data: ArrayBuffer): Promise<void>;
  exportClose(handle: number, discard?: boolean): Promise<void>;
  revealFile(filePath: string): Promise<void>;
  // Hover-change times computed by this app's detector, cached in the bundle.
  saveHoverChanges(bundlePath: string, timesMs: number[]): Promise<void>;
  saveFaceTrack(bundlePath: string, samples: FaceSample[]): Promise<void>;
  // Lets the user pick an image, copies it into recording/backgrounds/ and returns that relative path.
  chooseBackgroundImage(bundlePath: string): Promise<string | null>;
  // Copies a .cube colour LUT into the bundle; returns its path relative to recording/.
  chooseCameraLut(bundlePath: string): Promise<string | null>;
  onRecorderStatus(cb: (s: RecorderStatus) => void): () => void;
  // Test harness only (see main.ts runSelfTestIfRequested).
  onSelfTest(cb: (jobJson: string) => void): void;
  reportSelfTest(result: unknown): Promise<void>;
}

export const IPC = {
  openProjectDialog: 'project:open-dialog',
  openProject: 'project:open',
  saveProject: 'project:save',
  listDisplays: 'recorder:list-displays',
  startRecording: 'recorder:start',
  stopRecording: 'recorder:stop',
  saveMediaTrack: 'recorder:save-media-track',
  recorderStatus: 'recorder:status',
  chooseExportPath: 'export:choose-path',
  exportOpen: 'export:open',
  exportWrite: 'export:write',
  exportClose: 'export:close',
  revealFile: 'shell:reveal',
  saveHoverChanges: 'project:save-hover',
  saveFaceTrack: 'project:save-face-track',
  chooseBackgroundImage: 'project:choose-background',
  chooseCameraLut: 'editor:choose-camera-lut',
  selfTest: 'selftest:run',
  selfTestResult: 'selftest:result',
} as const;
