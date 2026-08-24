/**
 * Stamina embodiment (F9): a single fatigue level drives three presentation
 * outputs, each scaling MONOTONICALLY with that level so audio/postfx
 * consumers never need their own state machine:
 *
 *  - breathRateMul   — multiplier for the breath-audio rate mount; rises from
 *    1.0 (fresh) to BREATH_RATE_MUL_MAX (winded). Monotonically decreasing in
 *    level.
 *  - strideIntensity — factor for stride-sound intensity; falls from 1.0
 *    (firm strides) to STRIDE_INTENSITY_MIN (shuffling drag). Monotonically
 *    increasing in level.
 *  - fovPulseAmp     - amplitude fraction for an exertion FOV pulse; rises
 *    from 0 (calm) to FOV_PULSE_AMP_MAX (heart-pounding). Monotonically
 *    decreasing in level.
 *
 * Clamp bounds: level is clamped to [0, 1]; every output above is clamped to
 * the closed interval spanned by its constants and can never overshoot them,
 * because each output is an affine function of the clamped level.
 *
 * Pure state machine - no Babylon, audio or input deps; driven entirely by
 * update(). Rates mirror the controller's former inline numbers so swapping
 * the inline block for this module is behaviour-preserving.
 */

/** Stamina fraction drained per second while sprinting. */
export const STAMINA_DRAIN_RATE = 0.11;
/** Stamina fraction regenerated per second while not sprinting. */
export const STAMINA_REGEN_RATE = 0.075;

/** Breath-rate multiplier when fully winded (level 0); exactly 1 at level 1. */
export const BREATH_RATE_MUL_MAX = 1.8;
/** Stride-intensity floor when fully winded (level 0); exactly 1 at level 1. */
export const STRIDE_INTENSITY_MIN = 0.55;
/** FOV-pulse amplitude fraction when fully winded (level 0); exactly 0 at level 1. */
export const FOV_PULSE_AMP_MAX = 1.0;

export interface StaminaInput {
  /** Player is sprinting this frame (drains); any other stance regenerates. */
  sprinting: boolean;
}

/**
 * Tracks the fatigue level and derives the three monotonic outputs.
 */
export class Stamina {
  /** Fatigue level in [0, 1]; 1 = fresh, 0 = fully winded. */
  private lvl = 1;

  /**
   * Advance drain/regeneration for one frame.
   * @param dt Frame time in seconds (clamped internally to sane bounds).
   * @param input Stance flags for this frame.
   * @returns The updated stamina level in [0, 1].
   */
  update(dt: number, input: StaminaInput): number {
    const step = Math.max(0, Math.min(0.25, dt));
    if (input.sprinting) {
      this.lvl = Math.max(0, this.lvl - step * STAMINA_DRAIN_RATE);
    } else {
      this.lvl = Math.min(1, this.lvl + step * STAMINA_REGEN_RATE);
    }
    return this.lvl;
  }

  /** Current stamina level in [0, 1]. */
  get level(): number {
    return this.lvl;
  }

  /** Breath-audio rate multiplier in [1, BREATH_RATE_MUL_MAX]; decreases as stamina drops. */
  get breathRateMul(): number {
    return 1 + (BREATH_RATE_MUL_MAX - 1) * (1 - this.lvl);
  }

  /** Stride-sound intensity factor in [STRIDE_INTENSITY_MIN, 1]; increases with stamina. */
  get strideIntensity(): number {
    return STRIDE_INTENSITY_MIN + (1 - STRIDE_INTENSITY_MIN) * this.lvl;
  }

  /** FOV-pulse amplitude fraction in [0, FOV_PULSE_AMP_MAX]; increases as stamina drops. */
  get fovPulseAmp(): number {
    return FOV_PULSE_AMP_MAX * (1 - this.lvl);
  }
}
