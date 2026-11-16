// Mass-spring-damper matching the reference behaviour (spec: zoom-camera.md §6).
// Fixed 1 ms semi-implicit Euler substeps, optional anti-overshoot clamp, per-value precision,
// precomputed settle time. The last substep of an advance uses (ceil(dt) - dt) as its step:
// that quirk is intentional, it is what the reference integrator does.

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  clamp?: boolean;
  precision?: number;
}

export interface ResolvedSpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  clamp: boolean;
  precision: number;
}

export const DEFAULT_SPRING: ResolvedSpringConfig = { stiffness: 125, damping: 12, mass: 1.5, clamp: true, precision: 0.002 };

export const SPRING_PRESETS = {
  default: { stiffness: 125, damping: 12, mass: 1.5 },
  smooth: { stiffness: 470, damping: 70, mass: 3 }, // cursor "Smooth"
  medium: { stiffness: 340, damping: 60, mass: 3 }, // cursor "Medium", also fades
  rapid: { stiffness: 530, damping: 40, mass: 1 },
  screenSmooth: { stiffness: 170, damping: 50, mass: 3 },
  screenFocused: { stiffness: 250, damping: 40, mass: 2.25 },
  typingFade: { stiffness: 600, damping: 50, mass: 1 },
  instant: { stiffness: 1, damping: 1, mass: 0 },
} satisfies Record<string, SpringConfig>;

export function resolveSpring(c: SpringConfig | null | undefined): ResolvedSpringConfig {
  return { ...DEFAULT_SPRING, ...(c ?? {}) };
}

// Critical damping when moving toward the target faster than |distance| * sqrt(k/m).
function clampedDamping(k: number, m: number, c: number, x: number, v: number, target: number): number {
  const d = target - x;
  if (!(v * d > 0)) return c;
  if (Math.abs(v) <= Math.abs(d) * Math.sqrt(k / m)) return c;
  return Math.max(c, Math.sqrt(m * k) * 2);
}

// Advances (x, v) toward target by dtMs. Returns [x, v].
export function integrate(
  dtMs: number,
  x: number,
  v: number,
  target: number,
  k: number,
  c: number,
  m: number,
  clamp: boolean,
  precision: number,
): [number, number] {
  if (clamp) c = clampedDamping(k, m, c, x, v, target);
  const n = Math.ceil(dtMs);
  if (n > 10000) throw new Error('Spring emulation is too long');
  for (let i = 1; i <= n; i++) {
    const h = i > dtMs ? (i - dtMs) / 1000 : 0.001;
    const a = (-(x - target) * k + -v * c) / m;
    const nv = v + a * h;
    const nx = x + nv * h;
    if (Math.abs(nv) < precision && Math.abs(nx - target) < precision) {
      return [target, 0];
    }
    x = nx;
    v = nv;
  }
  return [x, v];
}

export function precisionFor(value: number, target: number, precision: number): number {
  if (value === target) return 1;
  return Math.max(1, Math.abs(value - target)) * precision;
}

const settleCache = new Map<string, number>();

// Time for a 0 -> 1000 move to come to rest, simulated with the coarse step used by the reference.
export function settleTime(cfg: ResolvedSpringConfig): number {
  if (cfg.mass === 0) return 0;
  const key = `${cfg.stiffness}|${cfg.damping}|${cfg.mass}|${cfg.clamp}|${cfg.precision}`;
  const hit = settleCache.get(key);
  if (hit !== undefined) return hit;
  const frame = 1000 / 60;
  const step = (frame / 1000) * Math.max(Math.sqrt(cfg.stiffness / cfg.mass), cfg.damping / cfg.mass) <= 0.5 ? frame : 1;
  const p = precisionFor(0, 1000, cfg.precision);
  let x = 0;
  let v = 0.000001;
  let total = 0;
  while (x !== 1000 && v !== 0) {
    const h = step / 1000;
    const nv = v + ((-(x - 1000) * cfg.stiffness + -v * cfg.damping) / cfg.mass) * h;
    const nx = x + nv * h;
    if (Math.abs(nv) < p && Math.abs(nx - 1000) < p) {
      x = 1000;
      v = 0;
    } else {
      x = nx;
      v = nv;
    }
    if (Number.isNaN(x) || Number.isNaN(v)) break;
    total += step;
    if (total > 20000) break;
  }
  settleCache.set(key, total);
  return total;
}

// Spring over a flat record of numbers. Each key is an independent 1D spring with its own
// precision; non-numeric values are not supported (styles are flattened by the caller).
export class RecordSpring {
  time = 0;
  value: Record<string, number>;
  private velocity: Record<string, number> = {};
  private target: Record<string, number>;
  private precision: Record<string, number> = {};
  private config: Record<string, ResolvedSpringConfig> = {};

  constructor(initial: Record<string, number>) {
    this.value = { ...initial };
    this.target = { ...initial };
    for (const k of Object.keys(initial)) {
      this.velocity[k] = 0;
      this.precision[k] = 1;
    }
  }

  get isAtRest(): boolean {
    for (const k of Object.keys(this.value)) {
      if (this.value[k] !== this.target[k] || this.velocity[k] !== 0) return false;
    }
    return true;
  }

  setTarget(target: Record<string, number>, configFor: (key: string) => ResolvedSpringConfig): void {
    for (const k of Object.keys(target)) {
      const t = target[k];
      if (!Number.isFinite(t)) throw new Error(`Invalid target for ${k}`);
      if (!(k in this.value)) {
        this.value[k] = t;
        this.velocity[k] = 0;
        this.precision[k] = 1;
        this.target[k] = t;
      }
      const cfg = configFor(k);
      if (this.target[k] !== t) {
        this.precision[k] = precisionFor(this.value[k], t, cfg.precision);
        this.target[k] = t;
      }
      this.config[k] = cfg;
    }
  }

  advanceTo(timeMs: number): void {
    const dt = timeMs - this.time;
    if (dt === 0) return;
    if (dt < 0) throw new Error("Can't go back in time");
    this.time = timeMs;
    for (const k of Object.keys(this.value)) {
      const x = this.value[k];
      const v = this.velocity[k];
      const t = this.target[k];
      if (x === t && v === 0) continue;
      const cfg = this.config[k] ?? DEFAULT_SPRING;
      if (dt >= settleTime(cfg) || cfg.mass === 0) {
        this.value[k] = t;
        this.velocity[k] = 0;
        continue;
      }
      const [nx, nv] = integrate(dt, x, v, t, cfg.stiffness, cfg.damping, cfg.mass, cfg.clamp, this.precision[k]);
      this.value[k] = nx;
      this.velocity[k] = nv;
    }
  }

  snapToTarget(): void {
    for (const k of Object.keys(this.value)) {
      this.value[k] = this.target[k];
      this.velocity[k] = 0;
    }
  }
}
