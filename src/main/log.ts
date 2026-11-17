// Main-process log: <userData>/logs/main.log (plus the console). Each recording also gets its own
// recorder.log with everything the native helper printed.

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

let file: string | null = null;

function logFile(): string {
  if (!file) {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
  }
  return file;
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`;
  (level === 'error' ? console.error : console.log)(line.trimEnd());
  try {
    fs.appendFileSync(logFile(), line);
  } catch {
    // Logging must never take the app down.
  }
}

export function appendTo(filePath: string, line: string): void {
  try {
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignore
  }
}

export function mainLogPath(): string {
  return logFile();
}
