/**
 * F94 Lying compass — the needle model behind a compass that stops being
 * trustworthy as memory contamination rises.
 *
 * The needle points at the true bearing while the world is clean. Under
 * contamination it bends toward the strongest memory well within range:
 *   angle = trueBearing + clamp(signedDelta(trueBearing → strongestWell),
 *                               -MAX_BEND_DEG, +MAX_BEND_DEG) * contamination
 * so at c = 0 the reading is exact and at c = 1 the needle deflects up to
 * 35° toward (or fully onto) the dominant well. Wells beyond WELL_RANGE_M
 * are inert no matter how strong they are.
 *
 * Pure math only: no DOM, no Babylon, no clock, no randomness — the same
 * inputs always produce the same needle angle on any machine.
 */

/** A memory well the compass can be pulled toward. */
export interface MemoryWell {
  /** World-space X of the well. */
  x: number;
  /** World-space Z of the well. */
  z: number;
  /** Pull strength; larger wins. Ties resolve to the earliest well in the list. */
  strength: number;
}

/** Maximum needle deflection in degrees at contamination = 1. */
export const MAX_BEND_DEG = 35;

/** Wells farther than this from the player (in meters) are ignored entirely. */
export const WELL_RANGE_M = 60;

/**
 * Normalize an angle in degrees to (-180, 180].
 *
 * @param deg arbitrary angle in degrees
 * @returns equivalent angle in (-180, 180]
 */
export function normalizeDeg(deg: number): number {
  if (!isFinite(deg)) return 0;
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Compass bearing of a planar direction, in degrees.
 *
 * Convention: bearing is the standard-math angle of the vector (dx, dz),
 * i.e. atan2(dz, dx), so +X is 0° and +Z is 90°. Callers pass any consistent
 * true-bearing convention; only differences between bearings matter here.
 *
 * @param dx X component of the direction
 * @param dz Z component of the direction
 * @returns bearing in (-180, 180]; 0 for a non-finite direction
 */
export function bearingDeg(dx: number, dz: number): number {
  if (!isFinite(dx) || !isFinite(dz)) return 0;
  if (dx === 0 && dz === 0) return 0;
  return normalizeDeg((Math.atan2(dz, dx) * 180) / Math.PI);
}

/**
 * Shortest signed turn from one bearing to another.
 *
 * @param from starting bearing in degrees
 * @param to target bearing in degrees
 * @returns signed delta in (-180, 180]; positive means clockwise in bearing space
 */
export function signedDeltaDeg(from: number, to: number): number {
  return normalizeDeg(to - from);
}

/** Squared distance between two planar points; non-finite inputs yield Infinity. */
function dist2(px: number, pz: number, x: number, z: number): number {
  if (!isFinite(px) || !isFinite(pz) || !isFinite(x) || !isFinite(z)) return Infinity;
  const dx = x - px;
  const dz = z - pz;
  return dx * dx + dz * dz;
}

/**
 * The dominant memory well for a player position: the highest-strength well
 * that is both geometrically valid and inside range. Junk wells (non-finite
 * coordinates or strength) never qualify. Strength ties go to the earliest
 * well in the list so selection is order-stable for equal inputs.
 *
 * @param px player world X
 * @param pz player world Z
 * @param wells candidate wells
 * @returns the winning well, or null when nothing valid is in range
 */
export function strongestWell(
  px: number,
  pz: number,
  wells: readonly MemoryWell[],
): MemoryWell | null {
  let best: MemoryWell | null = null;
  let bestStrength = -Infinity;
  for (const w of wells) {
    if (!w || typeof w.strength !== 'number' || !isFinite(w.strength)) continue;
    if (dist2(px, pz, w.x, w.z) > WELL_RANGE_M * WELL_RANGE_M) continue;
    if (w.strength > bestStrength) {
      bestStrength = w.strength;
      best = w;
    }
  }
  return best;
}

/**
 * Needle angle under contamination: the true bearing blended toward the
 * strongest in-range well by `contamination`, capped at ±MAX_BEND_DEG.
 * Clean state (no wells, none in range, or contamination 0) returns the
 * exact normalized true bearing.
 *
 * @param px              player world X
 * @param pz              player world Z
 * @param trueBearingDeg  truthful compass reading in degrees
 * @param wells           injected memory-well list
 * @param contamination   contamination level clamped to [0, 1]; non-finite reads as clean
 * @returns needle bearing in (-180, 180]
 */
export function needleAngleDeg(
  px: number,
  pz: number,
  trueBearingDeg: number,
  wells: readonly MemoryWell[],
  contamination: number,
): number {
  if (!isFinite(trueBearingDeg)) return 0;
  const c = isFinite(contamination)
    ? Math.min(1, Math.max(0, contamination))
    : 0;
  const truth = normalizeDeg(trueBearingDeg);
  if (c <= 0) return truth;
  const well = strongestWell(px, pz, wells);
  if (!well) return truth;
  const wellBearing = bearingDeg(well.x - px, well.z - pz);
  const delta = signedDeltaDeg(truth, wellBearing);
  const bend = Math.min(MAX_BEND_DEG, Math.max(-MAX_BEND_DEG, delta)) * c;
  return normalizeDeg(truth + bend);
}

/**
 * Stateful needle model over an injected well list and live contamination
 * level. Systems push wells/contamination via setters and read the needle
 * each frame; all computation stays pure per call.
 */
export class LyingCompass {
  private wells: readonly MemoryWell[] = [];
  private contamination = 0;

  /** Replace the injected memory-well list. */
  setWells(wells: readonly MemoryWell[]): void {
    this.wells = Array.isArray(wells) ? wells : [];
  }

  /**
   * Set the live contamination level.
   *
   * @param c level clamped to [0, 1]; non-finite reads as clean
   */
  setContamination(c: number): void {
    this.contamination = isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
  }

  /**
   * Current needle bearing for a player pose and truthful bearing.
   *
   * @param px             player world X
   * @param pz             player world Z
   * @param trueBearingDeg truthful compass reading in degrees
   * @returns needle bearing in (-180, 180]
   */
  needleAngle(px: number, pz: number, trueBearingDeg: number): number {
    return needleAngleDeg(px, pz, trueBearingDeg, this.wells, this.contamination);
  }
}
