// Preview player: draws the project into the editor canvas, plays it with audio, and seeks.
// Uses the same FrameRenderer as export; only the motion-blur budget differs (render.md §1.3).

import type { Scene } from '../../core/scene/scene';
import type { Compositor } from '../gpu/compositor';
import type { CursorImages } from '../media/cursor-images';
import { type DemuxedVideo, SequentialFrames } from '../media/video-track';
import { type AudioClip, loadAudioClips } from '../media/audio';
import { FrameRenderer } from '../render/frame-renderer';

const PREVIEW_FPS = 60;
const TAPS_PLAYING = 6;
const TAPS_PAUSED = 16;

export class Player {
  private renderer: FrameRenderer;
  private frames: SequentialFrames | null = null;
  private framesFrom = -1;
  private playing = false;
  private startWall = 0;
  private startAt = 0;
  private timeMs = 0;
  private raf = 0;
  private drawing = false;
  private pendingDraw = false;
  private audio: AudioContext | null = null;
  private clips: AudioClip[] = [];
  private sources: AudioBufferSourceNode[] = [];
  onTime: (t: number) => void = () => {};

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: GPUCanvasContext,
    private scene: Scene,
    private readonly compositor: Compositor,
    private readonly cursors: CursorImages,
    private readonly video: DemuxedVideo,
    private readonly mediaBase: string,
  ) {
    compositor.configure(ctx);
    this.renderer = this.makeRenderer();
  }

  private makeRenderer(): FrameRenderer {
    return new FrameRenderer(this.scene, this.compositor, this.cursors, { fps: PREVIEW_FPS, motionBlurTaps: TAPS_PAUSED, motionBlurEnabled: true });
  }

  async loadAudio(): Promise<void> {
    this.audio = new AudioContext({ sampleRate: 48000 });
    this.clips = await loadAudioClips(this.mediaBase, this.scene.project, this.audio);
  }

  get duration(): number {
    return this.scene.playbackDurationMs;
  }

  get currentTime(): number {
    return this.timeMs;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  // Call after any project edit: rebuilds the scene-dependent caches and redraws.
  setScene(scene: Scene): void {
    this.scene = scene;
    this.renderer = this.makeRenderer();
    void this.requestDraw();
  }

  resize(widthPx: number): void {
    const stage = this.scene.layout.stage;
    this.canvas.width = Math.max(2, Math.round(widthPx));
    this.canvas.height = Math.max(2, Math.round((widthPx * stage.height) / stage.width));
    void this.requestDraw();
  }

  async seek(t: number): Promise<void> {
    this.timeMs = Math.max(0, Math.min(this.duration, t));
    if (this.playing) {
      this.stopAudio();
      this.startPlayback();
    }
    this.onTime(this.timeMs);
    await this.requestDraw();
  }

  play(): void {
    if (this.playing) return;
    if (this.timeMs >= this.duration - 1) this.timeMs = 0;
    this.playing = true;
    this.renderer.quality.motionBlurTaps = TAPS_PLAYING;
    this.startPlayback();
    const tick = async () => {
      if (!this.playing) return;
      const t = this.startAt + (this.clock() - this.startWall);
      if (t >= this.duration) {
        this.pause();
        this.timeMs = this.duration;
      } else {
        this.timeMs = t;
        await this.drawAt(t);
      }
      this.onTime(this.timeMs);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    this.renderer.quality.motionBlurTaps = TAPS_PAUSED;
    void this.requestDraw();
  }

  private clock(): number {
    return this.audio && this.clips.length ? this.audio.currentTime * 1000 : performance.now();
  }

  private startPlayback(): void {
    this.startAt = this.timeMs;
    this.startWall = this.clock();
    if (!this.audio || this.clips.length === 0) return;
    void this.audio.resume();
    const now = this.audio.currentTime;
    for (const c of this.clips) {
      const offset = (this.timeMs - c.startMs) / 1000;
      if (offset >= c.buffer.duration) continue;
      const src = this.audio.createBufferSource();
      src.buffer = c.buffer;
      const g = this.audio.createGain();
      g.gain.value = c.gain;
      src.connect(g).connect(this.audio.destination);
      if (offset >= 0) src.start(now, offset);
      else src.start(now - offset);
      this.sources.push(src);
    }
    this.startWall = this.audio.currentTime * 1000;
  }

  private stopAudio(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
  }

  private async requestDraw(): Promise<void> {
    if (this.drawing) {
      this.pendingDraw = true;
      return;
    }
    this.drawing = true;
    try {
      do {
        this.pendingDraw = false;
        await this.drawAt(this.timeMs);
      } while (this.pendingDraw);
    } finally {
      this.drawing = false;
    }
  }

  private async drawAt(t: number): Promise<void> {
    const source = this.scene.cursor.timeMap.playbackToSource(t);
    // Reuse the forward decoder while playing forward; restart from a keyframe on a jump back.
    if (!this.frames || source < this.framesFrom || (!this.playing && source - this.framesFrom > 4000)) {
      this.frames?.close();
      this.frames = new SequentialFrames(this.video, source);
    }
    this.framesFrom = source;
    const frame = await this.frames.frameAt(source);
    if (frame) this.compositor.setScreenFrame(frame);
    this.renderer.draw(this.ctx.getCurrentTexture(), t);
  }

  destroy(): void {
    this.pause();
    this.frames?.close();
    void this.audio?.close();
  }
}
