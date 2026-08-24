/**
 * Lean/peek around doorframes (F10): hold (or toggle, see LeanPeekMode) Q/E to
 * lean the camera out to a side. Produces two camera offsets for the mount:
 * a roll in radians (clamped to LEAN_ROLL_MAX = 12 degrees) and a lateral eye
 * offset along the view-right vector (clamped to LEAN_OFFSET_MAX = 0.45 m of
 * parallax), eased in/out over LEAN_EASE_TIME (~0.18 s) with smoothstep.
 *
 * Blocked-lean safety: the desired head position is validated against an
 * injected collider query; when the full lean would put the head circle
 * inside geometry the offset is clamped to the largest safe fraction, so the
 * head circle never penetrates a wall.
 *
 * Pure state machine - no Babylon or input deps; the caller supplies key
 * predicates so key bindings stay owned by the integrator.
 */

/** Camera roll at full lean (radians); hard ceiling for `LeanState.roll`. */
export const LEAN_ROLL_MAX = 12 * (Math.PI / 180);
/** Lateral eye offset at full lean (metres); hard ceiling for the parallax magnitude. */
export const LEAN_OFFSET_MAX = 0.45;
/** Ease-in/out time (s) for reaching (or leaving) full lean. */
export const LEAN_EASE_TIME = 0.18;
/** Head-circle radius (m) used for the blocked-lean clamp. */
export const LEAN_HEAD_RADIUS = 0.26;
/** Extra clearance (m) kept between the head circle and any collider. */
export const LEAN_MARGIN = 0.04;

/** How lean keys behave. */
export enum LeanPeekMode {
  /** Lean while the key is held (controller `input.down` idiom). */
  Hold = 'hold',
  /** A key press toggles its side; pressing it again releases the lean. */
  Toggle = 'toggle',
}

/** Collider query consumed via injection (moveCircle/hasLineOfSight-style world). */
export interface LeanWorldQuery {
  /**
   * Whether a head circle of radius LEAN_HEAD_RADIUS centred at (x, z),
   * inflated by LEAN_MARGIN, would overlap any solid collider.
   * @param x World x of the candidate head centre.
   * @param z World z of the candidate head centre.
   * @returns True when the position is too tight to lean into.
   */
  headBlocked(x: number, z: number): boolean;
}

export interface LeanInput {
  /** Lean-left key is engaged this frame. */
  leanLeft: boolean;
  /** Lean-right key is engaged this frame. */
  leanRight: boolean;
  /** Player yaw (radians); Babylon convention forward = (-sin, 0, -cos). */
  yaw: number;
  /** Player body x. */
  bodyX: number;
  /** Player body z. */
  bodyZ: number;
}

export interface LeanState {
  /** Signed roll offset in radians in [-LEAN_ROLL_MAX, +LEAN_ROLL_MAX]; positive leans right. */
  roll: number;
  /** World-space eye offset components; magnitude never exceeds LEAN_OFFSET_MAX. */
  offsetX: number;
  offsetZ: number;
  /** Signed lean amount in [-1, 1]; -1 fully left, +1 fully right, 0 upright. */
  amount: number;
}

function smoothstep01(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return t * t * (3 - 2 * t);
}

/**
 * Tracks lean intent, easing and the collision-safe lateral offset.
 */
export class LeanPeek {
  /** Selected lean side target: -1 left, +1 right, 0 upright. */
  private side = 0;
  /** Eased blend toward `side` in [-1, 1]. */
  private blend = 0;
  /** Previous-frame key states for toggle edge detection. */
  private prevLeft = false;
  private prevRight = false;

  constructor(private readonly mode: LeanPeekMode = LeanPeekMode.Hold) {}

  /**
   * Advance the lean envelope one frame.
   * @param dt Frame time in seconds.
   * @param input Key/predicate state plus player pose.
   * @param world Injected collider query for the blocked-lean clamp.
   * @returns Camera offsets to apply this frame.
   */
  update(dt: number, input: LeanInput, world: LeanWorldQuery): LeanState {
    // ---- resolve target side from the configured key mode ----
    if (this.mode === LeanPeekMode.Hold) {
      if (input.leanLeft && !input.leanRight) this.side = -1;
      else if (input.leanRight && !input.leanLeft) this.side = +1;
      else this.side = 0;
    } else {
      const leftEdge = input.leanLeft && !this.prevLeft;
      const rightEdge = input.leanRight && !this.prevRight;
      if (leftEdge && !rightEdge) this.side = this.side === -1 ? 0 : -1;
      else if (rightEdge && !leftEdge) this.side = this.side === +1 ? 0 : +1;
    }
    this.prevLeft = input.leanLeft;
    this.prevRight = input.leanRight;

    // ---- ease blend toward the target over LEAN_EASE_TIME ----
    const step = dt / LEAN_EASE_TIME;
    if (this.side > this.blend) this.blend = Math.min(this.side, this.blend + step);
    else if (this.side < this.blend) this.blend = Math.max(this.side, this.blend - step);

    // ---- collision-safe lateral fraction ----
    // Desired offset along view-right; when the head circle would penetrate
    // geometry, binary-search the largest safe fraction of the current blend.
    const rx = Math.cos(input.yaw), rz = -Math.sin(input.yaw);
    const wantX = input.bodyX + rx * this.blend * LEAN_OFFSET_MAX;
    const wantZ = input.bodyZ + rz * this.blend * LEAN_OFFSET_MAX;
    let frac = Math.abs(this.blend);
    const sign = Math.sign(this.blend) || 1;
    if (frac > 0 && world.headBlocked(wantX, wantZ)) {
      let lo = 0, hi = frac;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        const mx = input.bodyX + rx * mid * sign * LEAN_OFFSET_MAX;
        const mz = input.bodyZ + rz * mid * sign * LEAN_OFFSET_MAX;
        if (world.headBlocked(mx, mz)) hi = mid; else lo = mid;
      }
      frac = lo;
    }
    const signedFrac = frac * sign;

    return {
      roll: signedFrac * LEAN_ROLL_MAX,
      offsetX: rx * signedFrac * LEAN_OFFSET_MAX,
      offsetZ: rz * signedFrac * LEAN_OFFSET_MAX,
      amount: signedFrac,
    };
  }

  /** True while any lean offset is applied (blend not settled at 0). */
  get leaning(): boolean {
    return this.blend !== 0;
  }
}
