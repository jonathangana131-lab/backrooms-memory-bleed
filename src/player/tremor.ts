/**
 * Low-battery hand tremor (F72).
 *
 * Below TREMOR_THRESHOLD charge the camcorder aim wobbles: a bounded
 * two-axis offset that ramps linearly from zero at 0.20 to full strength
 * at FULL_TREMOR_BATTERY and holds that maximum all the way to dead.
 * At or above the threshold the output is exactly zero on both axes, so
 * a healthy battery can never leak jitter into the camera rig.
 *
 * The noise is pure and dt-stream independent: each frame's offset is a
 * hash of (frame tick, session seed) per axis, never an accumulator, so
 * any two runs visiting the same ticks see byte-identical offsets no
 * matter what timesteps got them there. update() accepts dt only for
 * call-site symmetry with other per-frame systems and ignores its value
 * entirely. No Babylon imports: game.ts reads TremorOffset and applies
 * it to the camera after its own pose solve.
 * All randomness flows from src/core/rng.ts hashes keyed by seed.
 */
import { hash2i } from '../core/rng';

/** Charge at or above which the hands are perfectly steady. */
export const TREMOR_THRESHOLD = 0.2;
/** Charge at which the tremor first reaches full amplitude. */
export const FULL_TREMOR_BATTERY = 0.05;
/** Bounded yaw half-swing at full tremor, in radians. */
export const MAX_YAW_RAD = 0.02;
/** Bounded pitch half-swing at full tremor, in radians. */
export const MAX_PITCH_RAD = 0.015;

/** Distinct hash salts so neither axis can correlate with the other. */
const SALT_YAW = 0x51c3;
const SALT_PITCH = 0x2b9e;

/** One frame of aim wobble, applied directly to camera yaw/pitch. */
export interface TremorOffset {
  /** Yaw delta in [-MAX_YAW_RAD, MAX_YAW_RAD] scaled by current strength. */
  yawRad: number;
  /** Pitch delta in [-MAX_PITCH_RAD, MAX_PITCH_RAD] scaled likewise. */
  pitchRad: number;
}

/**
 * Tremor drive in [0, 1]: exactly 0 for battery >= TREMOR_THRESHOLD,
 * ramping linearly down to 1 at FULL_TREMOR_BATTERY, clamped at 1 below
 * that (the model stays bounded even if charge reads negative).
 *
 * @param battery Injected charge level in [0, 1].
 * @returns Normalized tremor amplitude multiplier.
 */
export function tremorStrength(battery: number): number {
  if (!(battery < TREMOR_THRESHOLD)) return 0;
  const t = (TREMOR_THRESHOLD - battery) / (TREMOR_THRESHOLD - FULL_TREMOR_BATTERY);
  return t > 1 ? 1 : t;
}

/**
 * Pure two-axis noise draw for one frame tick: deterministic in
 * (tick, seed), independent of every dt stream that produced the tick.
 *
 * @param tick Frame tick counter (any integer; negatives allowed).
 * @param seed Session seed mixed into both axes' hashes.
 * @returns Unit-normalized offsets in [-1, 1] per axis, before scaling.
 */
export function tremorNoiseAt(tick: number, seed: number): TremorOffset {
  const yawN = (hash2i(tick | 0, seed | 0, SALT_YAW) / 4294967296) * 2 - 1;
  const pitchN = (hash2i(tick | 0, seed | 0, SALT_PITCH) / 4294967296) * 2 - 1;
  return { yawRad: yawN, pitchRad: pitchN };
}

/**
 * Full sample for one tick: strength from injected battery times the
 * bounded per-axis bounds. Exactly {0, 0} at or above the threshold.
 */
export function tremorAt(battery: number, tick: number, seed: number): TremorOffset {
  const s = tremorStrength(battery);
  if (s === 0) return { yawRad: 0, pitchRad: 0 };
  const n = tremorNoiseAt(tick, seed);
  return { yawRad: n.yawRad * MAX_YAW_RAD * s, pitchRad: n.pitchRad * MAX_PITCH_RAD * s };
}

/**
 * Drives the tremor across one session: one update() call advances the
 * internal tick by one and returns that tick's offset. Junk dt values
 * (NaN, infinite, negative) cannot corrupt anything because dt never
 * enters the state; reset() restores the exact birth state so a fresh
 * run replays identically under the same seed.
 */
export class HandTremor {
  private readonly seed: number;
  private tick_ = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /**
   * Advance one frame and sample the tremor at the new tick.
   *
   * @param _dt Timestep in seconds; ignored by design (tick-keyed model,
   *   kept in the signature so mount sites can pass their frame dt).
   * @param battery Injected charge level in [0, 1].
   */
  update(_dt: number, battery: number): TremorOffset {
    this.tick_++;
    return tremorAt(battery, this.tick_, this.seed);
  }

  /** Current frame tick; offsets are a pure function of this and battery. */
  get tick(): number {
    return this.tick_;
  }

  /** Restore the birth state so the same timeline replays identically. */
  reset(): void {
    this.tick_ = 0;
  }
}
