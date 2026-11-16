// Builds a bundle in the native Windows recorder's format (single mp4, metadata as written by
// native/win-recorder/src/bundle.rs) from a reference recording, to test the editor on that
// format without a Windows machine. Usage: node make-windows-fixture.mjs <source.screenstudio> <out.recording>
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [src, out] = process.argv.slice(2);
const srcRec = join(src, 'recording');
const rec = join(out, 'recording');
mkdirSync(join(rec, 'cursors'), { recursive: true });
const meta = JSON.parse(readFileSync(join(srcRec, 'metadata.json'), 'utf8'));
const display = meta.recorders.find((r) => r.type === 'display').sessions[0];
const input = meta.recorders.find((r) => r.type === 'input').sessions[0];
const s = meta.sessions[0];

// One H.264 mp4 starting at 0, like Media Foundation writes it.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(srcRec, display.outputFilename), '-c', 'copy', '-movflags', '+faststart', join(rec, 'channel-1-display-0.mp4')]);

// Events relative to the recorded area, with the Windows recorder's key record shape.
const bx = display.bounds.x;
const by = display.bounds.y;
const shift = (e) => ({ ...e, x: e.x - bx, y: e.y - by });
writeFileSync(join(rec, 'mousemoves-0.json'), JSON.stringify(JSON.parse(readFileSync(join(srcRec, input.mouseMovesFilename), 'utf8')).map(shift)));
writeFileSync(join(rec, 'mouseclicks-0.json'), JSON.stringify(JSON.parse(readFileSync(join(srcRec, input.mouseClicksFilename), 'utf8')).map(shift)));
const keys = JSON.parse(readFileSync(join(srcRec, input.keyStrokesFilename), 'utf8')).map((k) => ({ type: k.type, keyCode: 65, isARepeat: !!k.isARepeat, processTimeMs: k.processTimeMs, unixTimeMs: k.unixTimeMs, activeModifiers: [] }));
writeFileSync(join(rec, 'keystrokes-0.json'), JSON.stringify(keys));
cpSync(join(srcRec, 'cursors.json'), join(rec, 'cursors.json'));
cpSync(join(srcRec, 'cursors'), join(rec, 'cursors'), { recursive: true });

const session = { durationMs: s.processTimeEndMs - s.processTimeStartMs, processTimeStartMs: s.processTimeStartMs, processTimeEndMs: s.processTimeEndMs, unixStartMs: s.unixStartMs, unixEndMs: s.unixEndMs };
writeFileSync(
  join(rec, 'metadata.json'),
  JSON.stringify(
    {
      polyrecorderVersion: 'recorder-win fixture',
      recorders: [
        { id: 'channel-0-cursor', type: 'cursor', cursorImagesFolder: 'cursors', cursorsInfoFile: 'cursors.json', configuration: {} },
        { id: 'channel-0-input', type: 'input', configuration: { captureKeyStrokes: true }, sessions: [{ ...session, mouseMovesFilename: 'mousemoves-0.json', mouseClicksFilename: 'mouseclicks-0.json', keyStrokesFilename: 'keystrokes-0.json' }] },
        { id: 'channel-1-display', type: 'display', configuration: {}, sessions: [{ ...session, bounds: { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }, displayRefreshRate: 60, outputFilename: 'channel-1-display-0.mp4', recordingScale: display.recordingScale }] },
      ],
      sessions: [session],
      state: 'complete',
    },
    null,
    2,
  ),
);
console.log(`wrote ${out}`);
