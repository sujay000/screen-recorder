// Electron main process: window, the media:// protocol (read-only, scoped to opened projects)
// and the IPC handlers declared in shared/ipc.ts.

import { BrowserWindow, app, desktopCapturer, dialog, ipcMain, net, protocol, screen, session, shell } from 'electron';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openProject, readOwnHoverTimes, readReferenceHoverTimes, saveOwnHoverTimes, saveProject } from '../node/bundle';
import { addMediaTrack } from '../node/recording-writer';
import type { Project } from '../core/project/model';
import { IPC, type MediaTrackInfo, type DisplayInfo, type OpenedProject, type RecorderStatus } from '../shared/ipc';
import { appendTo, log, mainLogPath } from './log';
import { NativeRecorder, helperPath } from './native-recorder';

// Software WebGPU for machines without a GPU (CI, VMs). Opt-in, because it is slow.
if (process.env.RECORDER_SOFTWARE_GPU === '1') app.commandLine.appendSwitch('enable-unsafe-swiftshader');

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Recording folders the page may read through media://. Only folders the user opened.
const allowedRoots = new Map<string, string>(); // id -> absolute recording dir
let window: BrowserWindow | null = null;
const recorder = new NativeRecorder();
let recordingBundle: string | null = null;
let lastRecordedBundle: string | null = null;
const exportFiles = new Map<number, number>(); // handle -> fd
const exportPaths = new Map<number, string>();
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
  // Prefer the reference app's analysis when the bundle came from it, else our own cached one.
  const reference = readReferenceHoverTimes(bundlePath, project.recording.sessions.map((s) => s.recordingStartMs));
  const own = reference.length ? null : readOwnHoverTimes(bundlePath);
  const hasHoverData = reference.length > 0 || own !== null || fs.existsSync(path.join(bundlePath, 'cache', 'cursor-hover_v3-all'));
  app.addRecentDocument(bundlePath);
  return { project, hoverChangeTimes: reference.length ? reference : own ?? [], hasHoverData, mediaBase: `media://${id}/` };
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
  // A crashed or killed page must leave a trace (reason + exit code) for debugging.
  window.webContents.on('render-process-gone', (_e, d) => log('error', `Renderer gone: ${d.reason} (exit code ${d.exitCode})`));
  window.webContents.on('console-message', (_e, level, message) => level >= 2 && log(level >= 3 ? 'error' : 'warn', `Page: ${message}`));
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
    // Keep our own window out of the recording from its first frame (Windows: WDA_EXCLUDEFROMCAPTURE).
    window?.setContentProtection(true);
    try {
      const displays = screen.getAllDisplays();
      const d = displays[Number(o.displayId)] ?? screen.getPrimaryDisplay();
      const centre = { x: d.bounds.x + d.bounds.width / 2, y: d.bounds.y + d.bounds.height / 2 };
      // Electron bounds are DIPs; the recorder works in physical pixels.
      const at = process.platform === 'win32' ? screen.dipToScreenPoint(centre) : centre;
      const recLog = path.join(bundle, 'recording', 'recorder.log');
      log('info', `Recording display ${o.displayId} at physical point ${Math.round(at.x)},${Math.round(at.y)} into ${bundle}`);
      await recorder.start(exe, bundle, at, (ev) => {
        appendTo(recLog, `${ev.event}${ev.message ? `: ${ev.message}` : ''}`);
        if (ev.event === 'error') {
          log('error', `Recorder: ${ev.message}`);
          sendStatus({ state: 'idle', message: `Recorder error: ${ev.message} (log: ${recLog})` });
        }
      });
      const s: RecorderStatus = { state: 'recording', bundlePath: bundle };
      sendStatus(s);
      return s;
    } catch (err) {
      recordingBundle = null;
      window?.setContentProtection(false);
      log('error', `Recording did not start: ${(err as Error).message}`);
      return { state: 'idle', message: `Recording did not start: ${(err as Error).message}` };
    }
  });

  ipcMain.handle(IPC.stopRecording, async () => {
    if (!recordingBundle) return null;
    sendStatus({ state: 'stopping' });
    const ev = await recorder.stop();
    window?.setContentProtection(false);
    const bundle = recordingBundle;
    recordingBundle = null;
    lastRecordedBundle = bundle;
    sendStatus({ state: 'idle' });
    const recLog = path.join(bundle, 'recording', 'recorder.log');
    if (!fs.existsSync(path.join(bundle, 'recording', 'metadata.json'))) {
      const message = `${ev.event === 'error' ? ev.message : 'The recorder stopped without writing metadata.json'}. Recorder log: ${recLog}`;
      log('error', `Recording failed: ${message}`);
      return { bundle: null, error: message };
    }
    if (ev.event === 'error') log('warn', `Recorder reported an error but wrote the bundle: ${ev.message}`);
    return { bundle, error: ev.event === 'error' ? ev.message : undefined };
  });

  ipcMain.handle(IPC.saveMediaTrack, (_e, bundle: string, fileName: string, data: ArrayBuffer, info: MediaTrackInfo) => {
    // Only into a bundle this session created or opened.
    const recDir = path.join(bundle, 'recording');
    if (![...allowedRoots.values()].includes(recDir) && bundle !== lastRecordedBundle) throw new Error('Unknown recording');
    const safe = path.basename(fileName);
    fs.writeFileSync(path.join(recDir, safe), Buffer.from(data));
    addMediaTrack(recDir, { ...info, fileName: safe });
  });

  ipcMain.handle(IPC.chooseExportPath, async (_e, name: string) => {
    const filters = name.endsWith('.gif') ? [{ name: 'GIF animation', extensions: ['gif'] }] : [{ name: 'MP4 video', extensions: ['mp4'] }];
    const r = await dialog.showSaveDialog(window!, { defaultPath: path.join(app.getPath('videos'), name), filters });
    return r.canceled ? null : r.filePath ?? null;
  });
  ipcMain.handle(IPC.exportOpen, (_e, p: string) => {
    const h = nextHandle++;
    exportFiles.set(h, fs.openSync(p, 'w'));
    exportPaths.set(h, p);
    return h;
  });
  ipcMain.handle(IPC.exportWrite, (_e, h: number, pos: number, data: ArrayBuffer) => {
    const fd = exportFiles.get(h);
    if (fd === undefined) throw new Error('Export file is not open');
    fs.writeSync(fd, Buffer.from(data), 0, data.byteLength, pos);
  });
  ipcMain.handle(IPC.exportClose, (_e, h: number, discard?: boolean) => {
    const fd = exportFiles.get(h);
    if (fd !== undefined) fs.closeSync(fd);
    const p = exportPaths.get(h);
    exportFiles.delete(h);
    exportPaths.delete(h);
    // A cancelled or failed export would leave an unplayable file behind.
    if (discard && p) fs.rmSync(p, { force: true });
  });
  ipcMain.handle(IPC.revealFile, (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle(IPC.chooseBackgroundImage, async (_e, bundle: string) => {
    const recDir = path.join(bundle, 'recording');
    if (![...allowedRoots.values()].includes(recDir)) throw new Error(`Unknown recording ${bundle}`);
    const r = await dialog.showOpenDialog(window!, { title: 'Background image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = path.join(recDir, 'backgrounds');
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(r.filePaths[0]);
    fs.copyFileSync(r.filePaths[0], path.join(dir, name));
    return `backgrounds/${name}`;
  });
  ipcMain.handle(IPC.saveHoverChanges, (_e, bundle: string, times: number[]) => {
    if (![...allowedRoots.values()].includes(path.join(bundle, 'recording'))) throw new Error(`Unknown recording ${bundle}`);
    saveOwnHoverTimes(bundle, times);
    log('info', `Hover analysis: ${times.length} changes saved for ${bundle}`);
  });
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

process.on('uncaughtException', (err) => log('error', `Uncaught in main: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => log('error', `Unhandled rejection in main: ${(err as Error)?.stack ?? String(err)}`));

app.whenReady().then(() => {
  log('info', `Recorder ${app.getVersion()} on ${process.platform} ${process.arch}, Electron ${process.versions.electron}; log ${mainLogPath()}`);
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
