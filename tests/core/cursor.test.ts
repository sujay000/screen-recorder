import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { Scene } from '../../src/core/scene/scene';
import { StyleTimeline } from '../../src/core/animation/timeline';
import { openProject, readReferenceHoverTimes } from '../../src/node/bundle';
import { referenceProjects } from '../fixtures/reference';

const projects = referenceProjects();

describe.skipIf(projects.length === 0)('cursor planner on reference recordings', () => {
  for (const p of projects) {
    it(`lands on clicks in ${path.basename(p)}`, () => {
      const project = openProject(p);
      const hover = readReferenceHoverTimes(p, project.recording.sessions.map((s) => s.recordingStartMs));
      const scene = new Scene(project, { hasCamera: false, hoverChangeTimes: hover });
      const clicks = scene.cursor.clicks;
      const t0 = performance.now();
      let within = 0;
      let worst = 0;
      for (const c of clicks) {
        const pos = scene.cursor.positionAt(c.recordingTimeMs)!;
        const d = Math.hypot(pos.x - c.x, pos.y - c.y);
        worst = Math.max(worst, d);
        if (d <= 2) within++;
      }
      const ms = performance.now() - t0;
      console.log(`${path.basename(p)}: ${within}/${clicks.length} clicks within 2 pt, worst ${worst.toFixed(2)} pt, planning ${ms.toFixed(0)} ms`);
      expect(within / Math.max(1, clicks.length)).toBeGreaterThanOrEqual(0.9);
    });

    it(`timeline is deterministic and continuous in ${path.basename(p)}`, () => {
      const project = openProject(p);
      const scene = new Scene(project, { hasCamera: false });
      const a = new StyleTimeline(scene, 60);
      const b = new StyleTimeline(scene, 60);
      const end = Math.min(scene.playbackDurationMs, 8000);
      let maxJump = 0;
      let prev = a.styleAt(0).screen.x;
      for (let f = 1; f * (1000 / 60) < end; f++) {
        const t = f * (1000 / 60);
        const x = a.styleAt(t).screen.x;
        maxJump = Math.max(maxJump, Math.abs(x - prev));
        prev = x;
        expect(b.styleAt(t).screen.x).toBe(x);
      }
      // Springs move the screen smoothly: no frame-to-frame jump larger than a third of the stage.
      expect(maxJump).toBeLessThan(scene.layout.stage.width / 3);
    });
  }
});
