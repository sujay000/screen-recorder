import { describe, expect, it } from 'vitest';
import { HoverDetector, type Patch } from '../../src/core/cursor/hover-detector';
import type { MouseEvent } from '../../src/core/project/model';

const W = 400;
const H = 300;
const size = { width: W, height: H };

// Full-frame patch: background stripes (so scrolling is detectable), optional highlight box.
function frame(t: number, opts: { highlight?: boolean; shift?: number } = {}): Patch {
  const y = new Uint8Array(W * H);
  const cb = new Uint8Array(W * H).fill(128);
  const cr = new Uint8Array(W * H).fill(128);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      y[k] = 40 + (((j + (opts.shift ?? 0)) >> 3) % 2) * 60 + ((i >> 4) % 2) * 20;
      if (opts.highlight && i >= 250 && i < 350 && j >= 100 && j < 160) {
        y[k] = Math.min(255, y[k] + 50);
        cb[k] = 140;
      }
    }
  }
  return { timeMs: t, x0: 0, y0: 0, w: W, h: H, y, cb, cr };
}

// Cursor glides right at 0.5 pt/ms through the box centre (ppp = 1).
const moves: MouseEvent[] = Array.from({ length: 80 }, (_, i) => ({ type: 'mouseMoved', x: 100 + i * 4, y: 130, cursorId: 'arrow', recordingTimeMs: i * 8 }));

function run(changeAt: number, kind: 'highlight' | 'scroll', clicks: MouseEvent[] = [], m = moves): number[] {
  const d = new HoverDetector(m, clicks, 1, size);
  for (let t = 0; t <= 640; t += 16) {
    if (t < changeAt) d.push(frame(t));
    else d.push(kind === 'highlight' ? frame(t, { highlight: true }) : frame(t, { shift: 8 }));
  }
  return d.changes;
}

describe('hover detector', () => {
  it('detects a highlight appearing under the moving cursor', () => {
    const c = run(400, 'highlight');
    // One detection per change, at the frame where it appears.
    expect(c).toEqual([400]);
  });
  it('ignores a scroll', () => {
    expect(run(400, 'scroll')).toEqual([]);
  });
  it('ignores changes caused by a click', () => {
    const click: MouseEvent = { type: 'mouseDown', x: 260, y: 130, cursorId: 'arrow', recordingTimeMs: 390 };
    expect(run(400, 'highlight', [click])).toEqual([]);
  });
  it('ignores changes when the pointer is not moving', () => {
    const still = moves.map((e) => ({ ...e, x: 200 }));
    expect(run(400, 'highlight', [], still)).toEqual([]);
  });
});
