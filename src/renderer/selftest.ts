// Test harness run inside the real app (see main.ts): opens a project, optionally screenshots
// the editor, exports it and reports timings and checks back to the main process.

import type { EditorController } from './editor/editor-controller';
import type { OpenedProject } from '../shared/ipc';

export interface SelfTestJob {
  bundle: string;
  out: string;
  fps?: number;
  height?: number;
  screenshot?: string; // if set: open, seek, let the UI settle, screenshot the window, skip export
  seekMs?: number;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSelfTest(job: SelfTestJob, open: (o: OpenedProject) => Promise<EditorController>): Promise<void> {
  const result: Record<string, unknown> = { ok: false };
  try {
    if (!job.bundle && job.screenshot) {
      await settle(1000); // welcome screen only
      result.ok = true;
      await window.recorder.reportSelfTest(result);
      return;
    }
    const t0 = performance.now();
    const editor = await open(await window.recorder.openProject(job.bundle));
    result.openMs = Math.round(performance.now() - t0);
    result.durationMs = editor.durationMs;
    result.zooms = editor.project.zooms.length;
    result.stage = editor.scene.layout.stage.raw;
    result.videoSamples = editor.video.samples.length;
    result.videoSize = [editor.video.width, editor.video.height];
    await settle(800);
    if (job.screenshot) {
      editor.seek(job.seekMs ?? 4500);
      await settle(1200);
      result.ok = true;
      await window.recorder.reportSelfTest(result);
      return;
    }
    const t1 = performance.now();
    let frames = 0;
    await editor.export({ fps: job.fps ?? 60, height: job.height ?? 1080, filePath: job.out }, (p) => (frames = p.frame), new AbortController().signal);
    result.exportFrames = frames;
    result.exportMs = Math.round(performance.now() - t1);
    result.ok = true;
  } catch (err) {
    result.error = `${(err as Error).message}\n${(err as Error).stack ?? ''}`;
  }
  await window.recorder.reportSelfTest(result);
}
