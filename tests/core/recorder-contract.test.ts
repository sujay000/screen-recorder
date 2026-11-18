// The Windows recorder (native/win-recorder/src/bundle.rs) and the editor's loader must agree on
// the bundle format. `cargo test` in native/win-recorder writes a bundle with the real writer;
// this test loads it with the real loader.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRecording } from '../../src/core/project/loader';
import { generateAutoZooms } from '../../src/core/camera/zoom';
import { bundleReader } from '../../src/node/bundle';

const dir = path.resolve(__dirname, '../../native/win-recorder/target/contract-bundle/recording');

describe.skipIf(!fs.existsSync(dir))('Windows recorder bundle contract', () => {
  it('loads sessions, events, cursors and the video track', () => {
    const rec = loadRecording(bundleReader(dir));
    expect(rec.durationMs).toBe(8000);
    expect(rec.sessions[0]).toMatchObject({ processTimeStartMs: 1000, recordingStartMs: 0 });
    expect(rec.displayBounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(rec.recordingScale).toBe(0.5);
    expect(rec.screenVideo).toEqual([{ file: 'channel-1-display-0.mp4', sessionIndex: 0, startOffsetMs: 0 }]);
    // processTime -> recording time, moves and clicks merged in time order.
    expect(rec.mouseEvents.map((e) => [e.type, e.recordingTimeMs])).toEqual([
      ['mouseMoved', 10],
      ['mouseMoved', 500],
      ['mouseDown', 600],
      ['mouseUp', 680],
      ['mouseMoved', 1600],
    ]);
    expect(rec.mouseclicks[0]).toMatchObject({ x: 400, y: 300, cursorId: 'arrow', button: 'left' });
    expect(rec.keystrokes).toEqual([{ type: 'keyDown', character: undefined, keyCode: 72, isARepeat: false, activeModifiers: [], recordingTimeMs: 1000 }]);
    expect(rec.cursors[0]).toMatchObject({ id: 'arrow', hotSpot: { x: 0, y: 0 }, standardSize: { width: 32, height: 32 } });
  });

  it('produces an auto zoom from the recorded click', () => {
    const rec = loadRecording(bundleReader(dir));
    expect(generateAutoZooms(rec).map((z) => [z.sourceStartMs, z.sourceEndMs])).toEqual([[300, 3180]]);
  });
});
