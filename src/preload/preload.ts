// Exposes the typed RecorderApi to the page. Runs with context isolation; only these calls cross
// the boundary.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RecorderApi, type RecorderStatus } from '../shared/ipc';

const api: RecorderApi = {
  platform: process.platform,
  openProjectDialog: () => ipcRenderer.invoke(IPC.openProjectDialog),
  openProject: (p) => ipcRenderer.invoke(IPC.openProject, p),
  saveProject: (p) => ipcRenderer.invoke(IPC.saveProject, p),
  listDisplays: () => ipcRenderer.invoke(IPC.listDisplays),
  startRecording: (o) => ipcRenderer.invoke(IPC.startRecording, o),
  stopRecording: () => ipcRenderer.invoke(IPC.stopRecording),
  saveMediaTrack: (b, f, d, info) => ipcRenderer.invoke(IPC.saveMediaTrack, b, f, d, info),
  chooseExportPath: (n) => ipcRenderer.invoke(IPC.chooseExportPath, n),
  exportOpen: (p) => ipcRenderer.invoke(IPC.exportOpen, p),
  exportWrite: (h, pos, d) => ipcRenderer.invoke(IPC.exportWrite, h, pos, d),
  exportClose: (h, discard) => ipcRenderer.invoke(IPC.exportClose, h, discard),
  revealFile: (p) => ipcRenderer.invoke(IPC.revealFile, p),
  saveHoverChanges: (b, times) => ipcRenderer.invoke(IPC.saveHoverChanges, b, times),
  chooseBackgroundImage: (b) => ipcRenderer.invoke(IPC.chooseBackgroundImage, b),
  onRecorderStatus: (cb) => {
    const listener = (_e: unknown, s: RecorderStatus) => cb(s);
    ipcRenderer.on(IPC.recorderStatus, listener);
    return () => ipcRenderer.removeListener(IPC.recorderStatus, listener);
  },
  onSelfTest: (cb) => {
    ipcRenderer.on(IPC.selfTest, (_e, job: string) => cb(job));
  },
  reportSelfTest: (r) => ipcRenderer.invoke(IPC.selfTestResult, r),
};

contextBridge.exposeInMainWorld('recorder', api);
