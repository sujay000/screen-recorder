import { describe, expect, it } from 'vitest';
import { integrate, resolveSpring, settleTime, SPRING_PRESETS, RecordSpring } from '../../src/core/animation/spring';

describe('spring', () => {
  // The reference settle time steps at 1/60 s without the anti-overshoot clamp, so it is a
  // whole number of 60 fps frames.
  it('settle times use the reference coarse-step simulation', () => {
    expect(settleTime(resolveSpring(SPRING_PRESETS.default))).toBeCloseTo(1483.333, 2);
    expect(settleTime(resolveSpring(SPRING_PRESETS.screenSmooth))).toBeCloseTo(1833.333, 2);
    expect(settleTime(resolveSpring(SPRING_PRESETS.screenFocused))).toBeCloseTo(683.333, 2);
    expect(settleTime(resolveSpring(SPRING_PRESETS.smooth))).toBeCloseTo(900, 2);
  });

  it('instant (mass 0) springs settle immediately', () => {
    expect(settleTime(resolveSpring(SPRING_PRESETS.instant))).toBe(0);
  });

  it('last substep uses ceil(dt) - dt (reference quirk)', () => {
    const c = resolveSpring(SPRING_PRESETS.default);
    // 16.6667 ms frame: 16 full 1 ms steps then one step of 0.3333 ms -> same as integrating 16.3333 ms.
    const [a] = integrate(1000 / 60, 0, 0, 100, c.stiffness, c.damping, c.mass, false, 1e-9);
    let x = 0;
    let v = 0;
    for (let i = 0; i < 16; i++) [x, v] = integrate(1, x, v, 100, c.stiffness, c.damping, c.mass, false, 1e-9);
    [x] = integrate(1 / 3, x, v, 100, c.stiffness, c.damping, c.mass, false, 1e-9);
    // integrate(1/3) itself has ceil = 1 so its only step is (1 - 1/3) ms: compare against that.
    let y = 0;
    let w = 0;
    for (let i = 0; i < 16; i++) [y, w] = integrate(1, y, w, 100, c.stiffness, c.damping, c.mass, false, 1e-9);
    const h = (17 - 1000 / 60) / 1000;
    const acc = (-(y - 100) * c.stiffness - w * c.damping) / c.mass;
    const expected = y + (w + acc * h) * h;
    expect(a).toBeCloseTo(expected, 9);
    expect(x).not.toBeCloseTo(expected, 6);
  });

  it('clamped spring does not overshoot', () => {
    const s = new RecordSpring({ v: 0 });
    const cfg = resolveSpring(SPRING_PRESETS.default);
    s.setTarget({ v: 1000 }, () => cfg);
    let max = 0;
    for (let t = 16; t < 3000; t += 16) {
      s.advanceTo(t);
      max = Math.max(max, s.value.v);
    }
    expect(max).toBeLessThanOrEqual(1000);
    expect(s.value.v).toBe(1000);
  });
});
