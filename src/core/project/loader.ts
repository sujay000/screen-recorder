// Reads a recording bundle (same on-disk layout as the reference recorder, see
// recording-contract.md) into the Recording model.

import type { CursorInfo, KeyEvent, MediaTrack, MouseEvent, RawKeyEvent, RawMouseEvent, Recording, Session } from './model';

export interface BundleReader {
  readJson<T = unknown>(relPath: string): T | null; // null when missing
}

interface MetadataSession {
  processTimeStartMs: number;
  processTimeEndMs: number;
  durationMs?: number;
  outputFilename?: string;
  mouseMovesFilename?: string;
  mouseClicksFilename?: string;
  keyStrokesFilename?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  recordingScale?: number;
  displayRefreshRate?: number;
}

interface MetadataRecorder {
  id: string;
  type: string;
  sessions?: MetadataSession[];
  cursorsInfoFile?: string;
  configuration?: { cropRect?: { x: number; y: number; width: number; height: number } };
}

interface Metadata {
  recorders: MetadataRecorder[];
  sessions?: { processTimeStartMs: number; processTimeEndMs: number; durationMs?: number }[];
  mode?: string;
}

function track(file: string | undefined, sessionIndex: number, startOffsetMs: number): MediaTrack | null {
  if (!file) return null;
  return file.endsWith('.m3u8') ? { playlist: file, sessionIndex, startOffsetMs } : { file, sessionIndex, startOffsetMs };
}

// recordingTimeMs = processTimeMs - session.processTimeStartMs + session.recordingStartMs, sessions
// joined end to end (pauses removed).
export function loadRecording(reader: BundleReader): Recording {
  const meta = reader.readJson<Metadata>('metadata.json');
  if (!meta) throw new Error('metadata.json missing');
  const byType = (t: string) => meta.recorders.filter((r) => r.type === t);
  const input = byType('input')[0];
  const display = byType('display')[0];
  const baseSessions = meta.sessions ?? input?.sessions ?? display?.sessions ?? [];
  const sessions: Session[] = [];
  let acc = 0;
  for (const s of baseSessions) {
    const durationMs = s.processTimeEndMs - s.processTimeStartMs;
    sessions.push({ processTimeStartMs: s.processTimeStartMs, processTimeEndMs: s.processTimeEndMs, recordingStartMs: acc, durationMs });
    acc += durationMs;
  }
  const toRec = (si: number, pt: number) => pt - sessions[si].processTimeStartMs + sessions[si].recordingStartMs;

  const moves: MouseEvent[] = [];
  const clicks: MouseEvent[] = [];
  const keys: KeyEvent[] = [];
  (input?.sessions ?? []).forEach((s, si) => {
    if (si >= sessions.length) return;
    const mm = (s.mouseMovesFilename && reader.readJson<RawMouseEvent[]>(s.mouseMovesFilename)) || [];
    const mc = (s.mouseClicksFilename && reader.readJson<RawMouseEvent[]>(s.mouseClicksFilename)) || [];
    const ks = (s.keyStrokesFilename && reader.readJson<RawKeyEvent[]>(s.keyStrokesFilename)) || [];
    for (const e of mm) moves.push({ type: e.type, x: e.x, y: e.y, cursorId: e.cursorId, recordingTimeMs: toRec(si, e.processTimeMs) });
    for (const e of mc)
      clicks.push({ type: e.type, x: e.x, y: e.y, cursorId: e.cursorId, recordingTimeMs: toRec(si, e.processTimeMs), button: e.button });
    for (const e of ks) keys.push({ type: e.type, character: e.character, recordingTimeMs: toRec(si, e.processTimeMs) });
  });
  const mouseEvents = [...moves, ...clicks].sort((a, b) => a.recordingTimeMs - b.recordingTimeMs);
  keys.sort((a, b) => a.recordingTimeMs - b.recordingTimeMs);

  const cursorRec = byType('cursor')[0];
  const cursors = reader.readJson<CursorInfo[]>(cursorRec?.cursorsInfoFile ?? 'cursors.json') ?? [];
  const ds = display?.sessions?.[0];
  const crop = display?.configuration?.cropRect;
  const bounds = ds?.bounds ?? (crop ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : { x: 0, y: 0, width: 1920, height: 1080 });

  // A track session can start slightly after the recording session (devices open late).
  const tracks = (t: string) =>
    byType(t).flatMap((r) =>
      (r.sessions ?? [])
        .map((s, i) => {
          const base = sessions[i];
          const offset = base ? s.processTimeStartMs - base.processTimeStartMs + base.recordingStartMs : 0;
          return track(s.outputFilename, i, offset);
        })
        .filter((x): x is MediaTrack => !!x),
    );

  // Event coordinates are display-global points; make them relative to the recorded bounds.
  for (const e of mouseEvents) {
    e.x -= bounds.x;
    e.y -= bounds.y;
  }

  return {
    sessions,
    durationMs: acc,
    mouseEvents,
    mouseclicks: mouseEvents.filter((e) => e.type === 'mouseDown' || e.type === 'mouseUp'),
    keystrokes: keys,
    cursors,
    displayBounds: bounds,
    recordingScale: ds?.recordingScale ?? 1,
    displayRefreshRate: ds?.displayRefreshRate ?? 60,
    screenVideo: tracks('display'),
    microphone: tracks('microphone'),
    systemAudio: tracks('systemAudio'),
    webcam: tracks('webcam'),
    isExternalDeviceMode: meta.mode === 'externalDevice',
  };
}
