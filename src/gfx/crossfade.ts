/**
 * BoundaryCrossfade: atmospheric thickening at room boundaries.
 *
 * The air changes between rooms. As the walker approaches a chunk
 * boundary the fog briefly thickens - up to 15% denser right at the
 * seam - then relaxes back to normal once the boundary lies behind.
 *
 * Design rules:
 *  - Directional gradient ONLY: the band of thickened air sits AHEAD
 *    of the movement direction. Behind clears immediately - there is
 *    no lingering haze trailing the walker, the old room simply lets
 *    go. Standing still (no movement vector) settles to normal air.
 *  - Deterministic: every boundary plane hashes its own coordinates,
 *    so the same crossing always produces exactly the same effect -
 *    peak strength and relax pace are pure functions of the boundary
 *    index, identical on every run, every seed order.
 *  - Pure logic. Emits one scalar MULTIPLIER (1.0 .. 1.15); the caller
 *    multiplies its own fog density by it. No Babylon dependencies -
 *    safe to call from workers or tests.
 *
 * Temporal shape:
 *  - approach: geometric proximity eases the multiplier up through a
 *    smoothstep over the FOG_BAND (5 m) ahead of the seam,
 *  - crossing: the moment the seam passes behind, the geometric target
 *    snaps back to 1.0 and the stored value relaxes exponentially
 *    (frame-rate independent), so the air visibly exhales after the
 *    threshold rather than stepping.
 */

import { rand2 } from '../core/rng';
import { CHUNK_SIZE } from '../world/constants';

/** Depth of the thickening band ahead of a boundary (metres). */
export const FOG_BAND = 5;
/** Strongest multiplier, reached exactly at the boundary plane. */
export const FOG_PEAK = 1.15;
/** Weakest boundary-specific peak; individual seams vary between this and FOG_PEAK. */
export const FOG_PEAK_MIN = 1.08;
/** Exponential attack time constant while approaching (seconds). */
export const ATTACK_TIME = 0.25;
/** Mean exponential relax time constant after crossing (seconds); per-seam jitter applied. */
export const RELAX_TIME = 0.9;

/** Salt offsets keeping crossfade draws independent of every other feature. */
const SALT_X = 0xc10a;
const SALT_Z = 0xc10b;

/** Hermite ease: 0 -> 0, 1 -> 1, flat tangents at both ends. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * (3 - 2 * u);
}

/**
 * Per-boundary deterministic variation, hashed from the boundary's own
 * integer coordinates. Axis 0 = constant-x plane (x = i * CHUNK_SIZE),
 * axis 1 = constant-z plane. Same seam, same numbers, forever.
 */
function boundaryCharacter(axis: number, index: number): { peak: number; relax: number } {
  const r1 = axis === 0 ? rand2(index, 0, SALT_X) : rand2(0, index, SALT_Z);
  const r2 = axis === 0 ? rand2(index, 1, SALT_X) : rand2(1, index, SALT_Z);
  return {
    peak: FOG_PEAK_MIN + (FOG_PEAK - FOG_PEAK_MIN) * r1,
    relax: RELAX_TIME * (0.75 + 0.5 * r2),
  };
}

/**
 * Pure chunk-boundary fog system. Feed it dt, the walker position and
 * the normalized-ish movement direction; read back a single fog-density
 * multiplier (1.0 normal, up to 1.15 inside the approach band).
 */
export class BoundaryCrossfade {
  /** Current smoothed multiplier returned by update(). */
  private current = 1;
  /** Index of the last seam that influenced the value (-inf = none yet). */
  private lastIndex = -0x80000000 | 0;
  private lastAxis = -1;

  /**
   * Advance one frame.
   *
   * @param dt        elapsed seconds (<= 0 or non-finite freezes state)
   * @param px,pz     walker world position (metres)
   * @param movingDirX,movingDirZ  movement direction; any nonzero length,
   *                  normalized internally. Zero vector = standing still.
   * @returns fog density multiplier in [1.0, 1.15]
   */
  update(dt: number, px: number, pz: number, movingDirX = 0, movingDirZ = 0): number {
    if (!isFinite(dt) || dt <= 0 || !isFinite(px) || !isFinite(pz)) {
      return this.current;
    }

    // Geometric target from the nearest seam AHEAD of travel. Behind
    // never contributes: the previous room's air clears immediately.
    let target = 1;
    let bestAxis = -1;
    let bestIndex = 0;
    let bestDist = Infinity;

    const dl = Math.hypot(movingDirX, movingDirZ);
    if (dl > 1e-6 && isFinite(dl)) {
      const nx = movingDirX / dl;
      const nz = movingDirZ / dl;
      const eps = 1e-6;

      // Constant-x plane ahead along +x/-x travel.
      if (Math.abs(nx) > eps) {
        const frac = px - Math.floor(px / CHUNK_SIZE) * CHUNK_SIZE;
        const d = nx > 0 ? CHUNK_SIZE - frac : frac;
        const idx = nx > 0 ? Math.floor(px / CHUNK_SIZE) + 1 : Math.floor(px / CHUNK_SIZE);
        if (d < bestDist) {
          bestDist = d;
          bestAxis = 0;
          bestIndex = idx;
        }
      }
      // Constant-z plane ahead along +z/-z travel.
      if (Math.abs(nz) > eps) {
        const frac = pz - Math.floor(pz / CHUNK_SIZE) * CHUNK_SIZE;
        const d = nz > 0 ? CHUNK_SIZE - frac : frac;
        const idx = nz > 0 ? Math.floor(pz / CHUNK_SIZE) + 1 : Math.floor(pz / CHUNK_SIZE);
        if (d < bestDist) {
          bestDist = d;
          bestAxis = 1;
          bestIndex = idx;
        }
      }

      if (bestAxis >= 0 && bestDist < FOG_BAND) {
        const ch = boundaryCharacter(bestAxis, bestIndex);
        // closeness peaks exactly at the seam, eased by smoothstep
        const closeness = smoothstep(FOG_BAND, 0, bestDist);
        target = 1 + (ch.peak - 1) * closeness;
        this.lastAxis = bestAxis;
        this.lastIndex = bestIndex;
      } else if (bestAxis >= 0) {
        // remember the seam being approached even before the band
        this.lastAxis = bestAxis;
        this.lastIndex = bestIndex;
      }
    }

    // Frame-rate independent exponential smoothing. Rising air attacks
    // quickly; clearing air (seam behind / standing still) relaxes at
    // the seam's own hashed pace.
    const tau = target >= this.current ? ATTACK_TIME : boundaryCharacter(
      this.lastAxis < 0 ? 0 : this.lastAxis,
      this.lastIndex === (-0x80000000 | 0) ? 0 : this.lastIndex,
    ).relax;
    const k = 1 - Math.exp(-dt / tau);
    this.current += (target - this.current) * k;
    if (Math.abs(this.current - target) < 1e-6) this.current = target;

    return Math.min(FOG_PEAK, Math.max(1, this.current));
  }

  /** Current multiplier without advancing time. */
  value(): number {
    return this.current;
  }

  /** Coordinates of the last seam that influenced the value ([axis, index]). */
  lastBoundary(): { axis: number; index: number } {
    return { axis: this.lastAxis, index: this.lastIndex };
  }

  /** Reset to clear air (teleports, respawns, load-from-save). */
  reset(): void {
    this.current = 1;
    this.lastAxis = -1;
    this.lastIndex = -0x80000000 | 0;
  }
}


