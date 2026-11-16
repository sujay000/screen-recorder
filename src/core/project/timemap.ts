// Playback time <-> source (recording) time through the project's slices (trims, cuts, speed).

import type { Slice } from './model';

export interface SliceLink {
  slice: Slice;
  index: number;
  playbackStartMs: number;
  playbackEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  playbackToSource(t: number): number;
  sourceToPlayback(t: number): number;
}

export class TimeMap {
  readonly links: SliceLink[];
  readonly playbackDurationMs: number;

  constructor(slices: Slice[]) {
    let acc = 0;
    this.links = slices.map((s, index) => {
      const len = (s.sourceEndMs - s.sourceStartMs) / s.timeScale;
      const start = acc;
      acc += len;
      return {
        slice: s,
        index,
        playbackStartMs: start,
        playbackEndMs: start + len,
        sourceStartMs: s.sourceStartMs,
        sourceEndMs: s.sourceEndMs,
        playbackToSource: (t: number) => s.sourceStartMs + (t - start) * s.timeScale,
        sourceToPlayback: (t: number) => start + (t - s.sourceStartMs) / s.timeScale,
      };
    });
    this.playbackDurationMs = acc;
  }

  linkAtPlayback(t: number): SliceLink | null {
    if (this.links.length === 0) return null;
    for (const l of this.links) if (t >= l.playbackStartMs && t < l.playbackEndMs) return l;
    return t < 0 ? this.links[0] : this.links[this.links.length - 1];
  }

  playbackToSource(t: number): number {
    const l = this.linkAtPlayback(t);
    return l ? l.playbackToSource(Math.min(t, l.playbackEndMs)) : t;
  }

  sliceAtSource(t: number): Slice | null {
    for (const l of this.links) if (t >= l.sourceStartMs && t <= l.sourceEndMs) return l.slice;
    return null;
  }
}
