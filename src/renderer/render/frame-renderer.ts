// Draws one frame of a project at a playback time. Shared by the preview and the exporter so
// both go through exactly the same code.

import { StyleTimeline } from '../../core/animation/timeline';
import { buildFrameInputs, type QualityOptions } from '../../core/scene/frame-inputs';
import type { Scene } from '../../core/scene/scene';
import type { Compositor } from '../gpu/compositor';
import type { CursorImages } from '../media/cursor-images';

export class FrameRenderer {
  readonly timeline: StyleTimeline;

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
    const prev = this.timeline.previousFrameStyle(playbackMs);
    const cursor = this.cursors.get(this.scene.cursor.cursorIdAt(sourceMs));
    if (cursor) this.compositor.setCursorImage(cursor.id, cursor.bitmap);
    const display = this.scene.project.recording.displayBounds;
    const videoSize = this.compositor.screenSize ?? { width: display.width, height: display.height };
    const inputs = buildFrameInputs(this.scene, now, prev, cursor?.info ?? null, this.quality, sourceMs, videoSize);
    this.compositor.render(target, inputs, target.height / inputs.stage.height);
  }
}
