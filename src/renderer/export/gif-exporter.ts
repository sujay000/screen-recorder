// Exports a project to an animated GIF: renders every frame like the MP4 export, reads it back,
// quantises it to a 256-colour palette per frame and encodes with gifenc. GIFs have no audio.

import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { Scene } from '../../core/scene/scene';
import type { Compositor } from '../gpu/compositor';
import type { CursorImages } from '../media/cursor-images';
import type { DemuxedVideo } from '../media/video-track';
import { FrameSources } from '../media/frame-sources';
import { FrameRenderer } from '../render/frame-renderer';
import type { ExportProgress, ExportSettings } from './exporter';

const GIF_MOTION_BLUR_TAPS = 16;

export async function exportGif(
  opts: { scene: Scene; compositor: Compositor; cursors: CursorImages; video: DemuxedVideo; camera: DemuxedVideo | null },
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const { scene, compositor } = opts;
  const api = window.recorder;
  const stage = scene.layout.stage;
  const height = Math.max(2, Math.round(settings.height));
  const width = Math.max(2, Math.round((height * stage.width) / stage.height));
  const frames = Math.max(1, Math.floor((scene.playbackDurationMs / 1000) * settings.fps));
  // GIF delays are whole hundredths of a second; keep the total length right by carrying the error.
  const frameMs = 1000 / settings.fps;

  const gpuCanvas = new OffscreenCanvas(width, height);
  const ctx = gpuCanvas.getContext('webgpu');
  if (!ctx) throw new Error('WebGPU is not available for export (OffscreenCanvas webgpu context).');
  compositor.configure(ctx);
  const readback = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  if (!readback) throw new Error('Canvas 2D is not available to read frames back for the GIF.');
  const renderer = new FrameRenderer(scene, compositor, opts.cursors, { fps: settings.fps, motionBlurTaps: GIF_MOTION_BLUR_TAPS, motionBlurEnabled: true });
  const sources = new FrameSources(compositor, opts.video, opts.camera, () => scene.project.config.camera.layout === 'cutout');
  const gif = GIFEncoder();
  let shownMs = 0;
  try {
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const t = f * frameMs;
      await sources.uploadAt(scene.cursor.timeMap.playbackToSource(t), true);
      renderer.draw(ctx.getCurrentTexture(), t);
      await compositor.device.queue.onSubmittedWorkDone();
      readback.drawImage(gpuCanvas, 0, 0);
      const rgba = readback.getImageData(0, 0, width, height).data;
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      const delay = Math.round(((f + 1) * frameMs - shownMs) / 10) * 10;
      shownMs += delay;
      gif.writeFrame(index, width, height, { palette, delay, repeat: 0 });
      onProgress({ frame: f + 1, frames });
      if (f % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
    }
    gif.finish();
  } finally {
    sources.close();
  }
  const bytes = gif.bytes();
  const handle = await api.exportOpen(settings.filePath);
  let ok = false;
  try {
    await api.exportWrite(handle, 0, bytes.slice().buffer);
    ok = true;
  } finally {
    await api.exportClose(handle, !ok);
  }
}
