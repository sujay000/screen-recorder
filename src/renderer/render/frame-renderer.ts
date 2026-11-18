// Draws one frame of a project at a playback time. Shared by the preview and the exporter so
// both go through exactly the same code.

import { StyleTimeline } from '../../core/animation/timeline';
import { buildFrameInputs, type QualityOptions } from '../../core/scene/frame-inputs';
import type { Scene } from '../../core/scene/scene';
import type { Compositor } from '../gpu/compositor';
import type { CursorImages } from '../media/cursor-images';
import { KeycapCanvas } from './keycap-overlay';

export class FrameRenderer {
  readonly timeline: StyleTimeline;
  private readonly keycaps = new KeycapCanvas();

  constructor(
    readonly scene: Scene,
    readonly compositor: Compositor,
    readonly cursors: CursorImages,
    readonly quality: QualityOptions,
  ) {
    this.timeline = new StyleTimeline(scene, quality.fps);
  }

  // The caller uploads the matching screen frame to the compositor before calling this.
  draw(target: GPUTexture, playbackMs: number): void {
    const sourceMs = this.scene.cursor.timeMap.playbackToSource(playbackMs);
    const now = this.timeline.styleAt(playbackMs);
    // No motion blur across a cut: the previous frame shows a different part of the recording.
    const map = this.scene.cursor.timeMap;
    const acrossCut = map.linkAtPlayback(playbackMs) !== map.linkAtPlayback(playbackMs - 1000 / this.quality.fps);
    const prev = acrossCut ? now : this.timeline.previousFrameStyle(playbackMs);
    const cursor = this.cursors.get(this.scene.cursor.cursorIdAt(sourceMs));
    if (cursor) this.compositor.setCursorImage(cursor.id, cursor.bitmap);
    const display = this.scene.project.recording.displayBounds;
    const videoSize = this.compositor.screenSize ?? { width: display.width, height: display.height };
    const inputs = buildFrameInputs(this.scene, now, prev, cursor?.info ?? null, this.quality, sourceMs, videoSize);
    const caps = this.scene.shortcuts.capsAt(sourceMs, inputs.stage);
    const drawn = this.keycaps.draw(caps, inputs.stage, target.width, target.height, this.scene.project.config.shortcuts.sizeRatio);
    this.compositor.setOverlay(drawn ? this.keycaps.canvas : null);
    this.compositor.render(target, inputs, target.height / inputs.stage.height);
  }
}
