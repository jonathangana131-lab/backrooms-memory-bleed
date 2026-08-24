/**
 * Breathing wallpaper (F40): saturation-band vertex displacement.
 *
 * Inside memory-saturation bands the wallpaper breathes: vertices displace
 * along their normal by up to MAX_BREATH_DISPLACEMENT_M (~0.5 cm inhale),
 * scaled by d^2 where d is the band saturation [0..1], gated by a
 * smoothstep spatial falloff at the band edges, and phased by an injected
 * clock with a seeded drift around the ~4.2 s base period.
 *
 * Pure model -- no engine dependency. The mesher feeds world positions
 * (plus an injected band query) and gets back one displacement scalar in
 * meters; displacement(d, phase) and the smoothstep falloff are exported
 * for direct use.
 *
 * DETERMINISM: the breathing phase is a pure function of (seed, time);
 * the same seed always reproduces the same phase timeline, including the
 * seeded period drift. Junk inputs (NaN/Infinity anywhere) collapse to 0
 * displacement, never NaN.
 */

/** Peak inhale displacement at full saturation (meters). */
export const MAX_BREATH_DISPLACEMENT_M = 0.005;

/** Base breathing period (seconds); seeded drift wobbles around this. */
export const BASE_PERIOD_S = 4.2;

/** Amplitude of the seeded phase drift (radians). */
export const DRIFT_AMPLITUDE_RAD = 0.35;
/** Period of the seeded drift cycle (seconds). */
export const DRIFT_PERIOD_S = 37;
/** Salt separating wallbreath hashing from every other feature. */
export const WALL_BREATH_SALT = 0x3e4a;

// --- mirrored deterministic helpers (tiledisplace.ts precedent: local copy
// --- of src/core/rng.ts hash2i so the module stays dependency-free under
// --- direct node strip-types test imports; algorithm identical to the RNG law)

function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2i(x: number, y: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(x | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(y | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Standard smoothstep with clamped ends.
 * @param edge0 falloff start (weight 1 side)
 * @param edge1 falloff end (weight 0 side requires edge1 > edge0)
 * @param x evaluation point
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!Number.isFinite(edge0) || !Number.isFinite(edge1) || !Number.isFinite(x)) return 0;
  const span = edge1 - edge0;
  if (Math.abs(span) < 1e-12) return x < edge0 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / span));
  return t * t * (3 - 2 * t);
}

/** One breath cycle wave in [0..1]: 0 at exhale bottom, 1 at inhale peak. */
function breathWave(phaseRad: number): number {
  if (!Number.isFinite(phaseRad)) return 0;
  return 0.5 * (1 - Math.cos(phaseRad));
}

/**
 * Core displacement model for one vertex.
 * @param d band saturation [0..1] (junk collapses to 0)
 * @param phase breathing phase in radians
 * @returns displacement in meters, within [-epsilon .. MAX_BREATH_DISPLACEMENT_M * d^2]
 */
export function displacement(d: number, phase: number): number {
  if (!Number.isFinite(d) || !Number.isFinite(phase)) return 0;
  const dd = Math.min(1, Math.max(0, d));
  return MAX_BREATH_DISPLACEMENT_M * dd * dd * breathWave(phase);
}

/** One saturation band in world space (cylindrical around the band center). */
export interface SaturationBand {
  /** Band center X in meters. */
  centerX: number;
  /** Band center Z in meters. */
  centerZ: number;
  /** Fully-saturated core radius in meters. */
  radiusM: number;
  /** Smoothstep falloff width inside the boundary (meters). */
  edgeSoftnessM: number;
  /** Core saturation [0..1]. */
  saturation: number;
}

/** Injected band query. */
export interface BandQuery {
  /** Current saturation bands; order is irrelevant. */
  bands(): SaturationBand[];
}

/** Construction options; every field has a procedural default. */
export interface WallBreathConfig {
  /** Deterministic seed for the period drift. */
  seed?: number;
  /** Base period override in seconds (defaults to BASE_PERIOD_S). */
  periodS?: number;
  /** Injected clock returning elapsed seconds (defaults to () => 0). */
  clock?: () => number;
  /** Injected band query for spatial sampling. */
  bands?: BandQuery;
}

/**
 * Breathing-wallpaper model over an injected band field. The same seed
 * always reproduces the same phase timeline; instances hold no mutable
 * simulation state beyond the default clock accumulator.
 */
export class WallBreath {
  private readonly seed: number;
  private readonly periodS: number;
  private readonly clockFn: () => number;
  private readonly bandQuery: BandQuery | null;

  /** Seeded drift parameters, hashed once per instance. */
  private readonly driftPhase: number;
  private readonly driftFreqScale: number;

  private defaultNow = 0;

  constructor(config: WallBreathConfig = {}) {
    this.seed = (config.seed ?? 0) | 0;
    const p = config.periodS ?? BASE_PERIOD_S;
    this.periodS = Number.isFinite(p) ? Math.max(0.1, p) : BASE_PERIOD_S;
    this.clockFn = config.clock ?? (() => this.defaultNow);
    this.bandQuery = config.bands ?? null;
    this.driftPhase = (hash2i(this.seed, 0x11, WALL_BREATH_SALT) / 4294967296) * Math.PI * 2;
    // +/-25% drift-cycle speed variation, deterministic per seed
    this.driftFreqScale = 0.75 + 0.5 * (hash2i(this.seed, 0x22, WALL_BREATH_SALT) / 4294967296);
  }

  /**
   * Advance the default clock (callers injecting their own clock never
   * need this).
   * @param dt seconds to advance by
   */
  advance(dt: number): void {
    if (Number.isFinite(dt)) this.defaultNow += dt;
  }

  /**
   * Breathing phase at time t: base rotation around the ~4.2 s period plus
   * a bounded seeded sinusoidal drift ("~4.2 s +/- seed"). Pure function
   * of (seed, t).
   * @param t elapsed session seconds
   * @returns phase in radians
   */
  phaseAt(t: number): number {
    if (!Number.isFinite(t)) return 0;
    const base = (2 * Math.PI * t) / this.periodS;
    const drift =
      DRIFT_AMPLITUDE_RAD *
      Math.sin((2 * Math.PI * t * this.driftFreqScale) / DRIFT_PERIOD_S + this.driftPhase);
    return base + drift;
  }

  /**
   * Spatial weight of a band at distance dist from its center: 1 across
   * the saturated core, smoothstep down to exactly 0 AT the boundary
   * radius (and beyond).
   * @param band the band being sampled
   * @param dist distance from band center in meters
   * @returns weight in [0..1]
   */
  bandWeight(band: SaturationBand, dist: number): number {
    if (!band || !Number.isFinite(dist)) return 0;
    const radius = Number.isFinite(band.radiusM) ? Math.max(0, band.radiusM) : 0;
    const softness = Number.isFinite(band.edgeSoftnessM)
      ? Math.max(0, band.edgeSoftnessM)
      : 0;
    return 1 - smoothstep(radius - softness, radius, dist);
  }

  /**
   * Displacement for one vertex given explicit saturation + phase --
   * thin wrapper over displacement() kept on the class for consumers that
   * hold their own band field.
   * @param d band saturation [0..1]
   * @returns displacement in meters at the current injected-clock time
   */
  vertexDisplacement(d: number): number {
    return displacement(d, this.phaseAt(this.clockFn()));
  }

  /**
   * Full spatial sample: strongest band contribution at a world position.
   * Overlapping bands take the max (a single surface cannot breathe twice).
   * @param x world X in meters
   * @param z world Z in meters
   * @param t optional explicit time (defaults to the injected clock)
   * @returns displacement in meters, 0 outside every band or on junk input
   */
  sample(x: number, z: number, t?: number): number {
    if (!this.bandQuery || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const time = t === undefined ? this.clockFn() : t;
    const phase = this.phaseAt(time);
    let best = 0;
    for (const b of this.bandQuery.bands()) {
      if (!b || typeof b !== 'object') continue;
      const dx = x - b.centerX;
      const dz = z - b.centerZ;
      if (!Number.isFinite(dx) || !Number.isFinite(dz)) continue;
      const dist = Math.hypot(dx, dz);
      const sat = Number.isFinite(b.saturation) ? b.saturation : 0;
      best = Math.max(best, displacement(sat, phase) * this.bandWeight(b, dist));
    }
    return best;
  }
}
