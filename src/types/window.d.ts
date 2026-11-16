// The preload script exposes the main-process API as window.recorder.
import type { RecorderApi } from '../shared/ipc';

declare global {
  interface Window {
    recorder: RecorderApi;
  }
}
export {};
