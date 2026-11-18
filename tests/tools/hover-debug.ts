import * as fs from 'node:fs';
import { HoverDetector, patchRectFor, type Patch } from '../../src/core/cursor/hover-detector';
import { openProject } from '../../src/node/bundle';
const bundle = process.argv[2];
const p = openProject(bundle);
const W = 3456, H = 2168, ppp = W / p.recording.displayBounds.width;
const pts = fs.readFileSync('/tmp/sr-test/hv/pts.txt', 'utf8').trim().split('\n').map((l) => parseFloat(l));
const t0 = pts[0];
const times = pts.map((x) => (x - t0) * 1000).filter((t) => t >= 3400 - 1e-6 && t < 4600);
const fd = fs.openSync('/tmp/sr-test/hv/frames.yuv', 'r');
const moves = p.recording.mouseEvents.filter((e) => e.type === 'mouseMoved' || e.type === 'mouseDragged');
const det = new HoverDetector(moves, p.recording.mouseclicks, ppp, { width: W, height: H });
det.onEvaluate = (t, reason, d) => { if (t > 4000 && t < 4500) console.log(t.toFixed(1), reason, d ? JSON.stringify(d).slice(0, 160) : ''); };
const plane = W * H;
const buf = Buffer.alloc(plane);
times.forEach((t, i) => {
  const r = patchRectFor(moves, t, ppp, { width: W, height: H });
  if (!r) return;
  const { x0, y0, w, h } = r;
  const planes = [0, 1, 2].map((k) => {
    fs.readSync(fd, buf, 0, plane, i * plane * 3 + k * plane);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(buf.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
    return out;
  });
  const patch: Patch = { timeMs: t, x0, y0, w, h, y: planes[0], cb: planes[1], cr: planes[2] };
  det.push(patch);
});
console.log('changes', det.changes.map((x) => x.toFixed(1)), 'frames', times.length, 'cursor@4268', JSON.stringify(det.cursorPx(4268.3)));
