// Keyboard shortcut overlay (the reference's "shortcuts" captions, B39sgn5K.js:13440-14700): finds
// the shortcuts pressed in a recording, groups repeats, and lays out keycaps at the bottom of the
// stage with their fade-in/out timing.

import type { KeyEvent, MouseEvent, Slice } from '../project/model';
import { Rect } from '../geometry/rect';

// ---- Key names ------------------------------------------------------------------------------

const REPEAT_GROUP_MS = 2000; // same shortcut pressed again within this joins the press
const TYPING_GAP_MS = 1000; // Zh
const HOLD_MS = 1500; // Qh: a press stays this long after its last key down
const MODIFIER_LOOKBACK_MS = 3000; // $h
const LEAD_MS = 100; // the overlay appears this much before the key goes down
const MIN_GAP_BETWEEN_PRESSES_MS = 800;
const FADE_MS = 100;
const STAGGER_MS = 60; // each key of a combo appears this much after the previous one
const KEY_GAP_RATIO = 0.1; // eg
const APPEAR_TRAVEL_RATIO = -0.033; // tg: keys rise by this fraction of their height
const STAGE_MARGIN_RATIO = 0.05; // ng
const MODIFIER_WIDTH = 1.33; // rg
const SPACE_WIDTH = 1.66; // ig

// macOS characters for special keys (function-key private-use codes and control characters).
const MAC_CHARACTER_KEYS: Record<string, string[]> = {
  '\t': ['Tab'],
  '\n': ['Enter'],
  '\r': ['Enter'],
  '\x19': ['Shift', 'Tab'],
  '\x1b': ['Escape'],
  '\x7f': ['Backspace'],
  '\x03': ['Enter'],
  '\xa0': [' '],
  '': ['ArrowUp'],
  '': ['ArrowDown'],
  '': ['ArrowLeft'],
  '': ['ArrowRight'],
  '': ['Delete'],
  '': ['Home'],
  '': ['End'],
  '': ['PageUp'],
  '': ['PageDown'],
  '': ['PrintScreen'],
  '': ['ScrollLock'],
  '': ['Pause'],
  '': ['Insert'],
  '': ['Help'],
  '\b': ['Backspace'],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String.fromCharCode(0xf704 + i), [`F${i + 1}`]])),
};

// Windows virtual-key codes.
const VK_KEYS: Record<number, string> = {
  0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x14: 'CapsLock', 0x1b: 'Escape', 0x20: ' ',
  0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home', 0x25: 'ArrowLeft', 0x26: 'ArrowUp', 0x27: 'ArrowRight', 0x28: 'ArrowDown',
  0x2c: 'PrintScreen', 0x2d: 'Insert', 0x2e: 'Delete',
  0xba: ';', 0xbb: '=', 0xbc: ',', 0xbd: '-', 0xbe: '.', 0xbf: '/', 0xc0: '`', 0xdb: '[', 0xdc: '\\', 0xdd: ']', 0xde: "'",
};
// Shift, Ctrl, Alt, Win (both sides): shown through activeModifiers, never as the key itself.
const VK_MODIFIERS = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);

function vkName(code: number): string | null {
  if (VK_MODIFIERS.has(code)) return null;
  if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code + 32);
  if (code >= 0x70 && code <= 0x87) return `F${code - 0x6f}`;
  return VK_KEYS[code] ?? null;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const DIGITS = '0123456789'.split('');
const NAV_KEYS = ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp'];
const F_KEYS = Array.from({ length: 20 }, (_, i) => `F${i + 1}`);
const PUNCTUATION = '[ ] { } - _ = + \\ | ; : \' " , < . > / ? ` ~ ! @ # $ % ^ & * ( ) §'.split(' ');
const NAMED_KEYS = ['Enter', 'Tab', ' ', 'Backspace', 'Delete', 'Insert', 'Escape', 'Help', 'Pause', 'PrintScreen', 'ScrollLock', 'CapsLock', ...NAV_KEYS, ...F_KEYS];
const KNOWN_KEYS = new Set([...NAMED_KEYS, ...LETTERS, ...LETTERS.map((l) => l.toUpperCase()), ...DIGITS, ...PUNCTUATION]);
// Keys shown on their own (without modifiers) even when single letters are off.
const SOLO_KEYS = new Set(['§', 'CapsLock', 'Backspace', 'Delete', ...NAV_KEYS, ...F_KEYS]);

const MODIFIER_ORDER = ['Fn', 'CapsLock', 'Meta', 'Alt', 'Ctrl', 'Shift'];
const MODIFIER_OF_NAME: Record<string, string> = { command: 'Meta', option: 'Alt', shift: 'Shift', control: 'Ctrl', capsLock: 'CapsLock' };
const NAME_OF_MODIFIER: Record<string, string> = { Meta: 'command', Alt: 'option', Ctrl: 'control', Shift: 'shift', CapsLock: 'capsLock', Fn: 'function' };
const isModifier = (k: string) => MODIFIER_ORDER.includes(k);

// The keys of one key-down event, modifiers first, or null if it is not a shortcut key.
export function shortcutOf(e: KeyEvent): string[] | null {
  const keys = e.activeModifiers.map((m) => MODIFIER_OF_NAME[m]).filter((k): k is string => !!k);
  if (e.keyCode !== undefined) {
    const name = vkName(e.keyCode);
    if (name === null) return null;
    keys.push(name);
  } else if (e.character !== undefined) {
    const mapped = MAC_CHARACTER_KEYS[e.character];
    if (mapped) keys.push(...mapped);
    else if (KNOWN_KEYS.has(e.character)) keys.push(e.character);
    else if (keys.length > 0) keys.push(e.character);
  }
  return keys.length ? [...new Set(keys)] : null;
}

// ---- Presses --------------------------------------------------------------------------------

export interface ShortcutPress {
  shortcut: string[];
  events: KeyEvent[]; // key downs and their key ups, time ordered
  firstKeyDownMs: number;
  lastKeyDownMs: number;
  lastEventMs: number;
  displayStartMs: number;
  displayEndMs: number;
}

interface Candidate {
  shortcut: string[];
  event: KeyEvent;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
const keyId = (e: KeyEvent) => (e.keyCode !== undefined ? `vk${e.keyCode}` : (e.character ?? '').toLowerCase());

export function findShortcutPresses(keys: KeyEvent[], mouse: MouseEvent[], showSingleLetters: boolean): ShortcutPress[] {
  const downs: Candidate[] = [];
  for (const e of keys) {
    if (e.type === 'keyUp') continue;
    const shortcut = shortcutOf(e);
    if (shortcut) downs.push({ shortcut, event: e });
  }
  const shown = downs.filter((c, i) => {
    const next = downs[i + 1];
    // Shift followed quickly by plain keys is typing capitals, not a shortcut.
    if (next && c.event.activeModifiers.includes('shift') && next.shortcut.length === 1 && !next.event.activeModifiers.length && next.event.recordingTimeMs - c.event.recordingTimeMs < TYPING_GAP_MS) return false;
    if (!showSingleLetters && c.shortcut.length === 1) return SOLO_KEYS.has(c.shortcut[0]);
    return true;
  });

  // Repeats of the same shortcut join one press.
  const groups: { shortcut: string[]; downs: Candidate[] }[] = [];
  for (const c of shown) {
    const last = groups[groups.length - 1];
    if (!last) {
      groups.push({ shortcut: c.shortcut, downs: [c] });
      continue;
    }
    if (showSingleLetters) {
      // Plain letters typed in a row are typing: drop them.
      const first = last.downs[0];
      const typed = [first.event.character, c.event.character].every((ch) => ch !== undefined && (LETTERS.includes(ch) || DIGITS.includes(ch)));
      if (!first.event.activeModifiers.length && !c.event.activeModifiers.length && typed && c.event.recordingTimeMs - first.event.recordingTimeMs < TYPING_GAP_MS) {
        groups.pop();
        continue;
      }
    }
    const prev = last.downs[last.downs.length - 1];
    if (c.event.recordingTimeMs - prev.event.recordingTimeMs > REPEAT_GROUP_MS || !same(last.shortcut, c.shortcut)) groups.push({ shortcut: c.shortcut, downs: [c] });
    else last.downs.push(c);
  }

  // Pair each key down with its key up.
  const upOf = new Map<KeyEvent, KeyEvent>();
  const open = new Map<string, KeyEvent>();
  for (const e of keys) {
    const id = keyId(e);
    if (e.type === 'keyDown') {
      if (!e.isARepeat) open.set(id, e);
    } else {
      const d = open.get(id);
      if (d) {
        open.delete(id);
        upOf.set(d, e);
      }
    }
  }

  const timeline = [...keys, ...mouse].sort((a, b) => a.recordingTimeMs - b.recordingTimeMs);
  const presses: ShortcutPress[] = [];
  for (const g of groups) {
    const events: KeyEvent[] = [];
    for (const d of g.downs) {
      events.push(d.event);
      const up = upOf.get(d.event);
      if (up) events.push(up);
    }
    events.sort((a, b) => a.recordingTimeMs - b.recordingTimeMs);
    const keyDowns = events.filter((e) => e.type === 'keyDown');
    const prev = presses[presses.length - 1] ?? null;
    const firstKeyDownMs = keyDowns[0].recordingTimeMs;
    const p: ShortcutPress = {
      shortcut: g.shortcut,
      events,
      firstKeyDownMs,
      lastKeyDownMs: keyDowns[keyDowns.length - 1].recordingTimeMs,
      lastEventMs: events[events.length - 1].recordingTimeMs,
      displayStartMs: 0,
      displayEndMs: 0,
    };
    // Show from when the modifiers started being held (within limits), not just the last key.
    const base = firstKeyDownMs - LEAD_MS;
    let start = base;
    for (const m of g.shortcut.filter(isModifier)) start = Math.min(start, modifierHoldStartMs(timeline, m, firstKeyDownMs, prev) - LEAD_MS);
    if (prev) start = Math.max(start, prev.displayStartMs + MIN_GAP_BETWEEN_PRESSES_MS);
    p.displayStartMs = Math.min(base, start);
    p.displayEndMs = p.lastKeyDownMs + HOLD_MS;
    presses.push(p);
  }
  return presses;
}

function modifierHoldStartMs(timeline: (KeyEvent | MouseEvent)[], key: string, firstKeyDownMs: number, prev: ShortcutPress | null): number {
  const name = NAME_OF_MODIFIER[key];
  if (key === 'CapsLock' || !name) return firstKeyDownMs;
  const floor = Math.max(firstKeyDownMs - MODIFIER_LOOKBACK_MS, prev ? prev.lastEventMs + 1 : -Infinity);
  let start = firstKeyDownMs;
  let i = timeline.length - 1;
  while (i >= 0 && timeline[i].recordingTimeMs > firstKeyDownMs - 1) i--;
  for (; i >= 0; i--) {
    const e = timeline[i];
    const mods = 'activeModifiers' in e ? e.activeModifiers : [];
    if (e.recordingTimeMs < floor || !mods.includes(name)) break;
    start = e.recordingTimeMs;
  }
  return start;
}

// ---- Keycaps --------------------------------------------------------------------------------

export type KeySkin = 'mac' | 'windows';

export interface KeyCap {
  key: string;
  widthRatio: number;
  symbol: string | null;
  label: string;
  placement: 'bottom-left' | 'bottom-center' | 'center';
}

const MAC_MODIFIERS: Record<string, [string | null, string]> = {
  Fn: ['fn', ''],
  Ctrl: ['⌃', 'control'],
  CapsLock: ['⇪', 'caps lock'],
  Alt: ['⌥', 'option'],
  Shift: ['⇧', 'shift'],
  Meta: ['⌘', 'command'],
};
const WINDOWS_MODIFIERS: Record<string, [string | null, string]> = {
  Fn: [null, 'fn'],
  Ctrl: [null, 'ctrl'],
  CapsLock: ['⇪', 'caps lock'],
  Alt: [null, 'alt'],
  Shift: ['⇧', 'shift'],
  Meta: ['⊞', 'win'],
};
const MAC_SPECIAL: Record<string, Partial<KeyCap>> = {
  Escape: { symbol: '⎋', label: 'esc' },
  Enter: { symbol: null, label: '⏎', placement: 'center' },
  Tab: { symbol: '⇥', label: 'tab' },
  Backspace: { symbol: '⌦', label: 'delete' },
  Delete: { symbol: '⌫', label: 'delete' },
  ' ': { symbol: '␣', label: 'space', placement: 'bottom-center', widthRatio: SPACE_WIDTH },
};
const WINDOWS_SPECIAL: Record<string, Partial<KeyCap>> = {
  ...MAC_SPECIAL,
  Escape: { symbol: null, label: 'esc' },
  Enter: { symbol: '⏎', label: 'enter' },
  Backspace: { symbol: '⌫', label: 'backspace' },
  Delete: { symbol: null, label: 'del' },
};
const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const SHIFTED_DIGITS: Record<string, string> = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };

function keyLabel(key: string): string {
  if (ARROWS[key]) return ARROWS[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function keyCapsOf(shortcut: string[], skin: KeySkin): KeyCap[] {
  // Shift+1 is recorded as "!": show it as the key that was pressed.
  let keys = shortcut;
  if (keys.includes('Shift') && keys.length > 1) {
    const other = keys.find((k) => k !== 'Shift');
    keys = keys.length === 2 && other && other in SHIFTED_DIGITS ? [other] : keys.map((k) => SHIFTED_DIGITS[k] ?? k);
  }
  const mods = keys.filter(isModifier).sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  const rest = keys.filter((k) => !isModifier(k));
  const modTable = skin === 'mac' ? MAC_MODIFIERS : WINDOWS_MODIFIERS;
  const special = skin === 'mac' ? MAC_SPECIAL : WINDOWS_SPECIAL;
  return [
    ...mods.map((k): KeyCap => ({ key: k, widthRatio: MODIFIER_WIDTH, symbol: modTable[k][0], label: modTable[k][1], placement: 'bottom-left' })),
    ...rest.map((k): KeyCap => {
      const s = special[k];
      if (s) return { key: k, widthRatio: s.widthRatio ?? MODIFIER_WIDTH, symbol: s.symbol ?? null, label: s.label ?? k, placement: s.placement ?? 'bottom-left' };
      return { key: k, widthRatio: 1, symbol: null, label: keyLabel(k), placement: 'center' };
    }),
  ];
}

const capId = (k: KeyCap) => `${k.placement}:${k.label}:${k.symbol ?? ''}`;

// A keycap on screen across one or more consecutive presses that share it (holding ⌘ while
// pressing C then V keeps the ⌘ cap; the C cap hands off to V).
interface CapInstance {
  cap: KeyCap;
  segments: { press: ShortcutPress; keyIndex: number; caps: KeyCap[] }[];
  appearIndex: number;
  handoff: ShortcutPress | null;
}

const instStart = (i: CapInstance) => i.segments[0].press.displayStartMs;
const instEnd = (i: CapInstance) => (i.handoff ? i.handoff.displayStartMs + FADE_MS : i.segments[i.segments.length - 1].press.displayEndMs);

function capInstances(presses: ShortcutPress[], skin: KeySkin): CapInstance[] {
  const all: CapInstance[] = [];
  const live = new Map<string, CapInstance>();
  let prev: ShortcutPress | null = null;
  for (const p of presses) {
    const caps = keyCapsOf(p.shortcut, skin);
    if (!prev || p.displayStartMs > prev.displayEndMs) live.clear();
    else {
      for (const [id, inst] of live) {
        if (!caps.some((c) => capId(c) === id)) {
          inst.handoff = p;
          live.delete(id);
        }
      }
    }
    caps.forEach((cap, keyIndex) => {
      const id = capId(cap);
      const existing = live.get(id);
      if (existing) {
        existing.segments.push({ press: p, keyIndex, caps });
        return;
      }
      const inst: CapInstance = { cap, segments: [{ press: p, keyIndex, caps }], appearIndex: keyIndex, handoff: null };
      live.set(id, inst);
      all.push(inst);
    });
    prev = p;
  }
  return all;
}

export interface ShortcutOverlayConfig {
  enabled: boolean;
  showSingleLetters: boolean;
  sizeRatio: number; // key height / stage height
}

export interface KeyCapDraw {
  cap: KeyCap;
  rect: { x: number; y: number; width: number; height: number }; // stage units
  opacity: number;
  cornerRadius: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
// The reference eases these ramps with a stiff spring; smoothstep is close at 100 ms.
const ease = (v: number) => v * v * (3 - 2 * v);

export class ShortcutOverlay {
  private readonly instances: CapInstance[];

  constructor(
    keys: KeyEvent[],
    mouse: MouseEvent[],
    private readonly slices: Slice[],
    private readonly config: ShortcutOverlayConfig,
  ) {
    const skin: KeySkin = keys.some((k) => k.keyCode !== undefined) ? 'windows' : 'mac';
    const presses = config.enabled ? findShortcutPresses(keys, mouse, config.showSingleLetters).filter((p) => this.inEdit(p.displayStartMs, p.displayEndMs)) : [];
    this.instances = capInstances(presses, skin);
  }

  get pressCount(): number {
    return this.instances.length;
  }

  private inEdit(a: number, b: number): boolean {
    return this.slices.some((s) => s.sourceStartMs < b && s.sourceEndMs > a);
  }

  // Keycaps visible at source time t on a stage of the given size.
  capsAt(t: number, stage: { width: number; height: number }): KeyCapDraw[] {
    const out: KeyCapDraw[] = [];
    for (const inst of this.instances) {
      if (t < instStart(inst) || t > instEnd(inst)) continue;
      let seg = inst.segments[0];
      for (const s of inst.segments) {
        if (s.press.displayStartMs > t) break;
        seg = s;
      }
      const appear = ease(clamp01((t - (instStart(inst) + inst.appearIndex * STAGGER_MS)) / FADE_MS));
      const leave = inst.handoff && t >= inst.handoff.displayStartMs ? ease(clamp01((t - inst.handoff.displayStartMs) / FADE_MS)) : 0;
      const opacity = leave > 0 ? 1 - leave : appear;
      if (opacity <= 0.001) continue;
      const rows = this.layout(seg.caps, stage);
      const r = rows.keys[seg.keyIndex];
      const travel = -1 + (1 - leave) * appear; // -1 = lowered (hidden), 0 = resting
      out.push({ cap: inst.cap, rect: { ...r, y: r.y + travel * rows.travel }, opacity, cornerRadius: this.config.sizeRatio * 128 * rows.scale });
    }
    return out;
  }

  // Keys centred in a band at the bottom of the stage (inside a 5% margin).
  private layout(caps: KeyCap[], stage: { width: number; height: number }) {
    const area = new Rect({ width: stage.width, height: stage.height }).padByRatio(-STAGE_MARGIN_RATIO);
    const h = stage.height * this.config.sizeRatio;
    const band = new Rect({ width: area.width, height: h }).fitInside(area, { x: 0.5, y: 1 });
    const widths = caps.map((c) => h * c.widthRatio);
    const gap = h * KEY_GAP_RATIO;
    const row = new Rect({ width: widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1), height: h }).fitInside(band, { x: 0.5, y: 0.5 });
    const k = row.height / h;
    let x = row.x;
    const keys = widths.map((w) => {
      const r = { x, y: row.y, width: w * k, height: row.height };
      x += w * k + gap * k;
      return r;
    });
    return { keys, scale: k, travel: row.height * APPEAR_TRAVEL_RATIO };
  }
}
