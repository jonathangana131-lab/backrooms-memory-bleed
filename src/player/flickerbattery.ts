/**
 * F95 Hardcore flicker battery UI — an opt-in mode where torch charge is
 * conveyed ONLY by how the torch light flickers; the HUD battery readout is
 * suppressed while the mode is on and restored exactly on opt-out.
 *
 * Charge bands drive flicker character:
 *   > 50%  steady        - rock-solid beam, never drops
 *   20–50% stutter      - mostly solid with rare single-tick dropouts
 *   < 20%  critical     - rapid irregular stutter, duty and dimness reseeded
 *                         per tick from the RNG law (src/core/rng.ts)
 *
 * The consumer reads `hudSuppressed` to hide/show the battery HUD element and
 * applies each frame's `{ on, dim }` to the torch light. With hardcore off,
 * frames are identity ({ on: true, dim: 1 }) so nothing changes visually.
 * Pure per-tick math keyed by (tick, seed) — no clock, no Math.random.
 */
import { rand2 } from '../core/rng';

/** Charge strictly above this is steady; exactly this value still stutters. */
export const STEADY_MIN_CHARGE = 0.5;
/** Charge below this is critical; exactly this value still stutters. */
export const CRITICAL_MAX_CHARGE = 0.2;
/** Per-tick dropout chance in the stutter band. */
export const STUTTER_CHANCE = 0.08;
/** Brightness while a stutter-band dropout holds (torch sputters, not dies). */
export const STUTTER_DIM = 0.15;
/** Per-tick dropout probability floor in the critical band (~rapid irregular). */
export const CRITICAL_DROP_MIN = 0.3;
/** Per-tick dropout probability ceiling in the critical band. */
export const CRITICAL_DROP_MAX = 0.7;

/** Which flicker regime a charge level maps to. */
export type FlickerBand = 'steady' | 'stutter' | 'critical';

/**
 * Map a torch charge to its flicker band.
 *
 * @param charge charge in [0, 1]; non-finite reads as full (steady) so junk
 *               can never strand the player in the dark
 * @returns 'critical' below 0.2, 'stutter' at [0.2, 0.5], 'steady' above 0.5
 */
export function bandForCharge(charge: number): FlickerBand {
  if (!isFinite(charge)) return 'steady';
  const c = Math.min(1, Math.max(0, charge));
  if (c < CRITICAL_MAX_CHARGE) return 'critical';
  if (c <= STEADY_MIN_CHARGE) return 'stutter';
  return 'steady';
}

/** One frame of torch drive produced by {@link FlickerBattery.frame}. */
export interface FlickerFrame {
  /** Whether the torch emits light this tick. */
  on: boolean;
  /** Torch intensity multiplier in [0, 1]; 1 is the normal beam. */
  dim: number;
}

/** Hash salt separating the dropout draw from the dimness draw per tick. */
const SALT_DROP = 0x51ed270b;
const SALT_DIM = 0x2545f491;

/**
 * Opt-in hardcore battery model. Construct once per session with a seed;
 * feed every frame tick and apply the returned frame to the torch.
 */
export class FlickerBattery {
  /** Hardcore flag: true suppresses the HUD readout and enables flicker encoding. */
  hardcore = false;

  private readonly seed: number;

  /**
   * @param seed session seed; flicker patterns key off (tick, seed)
   */
  constructor(seed = 0x9e3779b9) {
    this.seed = seed | 0;
  }

  /** True exactly while hardcore mode is on; consumers hide the battery HUD on it. */
  get hudSuppressed(): boolean {
    return this.hardcore;
  }

  /**
   * Toggle hardcore mode. Opting out restores the HUD (suppression clears)
   * and returns frames to identity.
   *
   * @param on desired mode
   */
  setHardcore(on: boolean): void {
    this.hardcore = on === true;
  }

  /**
   * Per-tick torch drive for a charge level.
   *
   * @param charge current torch charge (any number; junk reads as full)
   * @param tick   monotonically advancing frame/tick counter
   * @returns identity frame when hardcore is off or charge reads full;
   *          otherwise the band's deterministic flicker state
   */
  frame(charge: number, tick: number): FlickerFrame {
    if (!this.hardcore) return { on: true, dim: 1 };
    const band = bandForCharge(charge);
    if (band === 'steady') return { on: true, dim: 1 };
    const t = isFinite(tick) ? Math.round(tick) : 0;
    if (band === 'stutter') {
      // Occasional single-tick sputters; everything else rock solid.
      if (rand2(t, this.seed, SALT_DROP) < STUTTER_CHANCE) {
        return { on: false, dim: 0 };
      }
      return { on: true, dim: 1 };
    }
    // Critical: irregular rapid stutter. Both the drop probability and the
    // surviving brightness are redrawn every tick, so the rhythm never locks
    // into a period the player can read as a countdown.
    const dropP = CRITICAL_DROP_MIN +
      (CRITICAL_DROP_MAX - CRITICAL_DROP_MIN) * rand2(t, this.seed, SALT_DROP);
    if (rand2(t, this.seed, SALT_DIM) < dropP) {
      return { on: false, dim: 0 };
    }
    return { on: true, dim: STUTTER_DIM + (1 - STUTTER_DIM) * rand2(t, this.seed, SALT_DIM ^ 0x7f4a7c15) };
  }
}
