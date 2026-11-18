// Test harness run inside the real app (see main.ts): opens a project, optionally screenshots
// the editor, exports it and reports timings and checks back to the main process.

import type { EditorController } from './editor/editor-controller';
import { Compositor } from './gpu/compositor';
import type { OpenedProject } from '../shared/ipc';
import { analyseHovers } from './media/hover-analysis';
import { trackFaces } from './media/face-tracking';
import { webcamMimeType } from './recording/use-recorder';
import { demuxBytes, SequentialFrames } from './media/video-track';

export interface SelfTestJob {
  bundle: string;
  out: string;
  fps?: number;
  format?: 'mp4' | 'gif';
  height?: number;
  screenshot?: string; // if set: open, seek, let the UI settle, screenshot the window, skip export
  seekMs?: number;
  audioProbe?: boolean; // record 3 s with MediaRecorder (as the Windows app does) and decode it
  hoverProbe?: boolean; // run our hover detector and compare with the reference app's cache
  faceProbe?: boolean; // run the face tracker on the webcam and report what it found
  webcamProbe?: boolean; // record 3 s of video as MP4 with MediaRecorder (as the Windows webcam) and decode it
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
    if (job.webcamProbe) {
      Object.assign(result, await probeMediaRecorderWebcam());
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
    result.gpu = Compositor.adapterInfo;
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
    if (job.faceProbe) {
      if (!editor.camera) throw new Error('This recording has no webcam track.');
      const t2 = performance.now();
      const samples = await trackFaces(editor.camera);
      result.faceMs = Math.round(performance.now() - t2);
      result.faceSamples = samples.length;
      result.webcamSeconds = +((editor.camera.samples.at(-1)!.timeMs - editor.camera.samples[0].timeMs) / 1000).toFixed(1);
      const xs = samples.map((f) => f.x01);
      const ys = samples.map((f) => f.y01);
      result.faceX = [Math.min(...xs), Math.max(...xs)].map((v) => +v.toFixed(3));
      result.faceY = [Math.min(...ys), Math.max(...ys)].map((v) => +v.toFixed(3));
      await window.recorder.saveFaceTrack(editor.project.path, samples);
      result.ok = true;
      await window.recorder.reportSelfTest(result);
      return;
    }
    if (job.hoverProbe) {
      const t2 = performance.now();
      result.ours = await analyseHovers(editor.project.recording, editor.video, (f) => console.warn(`hover analysis ${(f * 100).toFixed(0)}%`));
      result.reference = editor.opened.hoverChangeTimes;
      result.hoverMs = Math.round(performance.now() - t2);
      result.ok = true;
      await window.recorder.reportSelfTest(result);
      return;
    }
    const t1 = performance.now();
    let frames = 0;
    await editor.export({ format: job.format ?? 'mp4', fps: job.fps ?? 60, height: job.height ?? 1080, filePath: job.out }, (p) => (frames = p.frame), new AbortController().signal);
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

// The webcam is recorded as MP4 so mp4box can demux it. Check the whole chain on a canvas stream.
async function probeMediaRecorderWebcam(): Promise<Record<string, unknown>> {
  const mimeType = webcamMimeType();
  if (!mimeType) return { mimeType: null };
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext('2d')!;
  let frame = 0;
  const timer = setInterval(() => {
    g.fillStyle = `hsl(${(frame++ * 7) % 360} 70% 50%)`;
    g.fillRect(0, 0, 640, 360);
  }, 33);
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start(1000);
  await settle(3000);
  rec.stop();
  await done;
  clearInterval(timer);
  const blob = new Blob(chunks, { type: mimeType });
  const video = await demuxBytes(new Uint8Array(await blob.arrayBuffer()), 0);
  const frames = new SequentialFrames(video);
  let decoded = 0;
  for (const s of video.samples) if (await frames.frameAt(s.timeMs)) decoded++;
  frames.close();
  const last = video.samples[video.samples.length - 1];
  return { mimeType, bytes: blob.size, codec: video.config.codec, size: [video.width, video.height], samples: video.samples.length, decoded, lastSampleMs: Math.round(last?.timeMs ?? 0) };
}
