// Contract between the main process and the renderer. The preload script exposes exactly this
// API on window.recorder; nothing else from Node is reachable from the page.

import type { Project } from '../core/project/model';

export interface OpenedProject {
  project: Project;
  hoverChangeTimes: number[];
  // media:// URL prefix for files inside <bundle>/recording/
  mediaBase: string;
}

export interface RecorderStatus {
  state: 'idle' | 'recording' | 'stopping' | 'unsupported';
  message?: string;
  bundlePath?: string;
}

export interface AudioTrackInfo {
  kind: 'microphone' | 'systemAudio';
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
  // Resolves with the new bundle path once the native recorder has finished writing.
  stopRecording(): Promise<string | null>;
  saveAudioTrack(bundlePath: string, fileName: string, data: ArrayBuffer, info: AudioTrackInfo): Promise<void>;
  chooseExportPath(defaultName: string): Promise<string | null>;
  exportOpen(filePath: string): Promise<number>; // returns a handle
  exportWrite(handle: number, position: number, data: ArrayBuffer): Promise<void>;
  exportClose(handle: number): Promise<void>;
  revealFile(filePath: string): Promise<void>;
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
  saveAudioTrack: 'recorder:save-audio',
  recorderStatus: 'recorder:status',
  chooseExportPath: 'export:choose-path',
  exportOpen: 'export:open',
  exportWrite: 'export:write',
  exportClose: 'export:close',
  revealFile: 'shell:reveal',
  selfTest: 'selftest:run',
  selfTestResult: 'selftest:result',
} as const;
