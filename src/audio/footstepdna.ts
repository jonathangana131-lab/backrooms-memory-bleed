/**
 * Footstep DNA for BACKROOMS: MEMORY BLEED.
 *
 * Every entity archetype leaves a gait signature you can learn BEFORE
 * line of sight: how fast it walks (step interval), how steady that
 * interval is held, and where the step's energy sits in the spectrum
 * (a heavy low thud vs a dry mid click vs a bright scrape). This module
 * synthesizes those per-archetype signatures from seeded parameters and
 * runs an online nearest-centroid classifier over accumulated step
 * observations, so the game can whisper what is coming down the hall
 * while it is still only a sound.
 *
 * The classifier never sees line of sight, distance, or any spawn
 * state - its only input is the step observation itself (interval plus
 * spectral balance), which is what makes "identified before LOS" a
 * property of the data rather than of a gate.
 *
 * Pure math + bookkeeping; no Web Audio, no Babylon. Determinism comes
 * exclusively from src/core/rng.ts.
 */

import type { HumanType } from '../entities/humans';
import { RNG, seedFromString } from '../core/rng';

/** All archetypes the DNA table knows, matching EntityHuman types. */
export const ARCHETYPES: readonly HumanType[] = [
  'watcher', 'wanderer', 'helper', 'incomplete', 'believer', 'double',
];

/** One observed footfall: timing plus spectral balance of the burst. */
export interface StepObservation {
  /** Seconds since this entity's previous footfall. */
  readonly interval: number;
  /** Fraction of step energy below ~250 Hz (weight). */
  readonly low: number;
  /** Fraction of step energy in the mid band (~250-2 kHz). */
  readonly mid: number;
  /** Fraction of step energy above ~2 kHz (click/scrape brightness). */
  readonly high: number;
}

/**
 * Seeded gait parameters for one archetype. Base values are the
 * archetype's body truth; `seedDrift` shifts them slightly per world
 * seed so signatures stay consistent within a run but vary across one.
 */
interface GaitSignature {
  /** Nominal seconds per step. */
  interval: number;
  /** Gaussian jitter sigma on the interval, in seconds. */
  jitter: number;
  /** Nominal spectral fractions; they always renormalize to sum 1. */
  low: number;
  mid: number;
  high: number;
  /** Max fractional drift the world seed may apply to each parameter. */
  readonly seedDrift: number;
}

/** Archetype body truths. Gaps between archetypes must exceed jitter. */
const BASE_GAIT: Record<HumanType, GaitSignature> = {
  // Heavy tread, slow, all weight - the sound of something that never hurries.
  watcher: { interval: 0.62, jitter: 0.045, low: 0.62, mid: 0.28, high: 0.10, seedDrift: 0.02 },
  // An ordinary human walking an ordinary hallway.
  wanderer: { interval: 0.48, jitter: 0.04, low: 0.38, mid: 0.46, high: 0.16, seedDrift: 0.03 },
  // Soft-soled staff shoes, unhurried and metronome-steady, heavily muffled.
  helper: { interval: 0.56, jitter: 0.03, low: 0.74, mid: 0.22, high: 0.04, seedDrift: 0.02 },
  // A dragging, uneven limp - slow with wide scatter.
  incomplete: { interval: 0.75, jitter: 0.13, low: 0.48, mid: 0.37, high: 0.15, seedDrift: 0.04 },
  // Quick, light, bright - running to something it thinks is salvation.
  believer: { interval: 0.43, jitter: 0.06, low: 0.26, mid: 0.38, high: 0.36, seedDrift: 0.03 },
  // Copies YOUR stride exactly: player cadence, dry close thud, metronome.
  double: { interval: 0.52, jitter: 0.02, low: 0.58, mid: 0.32, high: 0.10, seedDrift: 0.01 },
};

/**
 * Steps to average before trusting a call. Single footfalls overlap
 * between near archetypes; a body reveals itself over a short phrase,
 * which is exactly how long a listener needs before line of sight.
 */
export const CLASSIFY_WINDOW = 6;

/** Max per-body deviation from the archetype signature (real bodies differ). */
const BODY_DRIFT_INTERVAL = 0.015;
const BODY_DRIFT_BAND = 0.02;

/** Fixed feature scales so Euclidean distance weighs timing vs spectrum sanely. */
const INTERVAL_SCALE = 0.1;
const BAND_SCALE = 0.25;

/** Dimension count of the normalized feature space. */
const FEATURE_DIMS = 4;

/**
 * Normalized feature vector for one observation.
 * @param obs raw step observation (interval + spectral fractions)
 * @returns fixed-length vector; callers treat it as read-only
 */
function featuresOf(obs: StepObservation): number[] {
  return [
    obs.interval / INTERVAL_SCALE,
    obs.low / BAND_SCALE,
    obs.mid / BAND_SCALE,
    obs.high / BAND_SCALE,
  ];
}

/**
 * Per-world-seed gait signature for an archetype.
 * @param type archetype name
 * @param seed world seed; same seed always yields the same signature
 * @returns the seeded signature used for synthesis
 */
export function gaitSignature(type: HumanType, seed: number): GaitSignature {
  const base = BASE_GAIT[type];
  const rng = new RNG(seedFromString(type) ^ seed);
  const d = base.seedDrift;
  return {
    interval: base.interval * (1 + rng.range(-d, d)),
    jitter: Math.max(0.005, base.jitter * (1 + rng.range(-d, d))),
    low: base.low * (1 + rng.range(-d, d)),
    mid: base.mid * (1 + rng.range(-d, d)),
    high: base.high * (1 + rng.range(-d, d)),
    seedDrift: base.seedDrift,
  };
}

/** Standard normal sample via Box-Muller from two uniforms. */
function gauss(rng: RNG): number {
  const u = Math.max(rng.next(), 1e-12);
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Synthesize one realistic footfall for an archetype.
 * @param sig seeded signature (see gaitSignature)
 * @param rng shared random stream driving the jitter
 * @returns an observation with jittered interval and rebalanced spectrum
 */
export function synthesizeStep(sig: GaitSignature, rng: RNG): StepObservation {
  const interval = Math.max(0.05, sig.interval + gauss(rng) * sig.jitter);
  let low = Math.max(0.01, sig.low + gauss(rng) * 0.03);
  let mid = Math.max(0.01, sig.mid + gauss(rng) * 0.03);
  let high = Math.max(0.01, sig.high + gauss(rng) * 0.02);
  const norm = low + mid + high;
  low /= norm; mid /= norm; high /= norm;
  return { interval, low, mid, high };
}

/**
 * Synthesize a footstep train for an archetype.
 * @param type archetype name
 * @param seed world seed (also picks the individual's sub-seed stream)
 * @param count steps to generate
 * @param individual optional per-individual index; distinct individuals
 *                   get distinct jitter streams, like separate bodies
 * @returns exactly `count` observations
 */
export function synthesizeTrain(
  type: HumanType,
  seed: number,
  count: number,
  individual = 0,
): StepObservation[] {
  const base = gaitSignature(type, seed);
  // Each body is a slightly different instrument: small personal offsets
  // on top of the archetype signature, fixed for that body's lifetime.
  const body = new RNG(seedFromString(`${type}#${individual}`) ^ (seed ^ 0x5bd1e995));
  const sig: GaitSignature = {
    ...base,
    interval: base.interval * (1 + body.range(-BODY_DRIFT_INTERVAL, BODY_DRIFT_INTERVAL)),
    jitter: Math.max(0.004, base.jitter * (1 + body.range(-0.2, 0.2))),
    low: Math.max(0.01, base.low + body.range(-BODY_DRIFT_BAND, BODY_DRIFT_BAND)),
    mid: Math.max(0.01, base.mid + body.range(-BODY_DRIFT_BAND, BODY_DRIFT_BAND)),
    high: Math.max(0.01, base.high + body.range(-BODY_DRIFT_BAND, BODY_DRIFT_BAND)),
  };
  const rng = new RNG(seedFromString(`${type}@${individual}:steps`) ^ seed);
  const out: StepObservation[] = [];
  for (let i = 0; i < count; i++) out.push(synthesizeStep(sig, rng));
  return out;
}

/** Result of a nearest-centroid classification. */
export interface Classification {
  /** Best-matching archetype, or null before any observation arrived. */
  readonly type: HumanType | null;
  /** Normalized distance to the winning centroid (smaller = closer). */
  readonly distance: number;
  /** Margin over the runner-up, 0..1; 0 means an ambiguous call. */
  readonly confidence: number;
}

/**
 * Online nearest-centroid classifier over accumulated step observations.
 * Feed observe() as steps are heard; classify() names the walker. There
 * is deliberately no LOS, distance, or identity input anywhere in this
 * class - identification must be possible from sound alone.
 */
export class FootstepDNA {
  private readonly seed: number;
  /** Running mean feature vector per observed archetype. */
  private readonly centroids = new Map<HumanType, number[]>();
  /** Observation counts per archetype (for the running mean). */
  private readonly counts = new Map<HumanType, number>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** World seed the classifier was constructed with. */
  get worldSeed(): number {
    return this.seed;
  }

  /**
   * Accumulate one heard footfall into the archetype's centroid.
   * @param type ground-truth archetype of the stepping entity
   * @param obs the observed footfall
   */
  observe(type: HumanType, obs: StepObservation): void {
    const f = featuresOf(obs);
    const c = this.centroids.get(type);
    if (!c) {
      this.centroids.set(type, f.slice());
      this.counts.set(type, 1);
      return;
    }
    const n = (this.counts.get(type) ?? 0) + 1;
    for (let i = 0; i < FEATURE_DIMS; i++) c[i] += (f[i] - c[i]) / n;
    this.counts.set(type, n);
  }

  /** Steps accumulated for an archetype so far. */
  observedCount(type: HumanType): number {
    return this.counts.get(type) ?? 0;
  }

  /** True once at least one archetype has any accumulated evidence. */
  get known(): boolean {
    return this.centroids.size > 0;
  }

  /**
   * Copy of an archetype's current centroid, or null if unobserved.
   * @param type archetype to read
   */
  centroid(type: HumanType): readonly number[] | null {
    const c = this.centroids.get(type);
    return c ? c.slice() : null;
  }

  /**
   * Nearest-centroid classification of one footfall.
   * @param obs the observed footfall (sound features only)
   * @returns best match with margin-based confidence; null type until
   *          at least one observe() call has landed
   */
  classify(obs: StepObservation): Classification {
    if (this.centroids.size === 0) {
      return { type: null, distance: Infinity, confidence: 0 };
    }
    const f = featuresOf(obs);
    let best: HumanType | null = null;
    let bestD = Infinity;
    let secondD = Infinity;
    for (const [type, c] of this.centroids) {
      let d = 0;
      for (let i = 0; i < FEATURE_DIMS; i++) {
        const e = f[i] - c[i];
        d += e * e;
      }
      d = Math.sqrt(d);
      if (d < bestD) {
        secondD = bestD;
        bestD = d;
        best = type;
      } else if (d < secondD) {
        secondD = d;
      }
    }
    const confidence = secondD === Infinity ? 1
      : (secondD - bestD) / (secondD + bestD + 1e-9);
    return { type: best, distance: bestD, confidence };
  }

  /**
   * Classify a short run of footfalls as one call by averaging their
   * features first - how a listener separates near archetypes (the
   * player-mimicking double from a tired wanderer) before seeing them.
   * @param window consecutive observations from one body, in order
   * @returns classification of the averaged observation
   */
  classifyWindow(window: readonly StepObservation[]): Classification {
    if (window.length === 0) {
      return { type: null, distance: Infinity, confidence: 0 };
    }
    let interval = 0;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (const obs of window) {
      interval += obs.interval;
      low += obs.low;
      mid += obs.mid;
      high += obs.high;
    }
    const n = window.length;
    return this.classify({ interval: interval / n, low: low / n, mid: mid / n, high: high / n });
  }
}
