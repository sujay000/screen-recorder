// Finds the face in the webcam video with MediaPipe's BlazeFace detector (bundled model, runs
// locally), five times a second. The result is cached in the bundle (cache/recorder-face.json).

import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import type { FaceSample } from '../../core/camera/face-track';
import { type DemuxedVideo, SequentialFrames } from './video-track';

const STEP_MS = 200;
const ANALYSIS_WIDTH = 320;
const MIN_CONFIDENCE = 0.5;

// Copied into dist/renderer/mediapipe by scripts/build.mjs, served by the main process.
const WASM_DIR = 'media://mediapipe/wasm';
const MODEL = 'media://mediapipe/blaze_face_short_range.tflite';

export async function trackFaces(video: DemuxedVideo, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<FaceSample[]> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
    runningMode: 'VIDEO',
    minDetectionConfidence: MIN_CONFIDENCE,
  });
  const h = Math.max(1, Math.round((ANALYSIS_WIDTH * video.height) / video.width));
  const canvas = new OffscreenCanvas(ANALYSIS_WIDTH, h);
  const g = canvas.getContext('2d')!;
  const frames = new SequentialFrames(video);
  const first = video.samples.reduce((m, s) => Math.min(m, s.timeMs), Infinity);
  const last = video.samples.reduce((m, s) => Math.max(m, s.timeMs), -Infinity);
  const out: FaceSample[] = [];
  let decodeMs = 0;
  let detectMs = 0;
  try {
    for (let t = first; t <= last; t += STEP_MS) {
      if (signal?.aborted) throw new DOMException('Face tracking cancelled', 'AbortError');
      const t0 = performance.now();
      const frame = await frames.frameAt(t);
      const t1 = performance.now();
      decodeMs += t1 - t0;
      if (!frame) continue;
      g.drawImage(frame, 0, 0, ANALYSIS_WIDTH, h);
      const result = detector.detectForVideo(canvas as unknown as HTMLCanvasElement, Math.round(t - first));
      detectMs += performance.now() - t1;
      const best = result.detections.reduce<(typeof result.detections)[number] | null>((m, d) => ((d.categories[0]?.score ?? 0) > (m?.categories[0]?.score ?? -1) ? d : m), null);
      const box = best?.boundingBox;
      if (box) out.push({ t, x01: (box.originX + box.width / 2) / ANALYSIS_WIDTH, y01: (box.originY + box.height / 2) / h });
      onProgress?.((t - first) / Math.max(1, last - first));
    }
  } finally {
    console.warn(`face tracking: decode ${Math.round(decodeMs)} ms, detect ${Math.round(detectMs)} ms`);
    frames.close();
    detector.close();
  }
  return out;
}
