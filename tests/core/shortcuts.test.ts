import { describe, expect, it } from 'vitest';
import { findShortcutPresses, keyCapsOf, ShortcutOverlay, shortcutOf } from '../../src/core/keyboard/shortcuts';
import type { KeyEvent } from '../../src/core/project/model';
import { openProject } from '../../src/node/bundle';
import { referenceProjects } from '../fixtures/reference';

const key = (type: 'keyDown' | 'keyUp', t: number, k: { character?: string; keyCode?: number }, mods: string[] = []): KeyEvent => ({ type, recordingTimeMs: t, isARepeat: false, activeModifiers: mods, ...k });

describe('shortcut keys', () => {
  it('maps macOS characters and Windows key codes', () => {
    expect(shortcutOf(key('keyDown', 0, { character: ' ' }, ['option']))).toEqual(['Alt', ' ']);
    expect(shortcutOf(key('keyDown', 0, { character: 'c' }, ['command']))).toEqual(['Meta', 'c']);
    expect(shortcutOf(key('keyDown', 0, { keyCode: 0x43 }, ['control']))).toEqual(['Ctrl', 'c']);
    expect(shortcutOf(key('keyDown', 0, { keyCode: 0x11 }, ['control']))).toBeNull(); // Ctrl alone
    expect(keyCapsOf(['Shift', 'Meta', 'z'], 'mac').map((c) => c.label)).toEqual(['command', 'shift', 'Z']);
    expect(keyCapsOf(['Ctrl', 'c'], 'windows').map((c) => c.label)).toEqual(['ctrl', 'C']);
  });

  it('groups repeats, skips typing, holds 1.5 s after the last key', () => {
    const keys = [
      key('keyDown', 1000, { keyCode: 0x43 }, ['control']),
      key('keyUp', 1080, { keyCode: 0x43 }, ['control']),
      key('keyDown', 1500, { keyCode: 0x43 }, ['control']),
      key('keyUp', 1580, { keyCode: 0x43 }, ['control']),
      key('keyDown', 5000, { keyCode: 0x48 }), // plain "h": typing, not shown
      key('keyDown', 7000, { keyCode: 0x56 }, ['control']),
    ];
    const presses = findShortcutPresses(keys, [], false);
    expect(presses.map((p) => [p.shortcut.join('+'), p.displayStartMs, p.displayEndMs])).toEqual([
      ['Ctrl+c', 900, 3000],
      ['Ctrl+v', 6900, 8500],
    ]);
    const overlay = new ShortcutOverlay(keys, [], [{ sourceStartMs: 0, sourceEndMs: 10000, timeScale: 1, hideCursor: false, disableSmoothMouseMovement: false }], { enabled: true, showSingleLetters: false, sizeRatio: 0.1 });
    const caps = overlay.capsAt(1200, { width: 1920, height: 1080 });
    expect(caps.map((c) => c.cap.label)).toEqual(['ctrl', 'C']);
    expect(caps.every((c) => c.opacity === 1)).toBe(true);
    // Keys sit in the bottom band, inside the 5% margin.
    expect(caps[0].rect.y + caps[0].rect.height).toBeLessThanOrEqual(1080 - 1080 / 22 + 0.01);
    expect(overlay.capsAt(4000, { width: 1920, height: 1080 })).toEqual([]);
  });
});

const projects = referenceProjects();
describe.skipIf(projects.length === 0)('shortcuts in reference recordings', () => {
  it('finds option+space in the Area recording', () => {
    const p = projects.find((x) => x.includes('Area'));
    if (!p) return;
    const rec = openProject(p).recording;
    const presses = findShortcutPresses(rec.keystrokes, rec.mouseEvents, false);
    expect(presses[0].shortcut).toEqual(['Alt', ' ']);
  });
});
