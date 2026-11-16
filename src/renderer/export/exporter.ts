// Exports a project to MP4: renders every frame in order from frame 0 (one continuous spring
// simulation), encodes H.264 (VP9 fallback) and AAC (Opus fallback) with WebCodecs, and streams
// the muxed file to disk through the main process.

import { Muxer, StreamTarget } from 'mp4-muxer';
import type { Scene } from '../../core/scene/scene';
import type { Compositor } from '../gpu/compositor';
import type { CursorImages } from '../media/cursor-images';
import { type DemuxedVideo, SequentialFrames } from '../media/video-track';
import { encodeAudioBuffer, loadAudioClips, mixClips, pickAudioCodec, SAMPLE_RATE } from '../media/audio';
import { FrameRenderer } from '../render/frame-renderer';

export interface ExportSettings {
  fps: number;
  height: number; // output height in px; width follows the stage aspect
  filePath: string;
}

export interface ExportProgress {
  frame: number;
  frames: number;
}

const EXPORT_MOTION_BLUR_TAPS = 16;
const KEYFRAME_INTERVAL = 120;

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

async function pickVideoCodec(width: number, height: number, fps: number): Promise<{ config: VideoEncoderConfig; muxCodec: 'avc' | 'vp9' }> {
  const bitrate = Math.round(width * height * fps * 0.15);
  const options: { config: VideoEncoderConfig; muxCodec: 'avc' | 'vp9' }[] = [
    { config: { codec: 'avc1.640033', width, height, framerate: fps, bitrate, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } }, muxCodec: 'avc' },
    { config: { codec: 'avc1.640033', width, height, framerate: fps, bitrate, avc: { format: 'avc' } }, muxCodec: 'avc' },
    { config: { codec: 'vp09.00.51.08', width, height, framerate: fps, bitrate }, muxCodec: 'vp9' },
  ];
  for (const o of options) {
    try {
      if ((await VideoEncoder.isConfigSupported(o.config)).supported) return o;
    } catch {
      // next option
    }
  }
  throw new Error('No supported video encoder (H.264 or VP9) on this system.');
}

export async function exportProject(
  opts: { scene: Scene; compositor: Compositor; cursors: CursorImages; video: DemuxedVideo; mediaBase: string },
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const { scene, compositor, cursors, video } = opts;
  const api = window.recorder;
  const stage = scene.layout.stage;
  const height = even(settings.height);
  const width = even((height * stage.width) / stage.height);
  const durationMs = scene.playbackDurationMs;
  const frames = Math.max(1, Math.floor((durationMs / 1000) * settings.fps));

  const { config: vConfig, muxCodec } = await pickVideoCodec(width, height, settings.fps);
  const aConfig = await pickAudioCodec();
  const audioCtx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
  const mixed = aConfig ? await mixClips(await loadAudioClips(opts.mediaBase, scene.project, audioCtx), durationMs) : null;

  const handle = await api.exportOpen(settings.filePath);
  let writeChain = Promise.resolve();
  let writeError: Error | null = null;
  const muxer = new Muxer({
    target: new StreamTarget({
      chunked: true,
      onData: (data, position) => {
        const copy = data.slice().buffer;
        writeChain = writeChain.then(() => api.exportWrite(handle, position, copy)).catch((e) => {
          writeError = e as Error;
        });
      },
    }),
    video: { codec: muxCodec, width, height, frameRate: settings.fps },
    audio: mixed && aConfig ? { codec: aConfig.codec === 'opus' ? 'opus' : 'aac', numberOfChannels: 2, sampleRate: SAMPLE_RATE } : undefined,
    fastStart: false,
    firstTimestampBehavior: 'offset',
  });

  let encodeError: Error | null = null;
  const vEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e instanceof Error ? e : new Error(String(e))),
  });
  vEncoder.configure(vConfig);

  if (mixed && aConfig) {
    const aEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => (encodeError = e instanceof Error ? e : new Error(String(e))),
    });
    aEncoder.configure(aConfig);
    encodeAudioBuffer(mixed, aEncoder);
    await aEncoder.flush();
    aEncoder.close();
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('webgpu')!;
  compositor.configure(ctx);
  const renderer = new FrameRenderer(scene, compositor, cursors, { fps: settings.fps, motionBlurTaps: EXPORT_MOTION_BLUR_TAPS, motionBlurEnabled: true });
  const source = new SequentialFrames(video);
  try {
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      if (writeError) throw writeError;
      const t = (f * 1000) / settings.fps;
      const frame = await source.frameAt(scene.cursor.timeMap.playbackToSource(t));
      if (frame) compositor.setScreenFrame(frame);
      renderer.draw(ctx.getCurrentTexture(), t);
      await compositor.device.queue.onSubmittedWorkDone();
      const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1000), duration: Math.round(1e6 / settings.fps) });
      vEncoder.encode(vf, { keyFrame: f % KEYFRAME_INTERVAL === 0 });
      vf.close();
      // Keep the encoder queue short so memory stays flat.
      while (vEncoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
      onProgress({ frame: f + 1, frames });
    }
    await vEncoder.flush();
    muxer.finalize();
    await writeChain;
    if (encodeError) throw encodeError;
    if (writeError) throw writeError;
  } finally {
    source.close();
    if (vEncoder.state !== 'closed') vEncoder.close();
    await writeChain;
    await api.exportClose(handle);
  }
}
