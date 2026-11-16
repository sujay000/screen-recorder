// Loads the cursor images saved with a recording (recording/cursors/<id>.png + cursors.json)
// and measures each glyph, so the drawn cursor can be sized like the reference (cursor.md §1.3).

import type { CursorInfo } from '../../core/project/model';
import type { CursorImageInfo } from '../../core/scene/frame-inputs';

export interface LoadedCursor {
  id: string;
  bitmap: ImageBitmap;
  info: CursorImageInfo;
}

// Visible box = bounding box of pixels whose alpha is at least the mean alpha of all non-empty
// pixels.
function measureVisibleHeight01(bitmap: ImageBitmap): number {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = c.getContext('2d')!;
  g.drawImage(bitmap, 0, 0);
  const { data } = g.getImageData(0, 0, bitmap.width, bitmap.height);
  let sum = 0;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) {
      sum += data[i];
      n++;
    }
  }
  if (n === 0) return 1;
  const mean = sum / n;
  let top = bitmap.height;
  let bottom = -1;
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (data[(y * bitmap.width + x) * 4 + 3] >= mean) {
        if (y < top) top = y;
        bottom = y;
        break;
      }
    }
  }
  return bottom < top ? 1 : (bottom - top + 1) / bitmap.height;
}

export class CursorImages {
  private loaded = new Map<string, LoadedCursor>();
  private failed = new Set<string>();

  constructor(
    private readonly mediaBase: string,
    private readonly cursors: CursorInfo[],
  ) {}

  async preload(): Promise<void> {
    await Promise.all(this.cursors.map((c) => this.load(c.id)));
  }

  private async load(id: string): Promise<LoadedCursor | null> {
    const hit = this.loaded.get(id);
    if (hit || this.failed.has(id)) return hit ?? null;
    const meta = this.cursors.find((c) => c.id === id);
    if (!meta) {
      this.failed.add(id);
      return null;
    }
    try {
      const r = await fetch(`${this.mediaBase}cursors/${encodeURIComponent(id)}.png`);
      if (!r.ok) throw new Error(String(r.status));
      const bitmap = await createImageBitmap(await r.blob());
      const info: CursorImageInfo = {
        aspect: bitmap.width / bitmap.height,
        hotspot01: { x: meta.hotSpot.x / meta.standardSize.width, y: meta.hotSpot.y / meta.standardSize.height },
        visibleHeight01: measureVisibleHeight01(bitmap),
      };
      const l = { id, bitmap, info };
      this.loaded.set(id, l);
      return l;
    } catch {
      this.failed.add(id);
      return null;
    }
  }

  // Falls back to the arrow (and then any loaded image) when a shape has no image.
  get(id: string): LoadedCursor | null {
    return this.loaded.get(id) ?? this.loaded.get('arrow') ?? this.loaded.values().next().value ?? null;
  }
}
