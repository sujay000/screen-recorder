// Small event rules: which events may change the drawn cursor image, and "is the user typing".

import { atOrBefore, sliceBetween } from '../geometry/search';
import type { KeyEvent, MouseEvent } from '../project/model';

const rt = (e: { recordingTimeMs: number }) => e.recordingTimeMs;

// When optimizing, only drags (on change), clicks and late moves after a mouseUp change the type.
export function optimizeTypes(events: MouseEvent[]): MouseEvent[] {
  const out: MouseEvent[] = [];
  let runStart: MouseEvent | null = null;
  for (const e of events) {
    runStart ||= e;
    if (runStart.cursorId !== e.cursorId) runStart = e;
    const last = out[out.length - 1];
    if (e.type === 'mouseDragged') {
      if (!last) {
        out.push(e);
        continue;
      }
      if (last.cursorId !== e.cursorId) out.push(e);
    }
    if (e.type === 'mouseMoved' && last && last.type === 'mouseUp' && last.cursorId !== e.cursorId && e.recordingTimeMs - last.recordingTimeMs > 250) {
      out.push({ ...e, cursorId: 'arrow' });
    }
    if (e.type === 'mouseDown' && runStart) {
      out.push(runStart);
      runStart = null;
    }
    if (e.type === 'mouseUp') out.push(e);
  }
  return out;
}

// >= 3 keyDowns in [t - 1800, t] and no mouse event after the last of those keys.
export function isUserTyping(keys: KeyEvent[], mouse: MouseEvent[], t: number): boolean {
  const s = sliceBetween(keys, t - 1800, t, rt);
  if (s.length === 0) return false;
  const downs = s.filter((k) => k.type === 'keyDown').length;
  if (downs < 3) return false;
  const lastKey = s[s.length - 1];
  const lastMouse = atOrBefore(mouse, t, rt);
  return !lastMouse || !(lastMouse.recordingTimeMs > lastKey.recordingTimeMs);
}
