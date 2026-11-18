// Editing session for one opened project, independent of the UI framework: owns the scene,
// the preview player and saving. React views call into it and subscribe to changes.

import { generateAutoZooms } from '../../core/camera/zoom';
import type { Project, ProjectConfig, Slice, Zoom } from '../../core/project/model';
import { Scene, cursorModelKey } from '../../core/scene/scene';
import type { OpenedProject } from '../../shared/ipc';
import type { Compositor } from '../gpu/compositor';
import { CursorImages } from '../media/cursor-images';
import { type DemuxedVideo, demuxVideo } from '../media/video-track';
import { type ExportProgress, type ExportSettings, exportProject } from '../export/exporter';
import { exportGif } from '../export/gif-exporter';
import { toast } from '../ui/overlay';
import { parseCube } from '../../core/color/cube-lut';
import { analyseHovers } from '../media/hover-analysis';
import { debounce } from '../util';
import { Player } from './player';

export const MIN_CLIP_MS = 200; // shortest clip a split or trim may leave

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
    readonly camera: DemuxedVideo | null,
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
    const support = await VideoDecoder.isConfigSupported(video.config).catch((e: Error) => ({ supported: false, reason: e.message }));
    if (!support.supported) {
      throw new Error(`This system cannot decode the screen video (codec ${video.config.codec}, ${video.width}x${video.height}). For HEVC, install "HEVC Video Extensions" from the Microsoft Store or use a GPU with HEVC decoding.`);
    }
    const camera = await openCamera(opened);
    const c = new EditorController(opened, video, camera, compositor);
    await c.cursors.preload();
    if (!opened.hasHoverData) void c.analyseHoversInBackground();
    return c;
  }

  hoverAnalysis: 'idle' | 'running' | 'done' | 'failed' = 'idle';
  private analysisAbort = new AbortController();

  // Finds hover moments in the video once, saves them in the bundle and re-plans the cursor.
  private async analyseHoversInBackground(): Promise<void> {
    this.hoverAnalysis = 'running';
    this.listeners.forEach((l) => l());
    try {
      const times = await analyseHovers(this.project.recording, this.video, undefined, this.analysisAbort.signal);
      await window.recorder.saveHoverChanges(this.project.path, times);
      this.opened.hoverChangeTimes = times;
      this.hoverAnalysis = 'done';
      this.changed(false);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.hoverAnalysis = 'failed';
      toast('Hover analysis failed', { tone: 'error', description: `The cursor still lands on clicks; hover highlights are not synced. ${(err as Error).message}` });
    }
  }

  get durationMs(): number {
    return this.scene.playbackDurationMs;
  }

  private cursorKey = '';

  private buildScene(): Scene {
    const key = cursorModelKey(this.project, this.opened.hoverChangeTimes);
    const reuse = this.scene && key === this.cursorKey ? this.scene.cursor : undefined;
    this.cursorKey = key;
    return new Scene(this.project, { hasCamera: this.camera !== null, hoverChangeTimes: this.opened.hoverChangeTimes, cursor: reuse });
  }

  // ---- Preview canvas ----

  async attachCanvas(canvas: HTMLCanvasElement): Promise<void> {
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU canvas is not available.');
    this.player?.destroy();
    this.canvas = canvas;
    const player = new Player(canvas, ctx, this.scene, this.compositor, this.cursors, this.video, this.camera, this.opened.mediaBase);
    this.player = player;
    player.onTime = (t) => {
      this.playback = { timeMs: t, playing: player.isPlaying };
      this.playbackListeners.forEach((l) => l());
    };
    this.backgroundKey = null;
    await this.syncBackgroundImage();
    this.lutKey = null;
    await this.syncCameraLut();
    const problems = await player.loadAudio();
    for (const p of problems) toast('Audio track skipped', { tone: 'error', description: p });
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
      const sources = { scene: this.scene, compositor: this.compositor, cursors: this.cursors, video: this.video, camera: this.camera, mediaBase: this.opened.mediaBase };
      if (settings.format === 'gif') await exportGif(sources, settings, onProgress, signal);
      else await exportProject(sources, settings, onProgress, signal);
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

  // ---- Clips (slices): trim, cut, speed ----

  setSlices(slices: Slice[], final = true): void {
    this.project.slices = slices.map((s) => ({ ...s }));
    this.changed(final);
    if (this.playback.timeMs > this.durationMs) this.seek(this.durationMs);
  }

  // Splits the clip under the playhead in two. Returns false if the playhead is too close to a
  // clip edge.
  splitAt(playbackMs: number): boolean {
    const link = this.scene.cursor.timeMap.linkAtPlayback(playbackMs);
    if (!link) return false;
    const cut = link.playbackToSource(playbackMs);
    if (cut - link.sourceStartMs < MIN_CLIP_MS || link.sourceEndMs - cut < MIN_CLIP_MS) return false;
    const s = this.project.slices;
    const i = link.index;
    this.setSlices([...s.slice(0, i), { ...s[i], sourceEndMs: cut }, { ...s[i], sourceStartMs: cut }, ...s.slice(i + 1)]);
    return true;
  }

  // Removes a clip from the edit (its part of the recording is cut). The last clip stays.
  deleteSlice(index: number): boolean {
    if (this.project.slices.length <= 1) return false;
    this.setSlices(this.project.slices.filter((_, i) => i !== index));
    return true;
  }

  updateSlice(index: number, patch: Partial<Slice>, final = true): void {
    this.setSlices(
      this.project.slices.map((s, i) => (i === index ? { ...s, ...patch } : s)),
      final,
    );
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

  // Keeps the compositor's background texture in sync with the config.
  private backgroundKey: string | null = null;
  private async syncBackgroundImage(): Promise<void> {
    const bg = this.project.config.styles.background;
    const key = bg.type === 'image' && bg.imagePath ? bg.imagePath : null;
    if (key === this.backgroundKey) return;
    this.backgroundKey = key;
    if (!key) return;
    try {
      const r = await fetch(this.opened.mediaBase + key.split('/').map(encodeURIComponent).join('/'));
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${key}`);
      this.compositor.setBackgroundImage(await createImageBitmap(await r.blob()));
      this.player?.setScene(this.scene);
    } catch (err) {
      toast('Background image could not be loaded', { tone: 'error', description: (err as Error).message });
    }
  }

  // Keeps the compositor's webcam LUT in sync with the config.
  private lutKey: string | null = null;
  private async syncCameraLut(): Promise<void> {
    const key = this.project.config.camera.lutPath;
    if (key === this.lutKey) return;
    this.lutKey = key;
    if (!key) {
      this.compositor.setCameraLut(null);
      return;
    }
    try {
      const r = await fetch(this.opened.mediaBase + key.split('/').map(encodeURIComponent).join('/'));
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${key}`);
      this.compositor.setCameraLut(parseCube(await r.text()));
      this.player?.setScene(this.scene);
    } catch (err) {
      this.compositor.setCameraLut(null);
      toast('Camera LUT could not be loaded', { tone: 'error', description: `${key}: ${(err as Error).message}` });
    }
  }

  async chooseCameraLut(): Promise<void> {
    const rel = await window.recorder.chooseCameraLut(this.project.path);
    if (rel) this.updateConfig((c) => (c.camera.lutPath = rel));
  }

  async chooseBackgroundImage(): Promise<void> {
    const rel = await window.recorder.chooseBackgroundImage(this.project.path);
    if (!rel) return;
    this.updateConfig((c) => {
      c.styles.background.type = 'image';
      c.styles.background.imagePath = rel;
    });
  }

  private changed(final: boolean): void {
    void this.syncBackgroundImage();
    void this.syncCameraLut();
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
    this.analysisAbort.abort();
    this.detachCanvas();
    this.listeners.clear();
    this.playbackListeners.clear();
  }
}

// The webcam track, if the recording has one this system can decode. A webcam that cannot be
// shown is not fatal: the project still opens, without the camera bubble.
async function openCamera(opened: OpenedProject): Promise<DemuxedVideo | null> {
  const track = opened.project.recording.webcam[0];
  if (!track) return null;
  try {
    const camera = await demuxVideo(opened.mediaBase, track);
    const support = await VideoDecoder.isConfigSupported(camera.config);
    if (!support.supported) throw new Error(`codec ${camera.config.codec} (${camera.width}x${camera.height}) is not supported by this system's decoder`);
    return camera;
  } catch (err) {
    toast('Webcam not shown', { tone: 'error', description: `The webcam video could not be read: ${(err as Error).message}` });
    return null;
  }
}
