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
  audioProbe?: boolean; // record 3 s with MediaRecorder (as the Windows app does) and decode it
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSelfTest(job: SelfTestJob, open: (o: OpenedProject) => Promise<EditorController>): Promise<void> {
  const result: Record<string, unknown> = { ok: false };
  try {
    if (job.audioProbe) {
      Object.assign(result, await probeMediaRecorderAudio());
      result.ok = true;
      await window.recorder.reportSelfTest(result);
      return;
    }
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

// Chromium's MediaRecorder writes WebM without a duration header. Check the editor can still
// decode the whole file at the right length.
async function probeMediaRecorderAudio(): Promise<Record<string, unknown>> {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 160000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start(1000);
  await settle(3000);
  rec.stop();
  await done;
  osc.stop();
  const bytes = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer();
  const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(bytes.slice(0));
  const ch = decoded.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  return { webmBytes: bytes.byteLength, decodedSeconds: +decoded.duration.toFixed(3), channels: decoded.numberOfChannels, peak: +peak.toFixed(3) };
}
