import { describe, expect, it } from 'vitest';
import { Layout, avoidCameraTarget } from '../../src/core/camera/layout';
import { Rect } from '../../src/core/geometry/rect';

const base = { sourceSize: { width: 1728, height: 1117 }, aspectRatio: 'auto' as const, paddingRatio01: 0.1, avoidEmptyZoomArea: false, camera: null };

describe('layout', () => {
  it('pads by min(w,h)/12 for ratio 0.1 (shrink divides by 1.2)', () => {
    const r = new Rect({ width: 1920, height: 1080 }).padByRatio(-0.1);
    expect(r.x).toBeCloseTo(90);
    expect(r.height).toBeCloseTo(900);
  });

  it('auto stage aspect is the source padded by +ratio, height 1080', () => {
    const l = new Layout(base);
    expect(l.stage.height).toBe(1080);
    const padded = new Rect({ width: 1728, height: 1117 }).padByRatio(0.1);
    expect(l.stage.aspectRatio).toBeCloseTo(padded.aspectRatio, 9);
  });

  it('zoom 1 screen rect equals the initial fitted rect; zoom 2 doubles and stays inside the area', () => {
    const l = new Layout(base);
    const r1 = l.getScreenRect({ x: 0.5, y: 0.5 }, 1);
    expect(r1.width).toBeCloseTo(l.initialScreenRect.width);
    expect(r1.x).toBeCloseTo(l.initialScreenRect.x);
    const r2 = l.getScreenRect({ x: 0, y: 0 }, 2);
    expect(r2.width).toBeCloseTo(l.initialScreenRect.width * 2);
    // Corner focus clamps so the zoomed screen still covers the zoom area.
    expect(r2.x).toBeCloseTo(l.zoomArea.x);
    expect(r2.y).toBeCloseTo(l.zoomArea.y);
  });

  it('steers the zoom target away from an overlapping webcam bubble', () => {
    const area = { x: 0, y: 0, width: 1000, height: 1000 };
    expect(avoidCameraTarget(area, null)).toEqual({ x: 500, y: 500 });
    const t = avoidCameraTarget(area, { x: 400, y: 400, width: 600, height: 600 });
    expect(t.x < 400 || t.y < 400).toBe(true);
  });
});
