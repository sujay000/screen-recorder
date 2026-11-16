// Prints the animated screen rect per frame for a recording (debug aid).
import { openProject } from '../../src/node/bundle';
import { Scene } from '../../src/core/scene/scene';
import { StyleTimeline } from '../../src/core/animation/timeline';

const [bundle, from = '0', to = '12000'] = process.argv.slice(2);
const p = openProject(bundle);
const scene = new Scene(p, { hasCamera: false });
const tl = new StyleTimeline(scene, 60);
let prev = tl.styleAt(0).screen;
for (let f = 0; f * (1000 / 60) <= Number(to); f++) {
  const t = f * (1000 / 60);
  const s = tl.styleAt(t).screen;
  if (t >= Number(from)) console.log(t.toFixed(0), s.x.toFixed(1), s.y.toFixed(1), s.width.toFixed(1), 'dx', (s.x - prev.x).toFixed(1), 'dy', (s.y - prev.y).toFixed(1));
  prev = s;
}
