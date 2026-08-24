/**
 * Procedural VHS degradation for BACKROOMS: MEMORY BLEED (F87).
 *
 * Camcorder playback degrades as the anomaly gets closer. The model is a
 * pure function over injected anomaly proximity p in [0, 1] evaluated per
 * frame: tracking-error line count, chroma bleed amount, and dropout
 * frequency all scale monotonically with p and stay inside published
 * bounds, so a render consumer can drive post-processing straight from
 * the returned descriptor without touching live world state.
 *
 * Magnitudes are anchored ramps through seeded band thresholds: the
 * threshold POSITIONS vary per seed (crossing them fires burst events),
 * but every magnitude is a non-decreasing interpolation between fixed
 * anchors, so monotonicity in p holds for every seed. Baseline p = 0
 * yields the exact clean signal: all artifacts zero, no band, no bursts.
 *
 * Burst events fire when p crosses a band threshold upward (anomalies
 * surging toward the camera); moving back down never fires, but retreating
 * below a threshold re-arms it, so a later surge crosses (and fires) again.
 * Each burst's intensity and duration derive deterministically from (seed,
 * bandIndex) via src/core/rng.ts hashes, and its decaying contribution
 * stays visible in burstBoost until it expires.
 *
 * Junk inputs cannot corrupt the stream: non-finite or out-of-range p
 * clamps into [0, 1] (NaN reads as the clean baseline), any frame index is
 * accepted, and junk p never mutates burst or band state — only finite
 * in-range proximity drives the crossing machine, so frames after junk
 * match an unpolluted instance exactly.
 *
 * Pure Node-testable: no DOM, no Babylon imports, no Date.now(), no
 * Math.random() (see test/vhsdegrade-test.mjs).
 */

import { hash2i } from '../core/rng';

// ---------------------------------------------------------------------------
// Bounds and design constants
// ---------------------------------------------------------------------------

/** Maximum simultaneous tracking-error lines at p = 1. */
export const TRACKING_LINES_MAX = 12;

/** Maximum dropout frequency at p = 1, dropouts per second. */
export const DROPOUT_RATE_MAX = 24;

/** Number of seeded burst bands. */
export const BAND_COUNT = 3;

/**
 * Salt so VHS draws never correlate with other features keyed on the
 * same session seed.
 */
const VHSDEGRADE_SALT = 0x57d5;

/** Magnitude anchors reached at each successive band threshold. */
const CHROMA_ANCHORS = [0.3, 0.6, 0.85] as const;
const JITTER_ANCHORS = [0.2, 0.5, 0.8] as const;

/** Threshold windows per band; windows are disjoint and ordered. */
const THRESHOLD_MIN = [0.22, 0.5, 0.76] as const;
const THRESHOLD_SPAN = 0.14;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One burst fired by crossing a seeded band threshold upward. */
export interface VhsBurst {
  /** Index of the crossed band (0-based, ascending with severity). */
  bandIndex: number;
  /** The exact threshold that was crossed. */
  threshold: number;
  /** Frame index at which the crossing was observed. */
  startFrame: number;
  /** Lifetime of the burst in frames (> 0). */
  durationFrames: number;
  /** Peak strength in (0, 1]; contributes to burstBoost while live. */
  intensity: number;
}

/** Bounded per-frame artifact descriptor for a render consumer. */
export interface VhsFrameDescriptor {
  /** Clamped proximity actually evaluated (in [0, 1]). */
  proximity: number;
  /** Highest band whose threshold p has reached (-1 = below all). */
  bandIndex: number;
  /** Tracking-error line count in [0, TRACKING_LINES_MAX]. */
  trackingErrorLines: number;
  /** Chroma bleed amount in [0, 1]. */
  chromaBleed: number;
  /** Dropout frequency in [0, DROPOUT_RATE_MAX] dropouts per second. */
  dropoutRatePerSec: number;
  /** Horizontal scanline jitter amount in [0, 1]. */
  scanlineJitter: number;
  /** True iff p is exactly 0: the signal is bit-clean. */
  cleanSignal: boolean;
  /** Bursts fired on this frame (empty unless a band was just crossed). */
  burstsFired: readonly VhsBurst[];
  /** Summed live-burst contribution in [0, 1] on this frame. */
  burstBoost: number;
}

// ---------------------------------------------------------------------------
// Monotone ramp core
// ---------------------------------------------------------------------------

/**
 * Piecewise-linear interpolation through (0, 0), the (threshold, anchor)
 * pairs, and (1, 1). Non-decreasing in p by construction for every seed,
 * because thresholds arrive sorted and anchors ascend.
 *
 * @param p Clamped proximity in [0, 1].
 * @param thresholds Ascending band thresholds.
 * @param anchors Magnitude anchors paired with the thresholds.
 * @returns Interpolated magnitude in [0, 1].
 */
function anchoredRamp(p: number, thresholds: readonly number[], anchors: readonly number[]): number {
  let loP = 0; let loV = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (p < thresholds[i]) {
      return loV + ((p - loP) / (thresholds[i] - loP)) * (anchors[i] - loV);
    }
    loP = thresholds[i]; loV = anchors[i];
  }
  return loV + ((p - loP) / (1 - loP || 1)) * (1 - loV);
}

/** Clamp arbitrary input proximity into [0, 1]; non-finite reads as 0. */
function clampProximity(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

// ---------------------------------------------------------------------------
// Degradation model
// ---------------------------------------------------------------------------

/**
 * The camcorder degradation model. One instance per camcorder session;
 * frame() is the only input point and tolerates arbitrary call patterns.
 */
export class VhsDegrade {
  private readonly seed: number;
  private readonly thresholds: number[];
  /** Bursts still contributing decayed intensity, newest last. */
  private liveBursts: VhsBurst[] = [];
  private lastBandIndex = -1;

  /**
   * @param seed Session seed; picks the band-threshold positions and all
   *   burst parameters.
   */
  constructor(seed: number) {
    this.seed = seed >>> 0;
    const s = (this.seed ^ VHSDEGRADE_SALT) >>> 0;
    this.thresholds = [];
    for (let i = 0; i < BAND_COUNT; i++) {
      const r = hash2i(i, s) / 4294967296;
      this.thresholds.push(THRESHOLD_MIN[i] + r * THRESHOLD_SPAN);
    }
  }

  /** The seeded band thresholds, ascending. */
  get bandThresholds(): readonly number[] {
    return this.thresholds.slice();
  }

  /**
   * Evaluate one frame of degradation at the given proximity. Base
   * artifacts depend only on p; burst bookkeeping advances with the p
   * sequence. Safe against junk p (clamped) and any frame index.
   *
   * @param p Anomaly proximity in [0, 1]; junk values clamp (NaN -> 0).
   * @param frameIndex Current frame counter (used for burst lifetimes).
   * @returns Bounded artifact descriptor for this frame.
   */
  frame(p: number, frameIndex: number): VhsFrameDescriptor {
    const prox = clampProximity(p);
    const f = Number.isFinite(frameIndex) ? frameIndex : 0;

    let bandIndex = -1;
    for (let i = 0; i < this.thresholds.length; i++) {
      if (prox >= this.thresholds[i]) bandIndex = i; else break;
    }

    // Fire exactly one burst per threshold crossed upward since the last
    // trusted frame. Band tracking follows the previous trusted frame (not
    // the historical maximum), so retreating below a threshold re-arms it.
    // Junk p evaluates base artifacts but never touches burst state, so
    // frames after junk match an unpolluted instance exactly.
    const trusted = Number.isFinite(p) && p >= 0 && p <= 1;
    const burstsFired: VhsBurst[] = [];
    if (trusted) {
      for (let i = this.lastBandIndex + 1; i <= bandIndex; i++) {
        const h = hash2i(i * 2654435761 | 0, (this.seed ^ (0xb055 + i)) >>> 0);
        const burst: VhsBurst = {
          bandIndex: i,
          threshold: this.thresholds[i],
          startFrame: f,
          durationFrames: 4 + (h % 11),
          intensity: 0.6 + ((h >>> 8) % 41) / 100,
        };
        burstsFired.push(burst);
        this.liveBursts.push(burst);
      }
      this.lastBandIndex = bandIndex;
    }

    // Decay live bursts and prune the expired ones.
    let boost = 0;
    const stillLive: VhsBurst[] = [];
    for (const b of this.liveBursts) {
      const age = f - b.startFrame;
      if (age < b.durationFrames) {
        stillLive.push(b);
        boost += b.intensity * (1 - age / b.durationFrames);
      }
    }
    this.liveBursts = stillLive;
    const burstBoost = Math.min(1, boost);

    const chromaRamp = anchoredRamp(prox, this.thresholds, CHROMA_ANCHORS);
    const jitterRamp = anchoredRamp(prox, this.thresholds, JITTER_ANCHORS);

    return {
      proximity: prox,
      bandIndex,
      trackingErrorLines: Math.round(chromaRamp * TRACKING_LINES_MAX),
      chromaBleed: chromaRamp,
      dropoutRatePerSec: chromaRamp * DROPOUT_RATE_MAX,
      scanlineJitter: jitterRamp,
      cleanSignal: prox === 0,
      burstsFired,
      burstBoost,
    };
  }
}
