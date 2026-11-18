// Runs the hover detector over a recording: decodes the screen video, cuts a YCbCr patch around
// the cursor from frames inside movement spans, and feeds the detector. Used for recordings that
// do not come with the reference app's hover cache (all Windows recordings).

import { HoverDetector, movementSpans, patchRectFor, type Patch } from '../../core/cursor/hover-detector';
import type { Recording } from '../../core/project/model';
import { type DemuxedVideo, SequentialFrames } from './video-track';

// RGB -> limited-range BT.709 YCbCr (the values an NV12 decode gives), written straight into the
// patch planes: no per-pixel allocation, this runs over millions of pixels.
function fillYCbCr(rgba: Uint8ClampedArray, p: Patch): void {
  const n = p.w * p.h;
  for (let k = 0, o = 0; k < n; k++, o += 4) {
    const r = rgba[o] / 255;
    const g = rgba[o + 1] / 255;
    const b = rgba[o + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    p.y[k] = Math.round(16 + 219 * y);
    p.cb[k] = Math.round(128 + 224 * ((b - y) / 1.8556));
    p.cr[k] = Math.round(128 + 224 * ((r - y) / 1.5748));
  }
}

export async function analyseHovers(rec: Recording, video: DemuxedVideo, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<number[]> {
  const moves = rec.mouseEvents.filter((e) => e.type === 'mouseMoved' || e.type === 'mouseDragged');
  const clicks = rec.mouseclicks;
  if (moves.length < 2) return [];
  const ppp = video.width / rec.displayBounds.width; // pixels per point
  const size = { width: video.width, height: video.height };
  const detector = new HoverDetector(moves, clicks, ppp, size);
  const spans = movementSpans(moves);
  const lead = 120 + 150 + 200; // history needed before a span
  const inSpan = (t: number) => spans.some((s) => t >= s.startMs - lead && t <= s.endMs);
  const canvas = new OffscreenCanvas(1, 1);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const frames = new SequentialFrames(video);
  const times = video.samples.map((s) => s.timeMs).sort((a, b) => a - b);
  try {
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw new DOMException('Hover analysis cancelled', 'AbortError');
      const t = times[i];
      if (!inSpan(t)) continue;
      const frame = await frames.frameAt(t);
      const rect = patchRectFor(moves, t, ppp, size);
      if (!frame || !rect) continue;
      const { x0, y0, w, h } = rect;
      if (canvas.width < w || canvas.height < h) {
        canvas.width = Math.max(canvas.width, w);
        canvas.height = Math.max(canvas.height, h);
      }
      g.drawImage(frame, x0, y0, w, h, 0, 0, w, h);
      const rgba = g.getImageData(0, 0, w, h).data;
      const p: Patch = { timeMs: t, x0, y0, w, h, y: new Uint8Array(w * h), cb: new Uint8Array(w * h), cr: new Uint8Array(w * h) };
      fillYCbCr(rgba, p);
      detector.push(p);
      if (i % 30 === 0) onProgress?.(i / times.length);
    }
  } finally {
    frames.close();
  }
  return detector.changes;
}
