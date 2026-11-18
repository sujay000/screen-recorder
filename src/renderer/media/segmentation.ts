// Person segmentation for the webcam cutout layout: MediaPipe's selfie segmenter (bundled model,
// runs locally) turns each webcam frame into a mask (1 = person, 0 = background).

import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

const WASM_DIR = 'media://mediapipe/wasm';
const MODEL = 'media://mediapipe/selfie_segmenter.tflite';
const MASK_WIDTH = 256; // the model's input size; masks come back at this size

export interface PersonMask {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>; // 0..255 per pixel
}

let shared: Promise<ImageSegmenter> | null = null;
// The segmenter is shared (preview and export) and MediaPipe needs strictly increasing
// timestamps across all its calls. The selfie model keeps no state between frames, so a counter
// is enough.
let clock = 0;

function segmenter(): Promise<ImageSegmenter> {
  shared ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  })();
  shared.catch(() => (shared = null)); // allow a retry after a failure
  return shared;
}

export class PersonSegmenter {
  private readonly canvas = new OffscreenCanvas(1, 1);
  private readonly g = this.canvas.getContext('2d', { willReadFrequently: true })!;
  async maskOf(frame: VideoFrame): Promise<PersonMask> {
    const seg = await segmenter();
    const w = MASK_WIDTH;
    const h = Math.max(1, Math.round((MASK_WIDTH * frame.displayHeight) / frame.displayWidth));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.g.drawImage(frame, 0, 0, w, h);
    const result = seg.segmentForVideo(this.canvas as unknown as HTMLCanvasElement, ++clock);
    try {
      const m = result.confidenceMasks?.[0];
      if (!m) throw new Error('The segmenter returned no mask.');
      const f = m.getAsFloat32Array();
      const data = new Uint8Array(f.length);
      for (let i = 0; i < f.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, f[i])) * 255);
      return { width: m.width, height: m.height, data };
    } finally {
      result.close();
    }
  }
}
