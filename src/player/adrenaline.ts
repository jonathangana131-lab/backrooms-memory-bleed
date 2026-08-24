/**
 * Adrenaline dumps (F75).
 *
 * Injected near-miss events {severity 0..1} trigger dump envelopes that
 * spike fast and bleed off slowly: linear attack over ATTACK_S, linear
 * decay over DECAY_S. One envelope drives two presentation outputs, both
 * monotone in severity so audio/postfx consumers never re-derive state:
 *
 *  - handShakeAmp   - hand/camera tremor amplitude; grows with the summed
 *    dump energy, hard-bounded by SHAKE_AMP_CAP.
 *  - hearingGainMul - hearing-gain boost multiplier in [1, HEARING_GAIN_MUL_MAX];
 *    the ceiling is a +6 dB proxy (2.0x).
 *
 * Stacked dumps sum their severities weighted by envelope value with
 * saturation: the hearing boost clamps its sum at 1 and the shake at
 * SHAKE_AMP_CAP, so arbitrarily many overlapping dumps can never overshoot.
 * A REFRACTORY_S refractory period ignores sub-threshold repeats
 * (severity < SUB_THRESHOLD_SEVERITY) arriving shortly after an accepted
 * dump; strong dumps always land and restart the window.
 *
 * Pure simulation logic: no Babylon or audio deps, fully deterministic -
 * consumers call update() each frame and pushNearMiss() as events arrive;
 * a given input timeline replays identically.
 */

/** Linear attack phase length of one dump envelope, seconds. */
export const ATTACK_S = 0.3;
/** Linear decay phase length of one dump envelope, seconds. */
export const DECAY_S = 4;
/** Refractory window for sub-threshold near-misses, seconds. */
export const REFRACTORY_S = 8;
/** Near-misses below this severity count as sub-threshold repeats. */
export const SUB_THRESHOLD_SEVERITY = 0.25;
/** Shake amplitude contributed by a single full-severity dump. */
export const SHAKE_AMP_PER_DUMP = 0.02;
/** Hard upper bound on handShakeAmp regardless of stacking. */
export const SHAKE_AMP_CAP = 0.035;
/** Hearing-gain multiplier ceiling (+6 dB proxy); exactly 2. */
export const HEARING_GAIN_MUL_MAX = 2;

/** An injected near miss. */
export interface NearMissEvent {
  /** Intensity in [0, 1]; drives every output proportionally. */
  severity: number;
}

/** One accepted adrenaline dump. */
export interface Dump {
  /** Sim time in seconds at which the dump was accepted. */
  startS: number;
  /** Clamped event severity in [0, 1]. */
  severity: number;
}

/**
 * Envelope value of one full-severity dump `tSinceS` after acceptance:
 * linear rise 0 -> 1 across ATTACK_S, then linear fall 1 -> 0 across DECAY_S.
 * Exactly 0 before the attack and after attack+decay.
 * @param tSinceS Seconds since the dump fired.
 * @returns Envelope fraction in [0, 1].
 */
export function dumpEnvelope(tSinceS: number): number {
  if (!(tSinceS > 0) || tSinceS >= ATTACK_S + DECAY_S) return 0;
  return tSinceS <= ATTACK_S ? tSinceS / ATTACK_S : 1 - (tSinceS - ATTACK_S) / DECAY_S;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Accumulates accepted dumps and derives the two monotone outputs.
 */
export class AdrenalineSystem {
  /** Internal sim clock in seconds. */
  private tS = 0;
  private dumps: Dump[] = [];
  private lastAcceptedS = -Infinity;

  /**
   * Advance the sim clock and expire finished envelopes.
   * @param dtS Frame time in seconds (negative values are treated as 0).
   */
  update(dtS: number): void {
    this.tS += Math.max(0, dtS);
    while (this.dumps.length > 0 && this.tS - this.dumps[0].startS >= ATTACK_S + DECAY_S) {
      this.dumps.shift();
    }
  }

  /**
   * Inject a near miss stamped at the current sim time. Sub-threshold events
   * inside the REFRACTORY_S window since the last accepted dump are ignored;
   * everything else lands as a new dump and restarts the refractory window.
   * @param ev The near-miss event.
   * @returns True when the event produced a dump, false when refracted.
   */
  pushNearMiss(ev: NearMissEvent): boolean {
    const sev = clamp01(ev.severity);
    if (sev < SUB_THRESHOLD_SEVERITY && this.tS - this.lastAcceptedS < REFRACTORY_S) {
      return false;
    }
    this.dumps.push({ startS: this.tS, severity: sev });
    this.lastAcceptedS = this.tS;
    return true;
  }

  /** Currently live dumps (accepted, envelope not yet exhausted). */
  get activeDumps(): readonly Dump[] {
    return this.dumps;
  }

  /**
   * Summed dump energy before saturation: each live dump contributes its
   * severity scaled by the current envelope value.
   */
  get rawEnergy(): number {
    let sum = 0;
    for (const d of this.dumps) sum += d.severity * dumpEnvelope(this.tS - d.startS);
    return sum;
  }

  /** Hand-shake amplitude; proportional to dump energy, bounded by SHAKE_AMP_CAP. */
  get handShakeAmp(): number {
    return Math.min(SHAKE_AMP_CAP, SHAKE_AMP_PER_DUMP * this.rawEnergy);
  }

  /**
   * Hearing-gain multiplier in [1, HEARING_GAIN_MUL_MAX]; saturates once the
   * summed dump energy reaches 1 (+6 dB proxy ceiling).
   */
  get hearingGainMul(): number {
    return 1 + (HEARING_GAIN_MUL_MAX - 1) * clamp01(this.rawEnergy);
  }

  /** Sim time in seconds of the internal clock. */
  get now(): number {
    return this.tS;
  }
}
