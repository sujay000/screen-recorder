// Feeds the compositor the screen frame (and webcam frame, if any) for a source time. Both are
// decoded forward with SequentialFrames; a jump backwards, or a long jump forwards, restarts the
// decoders from the nearest keyframe. For the cutout layout it also segments each new webcam
// frame into a person mask.

import type { Compositor } from '../gpu/compositor';
import { type DemuxedVideo, SequentialFrames } from './video-track';
import { PersonSegmenter } from './segmentation';

const FORWARD_JUMP_RESTART_MS = 4000;

export class FrameSources {
  private screen: SequentialFrames | null = null;
  private camera: SequentialFrames | null = null;
  private lastMs = -Infinity;
  private segmenter: PersonSegmenter | null = null;
  private maskedFrameTime = NaN;

  // wantsMask: whether the webcam is currently shown as a cutout (read on every frame, the
  // layout can change while the editor is open).
  constructor(
    private readonly compositor: Compositor,
    private readonly screenVideo: DemuxedVideo,
    private readonly cameraVideo: DemuxedVideo | null,
    private readonly wantsMask: () => boolean = () => false,
  ) {}

  // continuous: the caller is stepping forward frame by frame (playback, export), so a forward
  // jump never needs a restart.
  async uploadAt(sourceMs: number, continuous: boolean): Promise<void> {
    const restart = !this.screen || sourceMs < this.lastMs || (!continuous && sourceMs - this.lastMs > FORWARD_JUMP_RESTART_MS);
    if (restart) {
      this.close();
      this.screen = new SequentialFrames(this.screenVideo, sourceMs);
      if (this.cameraVideo) this.camera = new SequentialFrames(this.cameraVideo, sourceMs);
    }
    this.lastMs = sourceMs;
    const [screenFrame, cameraFrame] = await Promise.all([this.screen!.frameAt(sourceMs), this.camera ? this.camera.frameAt(sourceMs) : Promise.resolve(null)]);
    if (screenFrame) this.compositor.setScreenFrame(screenFrame);
    this.compositor.setCameraFrame(cameraFrame);
    if (cameraFrame && this.wantsMask()) {
      if (cameraFrame.timestamp !== this.maskedFrameTime) {
        this.segmenter ??= new PersonSegmenter();
        this.compositor.setCameraMask(await this.segmenter.maskOf(cameraFrame));
        this.maskedFrameTime = cameraFrame.timestamp;
      }
    } else if (!Number.isNaN(this.maskedFrameTime)) {
      this.compositor.setCameraMask(null);
      this.maskedFrameTime = NaN;
    }
  }

  close(): void {
    this.screen?.close();
    this.camera?.close();
    this.screen = null;
    this.camera = null;
    this.lastMs = -Infinity;
    this.maskedFrameTime = NaN;
  }
}
