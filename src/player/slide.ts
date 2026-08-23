/**
 * Sprint-crouch slide: triggered while sprinting above trigger speed and
 * crouching. Applies an initial speed boost that decays exponentially
 * (half-life SLIDE_HALF_LIFE), exposes smoothed camera drop/pitch offsets and
 * a reduced turn-rate scale for the player controller to consume.
 *
 * Pure state machine - no Babylon or input deps, driven entirely by update().
 */

// ---- tuning ----
/** Minimum ground speed (m/s) required to kick off a slide; also gates standstill starts. */
export const SLIDE_TRIGGER_SPEED = 3.5;
/** Speed multiplier applied at slide start. */
export const SLIDE_BOOST = 1.3;
/** Exponential decay half-life of the boost (s): factor halves every 0.4 s. */
export const SLIDE_HALF_LIFE = 0.4;
/** Slide ends when effective speed drops below walk speed (m/s). */
export const SLIDE_END_SPEED = 2.35;
/** Minimum time (s) between the end of one slide and the start of the next. */
export const SLIDE_COOLDOWN = 1.5;
/** Camera eye-height drop blend time (s), eased with smoothstep like crouch. */
export const SLIDE_CAM_TIME = 0.3;
/** Forward pitch offset (radians) at full slide blend (-5 degrees). */
export const SLIDE_PITCH = -5 * (Math.PI / 180);
/** Look/turn input scale while fully slid (blends back to 1 as the slide ends). */
export const SLIDE_TURN_SCALE = 0.45;

function smoothstep01(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return t * t * (3 - 2 * t);
}

export interface SlideInput {
  /** Player is currently sprinting. */
  sprinting: boolean;
  /** Crouch is held. */
  crouching: boolean;
  /** Current planar ground speed (m/s) before the slide multiplier. */
  speed: number;
}

export interface SlideState {
  slideActive: boolean;
  /** Current speed multiplier (>= 1); decays exponentially during a slide. */
  slideBoost: number;
}

export class SlideController {
  /** True while a slide is in progress. */
  slideActive = false;

  /** Current boost multiplier; 1 when not sliding (or after decay). */
  private boost = 1;
  /** Remaining burst bonus above 1x, decaying exponentially while sliding. */
  private bonusLeft = 0;
  /** Cooldown timer remaining before another slide may start (s). */
  private cooldownLeft = 0;
  /** 0 = normal camera, 1 = fully slid camera; smoothed over SLIDE_CAM_TIME. */
  private camBlend = 0;

  /**
   * Advance the slide state machine.
   * Returns whether a slide is active and the current boost multiplier to
   * apply to movement this frame.
   */
  update(dt: number, input: SlideInput): SlideState {
    this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);

    // ---- start ----
    // sprinting + crouch while moving fast enough; never from standstill,
    // never mid-slide, and only off cooldown.
    const starting =
      !this.slideActive &&
      input.sprinting &&
      input.crouching &&
      input.speed > SLIDE_TRIGGER_SPEED &&
      this.cooldownLeft <= 0;

    if (starting) {
      this.slideActive = true;
      this.bonusLeft = SLIDE_BOOST - 1;
      this.boost = SLIDE_BOOST;
    } else if (this.slideActive) {
      // ---- run / end (skipped on the start frame so the burst lands at full 1.3x) ----
      // friction: exponential decay of the burst BONUS toward 1x
      // (half-life 0.4s => 1.3x -> ~1.075x after the 0.8s slide window)
      this.bonusLeft *= Math.pow(0.5, dt / SLIDE_HALF_LIFE);
      this.boost = 1 + this.bonusLeft;

      const effectiveSpeed = input.speed * this.boost;
      const done =
        !input.crouching ||                       // released crouch
        input.speed < SLIDE_END_SPEED ||          // base speed fell away (standstill/wall)
        effectiveSpeed < SLIDE_END_SPEED;         // friction ate the burst
      if (done) this.endSlide();
    }

    // ---- camera blend ----
    const camTarget = this.slideActive ? 1 : 0;
    const step = dt / SLIDE_CAM_TIME;
    if (camTarget > this.camBlend) this.camBlend = Math.min(camTarget, this.camBlend + step);
    else if (camTarget < this.camBlend) this.camBlend = Math.max(camTarget, this.camBlend - step);

    return { slideActive: this.slideActive, slideBoost: this.getSlideFactor() };
  }

  private endSlide(): void {
    this.slideActive = false;
    this.boost = 1;
    this.bonusLeft = 0;
    this.cooldownLeft = SLIDE_COOLDOWN;
  }

  /** Movement multiplier to apply this frame (1 when idle; up to SLIDE_BOOST decaying). */
  getSlideFactor(): number {
    return this.slideActive ? this.boost : 1;
  }

  /** True once the camera should be dropping/rising for a slide (any blend > 0). */
  get cameraMoving(): boolean {
    return this.camBlend > 0;
  }

  /** Smoothed eye-height drop fraction, 0..1 (multiply into EYE_STAND->EYE_CROUCH lerp). */
  get cameraDrop(): number {
    return smoothstep01(this.camBlend);
  }

  /** Forward pitch offset in radians; eases to SLIDE_PITCH (-5deg) during a slide. */
  get cameraPitchOffset(): number {
    return SLIDE_PITCH * smoothstep01(this.camBlend);
  }

  /** Turn-rate scale for look input while sliding (SLIDE_TURN_SCALE -> 1). */
  get turnRateScale(): number {
    return 1 + (SLIDE_TURN_SCALE - 1) * smoothstep01(this.camBlend);
  }
}


