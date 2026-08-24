/**
 * Raymarched wet floors for BACKROOMS: MEMORY BLEED (F39).
 *
 * Moisture zones read as wet because they reflect. This module is the
 * pure reflection model a render consumer raymarches against: for every
 * floor cell it answers two questions — how many march steps the tier
 * affords, and how intense the reflected image may be there.
 *
 * Quality tiers gate the whole effect:
 *   - `low`    — hard off. Intensity is exactly 0 for every cell and
 *                every pitch, and the march budget is 0 steps.
 *   - `medium` — capped reflections: intensity never exceeds 0.55, and
 *                the consumer gets 8 march steps.
 *   - `high`   — full reflections up to 1.0 with a 16-step budget.
 *
 * Intensity is monotone in the cell's moisture level: wetter cells never
 * reflect less than drier ones under the same tier and pitch. Pitch acts
 * as a Fresnel stand-in — grazing views (small depression angle) reflect
 * most, straight-down views least — so puddles flash their mirror only
 * when the player looks along the floor.
 *
 * Dependencies are injected ({@link WetFloorDeps}): the caller owns the
 * definition of a moisture cell, this module owns everything visual that
 * follows from it. Per-cell moisture levels derive exclusively from
 * `rand2(cellX, cellZ, salt ^ seed)` (src/core/rng.ts); no Math.random,
 * no Babylon imports — safe to run headless in tests and workers.
 */

import { rand2 } from '../core/rng';

/** Render quality tier for the wet-floor effect. */
export type WetTier = 'low' | 'medium' | 'high';

/** Screen-space raymarch step budget the render consumer must honor. */
export const RAY_STEPS: Readonly<Record<WetTier, number>> = {
  low: 0,
  medium: 8,
  high: 16,
};

/** Hard intensity ceiling per tier. Low is exactly zero — gated off. */
export const TIER_CAP: Readonly<Record<WetTier, number>> = {
  low: 0,
  medium: 0.55,
  high: 1,
};

/** Stream salt so wet-floor jitter never correlates with other systems. */
export const WETFLOOR_SALT = 0x39f10cd;

/** Default stream seed used when no run seed reaches the factory. */
export const DEFAULT_WETFLOOR_SEED = 0x5eedf110;

/**
 * Seeded moisture level of one cell: 0 for dry cells, otherwise a
 * per-cell draw in [LEVEL_MIN, 1]. Pure in (cell, seed).
 *
 * @param deps  injected moisture predicate
 * @param seed  run seed
 * @param cx    cell x in the injector's grid space
 * @param cz    cell z in the injector's grid space
 * @returns moisture level in [0, 1]
 */
export function moistureLevel(
  deps: WetFloorDeps,
  seed: number,
  cx: number,
  cz: number,
): number {
  if (!deps.isMoistureCell(cx, cz)) return 0;
  const LEVEL_MIN = 0.45;
  const r = rand2(cx, cz, (seed ^ WETFLOOR_SALT) >>> 0);
  return LEVEL_MIN + (1 - LEVEL_MIN) * r;
}

/**
 * Fresnel stand-in from camera depression angle. Grazing views (pitch
 * near 0) reflect fully; the gain eases down to PITCH_GAIN_MIN by the
 * time the player stares straight down. Pure and clamped.
 *
 * @param pitch camera depression angle in radians (0 = horizon, PI/2 = down)
 * @returns reflective gain in [PITCH_GAIN_MIN, 1]
 */
export function pitchGain(pitch: number): number {
  const GRAZING_RAD = 0.35; // below this, fully mirror-bright
  const p = Math.max(0, Math.min(Math.PI / 2, pitch));
  if (p <= GRAZING_RAD) return 1;
  const t = (p - GRAZING_RAD) / (Math.PI / 2 - GRAZING_RAD);
  return PITCH_GAIN_MIN + (1 - PITCH_GAIN_MIN) * (1 - t);
}

/** Floor value of the Fresnel stand-in at straight-down views. */
export const PITCH_GAIN_MIN = 0.55;

/**
 * Pure reflection intensity for one cell.
 *
 * Monotone non-decreasing in `level`, scaled by tier ceiling and pitch
 * gain. A level or cap of 0 yields exactly 0.
 *
 * @param level moisture level in [0, 1]
 * @param cap   tier intensity ceiling (TIER_CAP)
 * @param pitch camera depression angle in radians
 * @returns reflection intensity in [0, cap]
 */
export function reflectionIntensity(level: number, cap: number, pitch: number): number {
  if (!(level > 0) || !(cap > 0)) return 0;
  const l = level >= 1 ? 1 : level <= 0 ? 0 : level;
  return l * cap * pitchGain(pitch);
}

/** What a render consumer needs to draw one cell's wet reflection. */
export interface WetCellPlan {
  /** Screen-space raymarch steps the tier affords (RAY_STEPS). */
  steps: number;
  /** Reflection intensity in [0, TIER_CAP[tier]]; exactly 0 on low/dry. */
  intensity: number;
  /** The tier the plan was built under. */
  tier: WetTier;
}

/** Injected dependencies: the caller owns what counts as wet. */
export interface WetFloorDeps {
  /**
   * True when the cell holds standing moisture.
   * @param cx cell x in the caller's grid space
   * @param cz cell z in the caller's grid space
   */
  isMoistureCell(cx: number, cz: number): boolean;
}

/**
 * The wet-floor reflection model: inject a moisture predicate plus a
 * quality tier, then query per-cell plans while the camera moves. Tier
 * changes are immediate and cheap; nothing else is stateful.
 */
export class WetFloor {
  private readonly deps: WetFloorDeps;
  private readonly seed: number;
  private tier: WetTier;

  /**
   * @param deps  moisture predicate owned by the caller
   * @param seed  run seed driving per-cell moisture draws
   * @param tier  starting quality tier ('low' keeps the effect dark)
   */
  constructor(deps: WetFloorDeps, seed: number, tier: WetTier = 'medium') {
    this.deps = deps;
    this.seed = seed >>> 0;
    this.tier = tier;
  }

  /** Current quality tier. */
  getTier(): WetTier {
    return this.tier;
  }

  /** Switch quality tier; the next plan reflects it immediately. */
  setTier(tier: WetTier): void {
    this.tier = tier;
  }

  /** March budget for the current tier (0 on low — effect off). */
  steps(): number {
    return RAY_STEPS[this.tier];
  }

  /**
   * Build the render plan for one cell at the current tier.
   *
   * @param cx    cell x in the injector's grid space
   * @param cz    cell z in the injector's grid space
   * @param pitch camera depression angle in radians
   * @returns the deterministic per-cell reflection plan
   */
  plan(cx: number, cz: number, pitch: number): WetCellPlan {
    const cap = TIER_CAP[this.tier];
    const level = moistureLevel(this.deps, this.seed, cx, cz);
    return {
      steps: RAY_STEPS[this.tier],
      intensity: reflectionIntensity(level, cap, pitch),
      tier: this.tier,
    };
  }
}
