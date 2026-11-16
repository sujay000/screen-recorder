// Editing session for one opened project, independent of the UI framework: owns the scene,
// the preview player and saving. React views call into it and subscribe to changes.

import { generateAutoZooms } from '../../core/camera/zoom';
import type { Project, ProjectConfig, Zoom } from '../../core/project/model';
import { Scene } from '../../core/scene/scene';
import type { OpenedProject } from '../../shared/ipc';
import type { Compositor } from '../gpu/compositor';
import { CursorImages } from '../media/cursor-images';
import { type DemuxedVideo, demuxVideo } from '../media/video-track';
import { type ExportProgress, type ExportSettings, exportProject } from '../export/exporter';
import { debounce } from '../util';
import { Player } from './player';

export interface PlaybackState {
  timeMs: number;
  playing: boolean;
}

type Listener = () => void;

export class EditorController {
  readonly project: Project;
  scene: Scene;
  readonly cursors: CursorImages;
  private player: Player | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private listeners = new Set<Listener>();
  private playbackListeners = new Set<Listener>();
  playback: PlaybackState = { timeMs: 0, playing: false };
  // Bumped on every edit so React can re-render cheaply.
  version = 0;
  private readonly save = debounce(() => void window.recorder.saveProject(this.project), 400);

  private constructor(
    readonly opened: OpenedProject,
    readonly video: DemuxedVideo,
    readonly compositor: Compositor,
  ) {
    this.project = opened.project;
    this.cursors = new CursorImages(opened.mediaBase, this.project.recording.cursors);
    this.scene = this.buildScene();
  }

  static async open(opened: OpenedProject, compositor: Compositor): Promise<EditorController> {
    const track = opened.project.recording.screenVideo[0];
    if (!track) throw new Error('This recording has no screen video.');
    const video = await demuxVideo(opened.mediaBase, track);
    const c = new EditorController(opened, video, compositor);
    await c.cursors.preload();
    return c;
  }

  get durationMs(): number {
    return this.scene.playbackDurationMs;
  }

  private buildScene(): Scene {
    return new Scene(this.project, { hasCamera: false, hoverChangeTimes: this.opened.hoverChangeTimes });
  }

  // ---- Preview canvas ----

  async attachCanvas(canvas: HTMLCanvasElement): Promise<void> {
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU canvas is not available.');
    this.player?.destroy();
    this.canvas = canvas;
    const player = new Player(canvas, ctx, this.scene, this.compositor, this.cursors, this.video, this.opened.mediaBase);
    this.player = player;
    player.onTime = (t) => {
      this.playback = { timeMs: t, playing: player.isPlaying };
      this.playbackListeners.forEach((l) => l());
    };
    await player.loadAudio();
    await player.seek(this.playback.timeMs);
  }

  detachCanvas(): void {
    this.player?.destroy();
    this.player = null;
    this.canvas = null;
  }

  // Export borrows the GPU compositor, so the preview is re-attached afterwards.
  async export(settings: ExportSettings, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<void> {
    const canvas = this.canvas;
    this.pause();
    try {
      await exportProject({ scene: this.scene, compositor: this.compositor, cursors: this.cursors, video: this.video, mediaBase: this.opened.mediaBase }, settings, onProgress, signal);
    } finally {
      if (canvas) await this.attachCanvas(canvas);
    }
  }

  resizeCanvas(widthPx: number): void {
    this.player?.resize(widthPx);
  }

  // ---- Playback ----

  togglePlay(): void {
    if (!this.player) return;
    if (this.player.isPlaying) this.player.pause();
    else this.player.play();
    this.playback = { timeMs: this.player.currentTime, playing: this.player.isPlaying };
    this.playbackListeners.forEach((l) => l());
  }

  pause(): void {
    this.player?.pause();
  }

  seek(ms: number): void {
    void this.player?.seek(ms);
  }

  // ---- Edits ----

  updateConfig(edit: (c: ProjectConfig) => void, final = true): void {
    edit(this.project.config);
    this.changed(final);
  }

  setZooms(zooms: Zoom[], final = true): void {
    this.project.zooms = zooms.map((z) => ({ ...z }));
    this.changed(final);
  }

  updateZoom(id: string, patch: Partial<Zoom>): void {
    this.setZooms(this.project.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  }

  deleteZoom(id: string): void {
    this.setZooms(this.project.zooms.filter((z) => z.id !== id));
  }

  restoreAutoZooms(): void {
    this.setZooms(generateAutoZooms(this.project.recording));
  }

  // Maps a point on the preview (0..1 of the stage) to a fixed zoom target (0..1 of the screen).
  setManualTarget(id: string, stage01: { x: number; y: number }): void {
    const stage = this.scene.layout.stage;
    const init = this.scene.layout.initialScreenRect;
    const px = stage01.x * stage.width;
    const py = stage01.y * stage.height;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    this.updateZoom(id, { manualTargetPoint: { x: clamp((px - init.x) / init.width), y: clamp((py - init.y) / init.height) } });
  }

  private changed(final: boolean): void {
    this.scene = this.buildScene();
    this.player?.setScene(this.scene);
    this.version++;
    this.listeners.forEach((l) => l());
    if (final) this.save();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribePlayback(l: Listener): () => void {
    this.playbackListeners.add(l);
    return () => this.playbackListeners.delete(l);
  }

  destroy(): void {
    this.detachCanvas();
    this.listeners.clear();
    this.playbackListeners.clear();
  }
}
