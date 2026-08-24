/**
 * Fall stagger (F14): a landing whose downward impact speed exceeds
 * FALL_TRIGGER_VY staggers the player for ~STAGGER_RECOVER_TIME (1.6 s):
 *
 *  - inputScale — movement/look intent scale that dips from 1 toward
 *    STAGGER_INPUT_MIN (~0.25) and eases back to exactly 1; the controller
 *    multiplies its move/turn deltas by this each frame.
 *  - blurAmp   — postfx blur envelope in [0, 1]; rises to a peak then decays
 *    to exactly 0. The peak is PROPORTIONAL to the overshoot of the impact
 *    speed above FALL_TRIGGER_VY, normalised against FALL_REFERENCE_VY.
 *
 * Timeline (t measured from touchdown): both envelopes share one phase clock —
 * the drop segment runs [0, STAGGER_DROP_TIME], the recovery segment
 * (STAGGER_DROP_TIME, STAGGER_RECOVER_TIME]. Each segment is smoothstep-eased,
 * so the composite envelope is C1-continuous at the peak and settles at
 * exactly 0 / exactly 1 when the clock expires.
 *
 * Sub-threshold landings never arm the stagger: update() ignores any impact
 * whose speed is above FALL_TRIGGER_VY (i.e. gentler than the trigger).
 *
 * Pure state machine - no Babylon, postfx or input deps; the caller feeds
 * impact events and applies inputScale / blurAmp where they belong.
 */

/** Downward impact speed (m/s, negative) at touchdown that counts as a hard fall. */
export const FALL_TRIGGER_VY = -6.5;
/** Impact speed (m/s) that saturates the stagger intensity (normalisation reference). */
export const FALL_REFERENCE_VY = -12;
/** Total stagger time (s) from touchdown to fully recovered. */
export const STAGGER_RECOVER_TIME = 1.6;
/** Time (s) from touchdown to the deepest point of the stagger. */
export const STAGGER_DROP_TIME = 0.28;
/** Movement-intent scale at the deepest point of a full-intensity stagger. */
export const STAGGER_INPUT_MIN = 0.25;

function smoothstep01(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return t * t * (3 - 2 * t);
}

/**
 * Normalised stagger intensity in [0, 1] for an impact speed: linear in the
 * overshoot beyond FALL_TRIGGER_VY, clamped, and 0 for sub-threshold landings.
 * @param vy Touchdown vertical speed (m/s, negative when falling).
 * @returns Intensity fraction used to scale both output envelopes.
 */
export function staggerIntensity(vy: number): number {
  if (vy > FALL_TRIGGER_VY) return 0;
  return Math.min(1, (FALL_TRIGGER_VY - vy) / (FALL_TRIGGER_VY - FALL_REFERENCE_VY));
}

/**
 * Tracks the stagger phase clock after hard falls and derives the two output
 * envelopes.
 */
export class FallStagger {
  /** Time since the arming impact (s); +Infinity while idle. */
  private age = Number.POSITIVE_INFINITY;
  /** Intensity locked at the arming impact, in [0, 1]. */
  private intensity = 0;

  /**
   * Feed a touchdown event. Impacts gentler than FALL_TRIGGER_VY are ignored,
   * so sub-threshold hops never disturb an ongoing or settled stagger.
   * @param vy Touchdown vertical speed (m/s, negative when falling).
   */
  onImpact(vy: number): void {
    const i = staggerIntensity(vy);
    if (i <= 0) return;
    this.age = 0;
    this.intensity = Math.max(this.intensity, i);
  }

  /**
   * Advance the stagger clock one frame.
   * @param dt Frame time in seconds (clamped internally to sane bounds).
   */
  update(dt: number): void {
    if (this.age === Number.POSITIVE_INFINITY) return;
    this.age += Math.max(0, dt);
    if (this.age >= STAGGER_RECOVER_TIME) {
      // settle exactly: no residual drift, no re-trigger from the tail
      this.age = Number.POSITIVE_INFINITY;
      this.intensity = 0;
    }
  }

  /** True while the stagger timeline is running. */
  get active(): boolean {
    return this.age !== Number.POSITIVE_INFINITY;
  }

  /**
   * Movement/look intent scale for this frame: exactly 1 when idle or settled,
   * dipping toward STAGGER_INPUT_MIN scaled by the locked intensity.
   * @returns Intent multiplier in [STAGGER_INPUT_MIN, 1].
   */
  get inputScale(): number {
    if (!this.active) return 1;
    return 1 - (1 - STAGGER_INPUT_MIN) * this.intensity * this.envelope();
  }

  /**
   * Postfx blur amplitude for this frame in [0, 1]: 0 when idle or settled,
   * peaking at `intensity` at STAGGER_DROP_TIME.
   * @returns Blur envelope value in [0, 1].
   */
  get blurAmp(): number {
    if (!this.active) return 0;
    return this.intensity * this.envelope();
  }

  /** Shared down-up envelope in [0, 1]; 0 before touchdown and after recovery. */
  private envelope(): number {
    if (this.age < STAGGER_DROP_TIME) return smoothstep01(this.age / STAGGER_DROP_TIME);
    return smoothstep01((STAGGER_RECOVER_TIME - this.age) / (STAGGER_RECOVER_TIME - STAGGER_DROP_TIME));
  }
}
