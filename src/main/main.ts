// Electron main process: window, the media:// protocol (read-only, scoped to opened projects)
// and the IPC handlers declared in shared/ipc.ts.

import { BrowserWindow, app, desktopCapturer, dialog, ipcMain, net, protocol, screen, session, shell } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProject, readReferenceHoverTimes, saveProject } from '../node/bundle';
import { addAudioTrack } from '../node/recording-writer';
import type { Project } from '../core/project/model';
import { IPC, type AudioTrackInfo, type DisplayInfo, type OpenedProject, type RecorderStatus } from '../shared/ipc';
import { NativeRecorder, helperPath } from './native-recorder';

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Recording folders the page may read through media://. Only folders the user opened.
const allowedRoots = new Map<string, string>(); // id -> absolute recording dir
let window: BrowserWindow | null = null;
const recorder = new NativeRecorder();
let recordingBundle: string | null = null;
let lastRecordedBundle: string | null = null;
const exportFiles = new Map<number, number>(); // handle -> fd
let nextHandle = 1;

function projectsRoot(): string {
  const dir = path.join(app.getPath('videos'), 'Recorder');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function open(bundlePath: string): OpenedProject {
  const project = openProject(bundlePath);
  // Lowercase hex, because standard-scheme hosts are lowercased by the URL parser.
  const id = createHash('sha1').update(bundlePath).digest('hex');
  allowedRoots.set(id, path.join(bundlePath, 'recording'));
  const hoverChangeTimes = readReferenceHoverTimes(bundlePath, project.recording.sessions.map((s) => s.recordingStartMs));
  app.addRecentDocument(bundlePath);
  return { project, hoverChangeTimes, mediaBase: `media://${id}/` };
}

function sendStatus(s: RecorderStatus): void {
  window?.webContents.send(IPC.recorderStatus, s);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#16161a',
    title: 'Recorder',
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.loadFile(path.join(__dirname, '../renderer/index.html'));
  window.on('closed', () => (window = null));
}

function registerMediaProtocol(): void {
  protocol.handle('media', (req) => {
    const url = new URL(req.url);
    const root = allowedRoots.get(url.hostname);
    if (!root) return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(abs).toString(), { headers: req.headers });
  });
}

function registerIpc(): void {
  ipcMain.handle(IPC.openProjectDialog, async () => {
    const r = await dialog.showOpenDialog(window!, {
      title: 'Open recording',
      defaultPath: projectsRoot(),
      properties: ['openDirectory'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return open(r.filePaths[0]);
  });
  ipcMain.handle(IPC.openProject, (_e, p: string) => open(p));
  ipcMain.handle(IPC.saveProject, (_e, p: Project) => saveProject(p));

  ipcMain.handle(IPC.listDisplays, (): DisplayInfo[] =>
    screen.getAllDisplays().map((d, i) => ({ id: String(i), name: `Display ${i + 1} (${d.size.width}×${d.size.height})`, bounds: d.bounds, scaleFactor: d.scaleFactor })),
  );

  ipcMain.handle(IPC.startRecording, async (_e, o: { displayId: string }): Promise<RecorderStatus> => {
    const exe = helperPath();
    if (!exe) return { state: 'unsupported', message: 'Recording is available in the Windows build only.' };
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const bundle = path.join(projectsRoot(), `Recording ${stamp}.recording`);
    recordingBundle = bundle;
    try {
      await recorder.start(exe, bundle, Number(o.displayId) || 0, (ev) => {
        if (ev.event === 'error') sendStatus({ state: 'idle', message: ev.message });
      });
      const s: RecorderStatus = { state: 'recording', bundlePath: bundle };
      sendStatus(s);
      return s;
    } catch (err) {
      recordingBundle = null;
      return { state: 'idle', message: (err as Error).message };
    }
  });

  ipcMain.handle(IPC.stopRecording, async () => {
    if (!recordingBundle) return null;
    sendStatus({ state: 'stopping' });
    const ev = await recorder.stop();
    const bundle = recordingBundle;
    recordingBundle = null;
    lastRecordedBundle = bundle;
    sendStatus({ state: 'idle', message: ev.event === 'error' ? ev.message : undefined });
    if (!fs.existsSync(path.join(bundle, 'recording', 'metadata.json'))) return null;
    return bundle;
  });

  ipcMain.handle(IPC.saveAudioTrack, (_e, bundle: string, fileName: string, data: ArrayBuffer, info: AudioTrackInfo) => {
    // Only into a bundle this session created or opened.
    const recDir = path.join(bundle, 'recording');
    if (![...allowedRoots.values()].includes(recDir) && bundle !== lastRecordedBundle) throw new Error('Unknown recording');
    const safe = path.basename(fileName);
    fs.writeFileSync(path.join(recDir, safe), Buffer.from(data));
    addAudioTrack(recDir, { ...info, fileName: safe });
  });

  ipcMain.handle(IPC.chooseExportPath, async (_e, name: string) => {
    const r = await dialog.showSaveDialog(window!, { defaultPath: path.join(app.getPath('videos'), name), filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    return r.canceled ? null : r.filePath ?? null;
  });
  ipcMain.handle(IPC.exportOpen, (_e, p: string) => {
    const h = nextHandle++;
    exportFiles.set(h, fs.openSync(p, 'w'));
    return h;
  });
  ipcMain.handle(IPC.exportWrite, (_e, h: number, pos: number, data: ArrayBuffer) => {
    const fd = exportFiles.get(h);
    if (fd === undefined) throw new Error('Export file is not open');
    fs.writeSync(fd, Buffer.from(data), 0, data.byteLength, pos);
  });
  ipcMain.handle(IPC.exportClose, (_e, h: number) => {
    const fd = exportFiles.get(h);
    if (fd !== undefined) fs.closeSync(fd);
    exportFiles.delete(h);
  });
  ipcMain.handle(IPC.revealFile, (_e, p: string) => shell.showItemInFolder(p));
}

// getDisplayMedia from the page is only used to capture system audio (Windows loopback).
function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const [source] = await desktopCapturer.getSources({ types: ['screen'] });
    cb(source ? { video: source, audio: 'loopback' } : {});
  });
}

// Test harness: RECORDER_SELFTEST='{"bundle": "...", "out": "...", "fps": 60, "height": 1080}' opens a
// project, renders preview frames and exports it, then writes <out>.json with the result and quits.
function runSelfTestIfRequested(): void {
  const raw = process.env.RECORDER_SELFTEST;
  if (!raw || !window) return;
  const job = JSON.parse(raw) as { bundle: string; out: string; screenshot?: string };
  ipcMain.handle(IPC.selfTestResult, async (_e, result: unknown) => {
    if (job.screenshot && window) fs.writeFileSync(job.screenshot, (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(job.out + '.json', JSON.stringify(result, null, 2));
    app.quit();
  });
  window.webContents.once('did-finish-load', () => window?.webContents.send(IPC.selfTest, raw));
}

app.whenReady().then(() => {
  registerMediaProtocol();
  registerIpc();
  registerDisplayMediaHandler();
  createWindow();
  runSelfTestIfRequested();
});

app.on('window-all-closed', () => {
  if (recorder.isRunning) void recorder.stop();
  app.quit();
});
