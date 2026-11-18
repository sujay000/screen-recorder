// Exports a project to MP4: renders every frame in order from frame 0 (one continuous spring
// simulation), encodes H.264 (VP9 fallback) and AAC (Opus fallback) with WebCodecs, and streams
// the muxed file to disk through the main process.

import { Muxer, StreamTarget } from 'mp4-muxer';
import type { Scene } from '../../core/scene/scene';
import type { Compositor } from '../gpu/compositor';
import type { CursorImages } from '../media/cursor-images';
import type { DemuxedVideo } from '../media/video-track';
import { FrameSources } from '../media/frame-sources';
import { encodeMix, loadAudioClips, pickAudioCodec, SAMPLE_RATE } from '../media/audio';
import { FrameRenderer } from '../render/frame-renderer';

export interface ExportSettings {
  format?: 'mp4' | 'gif'; // default mp4
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
  throw new Error(`No supported video encoder for ${width}x${height} at ${fps} fps (tried H.264 hardware, H.264 software, VP9). Try a lower resolution.`);
}

export async function exportProject(
  opts: { scene: Scene; compositor: Compositor; cursors: CursorImages; video: DemuxedVideo; camera: DemuxedVideo | null; mediaBase: string },
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
  const audio = await loadAudioClips(opts.mediaBase, scene.project, audioCtx);
  // Fail loudly rather than silently export without a track the user expects.
  if (audio.problems.length) throw new Error(audio.problems.join(' '));
  if (audio.clips.length && !aConfig) throw new Error('No AAC or Opus audio encoder is available on this system, so the audio cannot be exported.');
  const withAudio = audio.clips.length > 0 && aConfig !== null;

  const handle = await api.exportOpen(settings.filePath);
  let writeChain = Promise.resolve();
  let writeError: Error | null = null;
  let encodeError: Error | null = null;
  let vEncoder: VideoEncoder | null = null;
  let source: FrameSources | null = null;
  let succeeded = false;
  try {
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
      audio: withAudio ? { codec: aConfig!.codec === 'opus' ? 'opus' : 'aac', numberOfChannels: 2, sampleRate: SAMPLE_RATE } : undefined,
      fastStart: false,
      firstTimestampBehavior: 'offset',
    });

    vEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => (encodeError = new Error(`Video encoder (${vConfig.codec}): ${e instanceof Error ? e.message : String(e)}`)),
    });
    vEncoder.configure(vConfig);

    if (withAudio) {
      const aEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => (encodeError = new Error(`Audio encoder (${aConfig!.codec}): ${e instanceof Error ? e.message : String(e)}`)),
      });
      aEncoder.configure(aConfig!);
      await encodeMix(audio.clips, scene.cursor.timeMap, durationMs, aEncoder);
      await aEncoder.flush();
      aEncoder.close();
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU is not available for export (OffscreenCanvas webgpu context).');
    compositor.configure(ctx);
    const renderer = new FrameRenderer(scene, compositor, cursors, { fps: settings.fps, motionBlurTaps: EXPORT_MOTION_BLUR_TAPS, motionBlurEnabled: true });
    source = new FrameSources(compositor, video, opts.camera);
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      if (writeError) throw writeError;
      const t = (f * 1000) / settings.fps;
      await source.uploadAt(scene.cursor.timeMap.playbackToSource(t), true);
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
    succeeded = true;
  } finally {
    source?.close();
    if (vEncoder && vEncoder.state !== 'closed') vEncoder.close();
    await writeChain;
    await api.exportClose(handle, !succeeded);
  }
}
