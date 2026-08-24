/**
 * Gravity ambivalence (F22): saturation zones tilt the player's balance.
 *
 * A pure tilt model for camera roll inside memory-saturation zones. The
 * caller feeds zone saturation plus the player's lateral velocity each
 * frame; a time-windowed velocity average drives a veer direction with
 * hysteresis (the sign adopts only above the enter threshold and releases
 * only below the lower exit threshold), and the camera roll eases toward
 * `veerSign * TILT_MAX_DEG * saturation`. When saturation drops, the target
 * collapses to zero and the same easing curve returns roll continuously to
 * level. Hostile inputs are sanitized, so |roll| never exceeds TILT_MAX_DEG.
 * All tunables derive deterministically from the run seed.
 */
import { hash32 } from './rng';

/** Hard clamp on the returned roll offset, in degrees. */
export const TILT_MAX_DEG = 5;

/** Behaviour knobs; all are seed-jittered at construction, never mutated after. */
export interface GravityTiltConfig {
  /** Velocity-average time constant, seconds (exponential history window). */
  historyWindow: number;
  /** |mean lateral velocity| that adopts a veer sign, m/s. */
  enterThreshold: number;
  /** |mean lateral velocity| below which the veer sign releases, m/s. */
  exitThreshold: number;
  /** Exponential approach rate toward the target roll, 1/s. */
  easeRate: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Sanitize one hostile input sample: non-finite values read as neutral. */
function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/**
 * Deterministic tilt state machine.
 * Same construction seed and identical input sequences always produce
 * identical roll timelines, across instances and sessions.
 */
export class GravityTilt {
  private readonly cfg: GravityTiltConfig;
  private meanVeer = 0;
  private sign: -1 | 0 | 1 = 0;
  private roll = 0;

  /**
   * @param seed Master run seed; jitters thresholds and easing within
   *   ±15% so zones do not all tilt identically, deterministically.
   */
  constructor(seed: number) {
    // rng.ts imports stay world-side by convention; core modules draw their
    // jitter from the same hash family inline to avoid a cross-tree import.
    const jitter = (salt: number): number => {
      const h = hash32(hash32(salt) ^ (seed >>> 0));
      return (h / 4294967296) * 2 - 1; // deterministic in [-1, 1)
    };
    const base: GravityTiltConfig = {
      historyWindow: 0.45,
      enterThreshold: 1.1,
      exitThreshold: 0.55,
      easeRate: 3.2,
    };
    this.cfg = {
      historyWindow: base.historyWindow * (1 + 0.15 * jitter(0x11)),
      enterThreshold: base.enterThreshold * (1 + 0.15 * jitter(0x22)),
      exitThreshold: base.exitThreshold * (1 + 0.15 * jitter(0x33)),
      easeRate: base.easeRate * (1 + 0.15 * jitter(0x44)),
    };
  }

  /** Current veer direction: -1, 0 (level), or +1. */
  get veerSign(): -1 | 0 | 1 {
    return this.sign;
  }

  /** Current camera roll offset in degrees, always within ±TILT_MAX_DEG. */
  get rollDeg(): number {
    return this.roll;
  }

  /**
   * Advance one frame.
   * @param saturation Zone saturation, clamped to [0,1]; non-finite reads as 0.
   * @param lateralVelocity Player sideways velocity, m/s; non-finite reads as 0.
   * @param dt Frame delta, seconds; non-finite/negative reads as 0.
   * @returns The new roll offset in degrees.
   */
  update(saturation: number, lateralVelocity: number, dt: number): number {
    const s = clamp(finiteOr(saturation, 0), 0, 1);
    const v = finiteOr(lateralVelocity, 0);
    const step = clamp(finiteOr(dt, 0), 0, 1);
    // Exponential history window: the running mean forgets old samples at
    // the same rate a finite sliding buffer would, without storing them.
    const blend = step > 0 ? 1 - Math.exp(-step / this.cfg.historyWindow) : 0;
    this.meanVeer += (v - this.meanVeer) * blend;
    // Hysteresis: adopt a sign only above enter, release only below exit,
    // so walking noise near the threshold cannot chatter the roll.
    const mag = Math.abs(this.meanVeer);
    if (this.sign === 0) {
      if (mag >= this.cfg.enterThreshold) this.sign = this.meanVeer > 0 ? 1 : -1;
    } else if (mag < this.cfg.exitThreshold) {
      this.sign = 0;
    }
    const target = this.sign * TILT_MAX_DEG * s;
    this.roll += (target - this.roll) * (1 - Math.exp(-step * this.cfg.easeRate));
    this.roll = clamp(this.roll, -TILT_MAX_DEG, TILT_MAX_DEG);
    if (Math.abs(this.roll) < 1e-9) this.roll = 0;
    return this.roll;
  }

  /** Reset to level with an empty velocity history; config is preserved. */
  reset(): void {
    this.meanVeer = 0;
    this.sign = 0;
    this.roll = 0;
  }
}
