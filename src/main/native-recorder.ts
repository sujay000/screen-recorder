// Controls the native screen recorder helper (Windows: recorder.exe, see native/win-recorder).
// Protocol: the helper is started with arguments, prints one JSON object per line on stdout
// ({"event": "started" | "stopped" | "error", ...}) and stops when it reads "stop" on stdin.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

export interface HelperEvent {
  event: 'started' | 'stopped' | 'error' | 'log';
  message?: string;
  unixStartMs?: number;
}

export function helperPath(): string | null {
  if (process.platform !== 'win32') return null;
  const base = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(app.getAppPath(), 'native', 'bin');
  const exe = path.join(base, 'recorder.exe');
  return fs.existsSync(exe) ? exe : null;
}

export class NativeRecorder {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped: Promise<HelperEvent> | null = null;

  get isRunning(): boolean {
    return this.child !== null;
  }

  // `at` is a physical screen point inside the display to record.
  start(exe: string, bundlePath: string, at: { x: number; y: number }, onEvent: (e: HelperEvent) => void): Promise<HelperEvent> {
    if (this.child) throw new Error('Already recording');
    const outDir = path.join(bundlePath, 'recording');
    fs.mkdirSync(outDir, { recursive: true });
    const child = spawn(exe, ['record', '--out', outDir, '--at', `${Math.round(at.x)},${Math.round(at.y)}`], { windowsHide: true });
    this.child = child;
    let buffer = '';
    let resolveStarted!: (e: HelperEvent) => void;
    let rejectStarted!: (e: Error) => void;
    const started = new Promise<HelperEvent>((res, rej) => {
      resolveStarted = res;
      rejectStarted = rej;
    });
    let resolveStopped!: (e: HelperEvent) => void;
    this.stopped = new Promise<HelperEvent>((res) => (resolveStopped = res));
    let lastError: string | null = null;
    // Spawn failures (missing exe, blocked by antivirus) and a closed stdin must not crash the app.
    child.on('error', (err) => {
      lastError = `Could not run the recorder: ${err.message}`;
      onEvent({ event: 'error', message: lastError });
      rejectStarted(new Error(lastError));
      this.child = null;
      resolveStopped({ event: 'error', message: lastError });
    });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev: HelperEvent;
        try {
          ev = JSON.parse(line) as HelperEvent;
        } catch {
          ev = { event: 'log', message: line };
        }
        onEvent(ev);
        if (ev.event === 'error') lastError = ev.message ?? 'Recorder failed';
        if (ev.event === 'started') resolveStarted(ev);
        if (ev.event === 'error') rejectStarted(new Error(ev.message ?? 'Recorder failed'));
        if (ev.event === 'stopped') resolveStopped(ev);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => onEvent({ event: 'log', message: d.trim() }));
    child.on('exit', (code) => {
      this.child = null;
      const ev: HelperEvent = code === 0 ? { event: 'stopped' } : { event: 'error', message: lastError ?? `Recorder exited with code ${code}` };
      rejectStarted(new Error(ev.message ?? 'Recorder exited before starting'));
      resolveStopped(ev);
    });
    return started;
  }

  async stop(): Promise<HelperEvent> {
    if (!this.child || !this.stopped) return this.stopped ?? { event: 'stopped' };
    this.child.stdin.write('stop\n');
    return this.stopped;
  }
}
