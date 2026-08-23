/**
 * Fog density variation — per-chunk atmospheric thickness with smooth blends.
 *
 * Every chunk rolls a deterministic density multiplier in [0.9, 1.1] from a
 * hash of its chunk coordinates (salted so it never correlates with other
 * hashed world features). Chunks containing registered puddles are "low
 * areas": their base density is boosted by +15% (heavier air settles low),
 * mirroring how moisture.ts treats leak chunks.
 *
 * Sampling is continuous: multiplierAt(px, pz) bilinearly blends the 2x2
 * chunk neighbourhood around the player position, weighted by where the
 * player sits inside their chunk, so fog thickens and thins gradually while
 * walking — no visible seams at chunk borders even though adjacent chunks
 * usually roll different densities.
 *
 * Pure logic — no engine dependencies, no state beyond the puddle set.
 */
import { CHUNK_SIZE } from '../world/constants';
import { rand2 } from '../core/rng';

/** Salt so fog hashes never correlate with other hashed features. */
const FOG_SALT = 0xf06a;

/** Minimum per-chunk density multiplier (clearest air). */
export const FOG_MIN_MULT = 0.9;

/** Maximum per-chunk density multiplier (thickest rolled variation). */
export const FOG_MAX_MULT = 1.1;

/** Extra density applied to chunks that contain puddles (low areas). */
export const PUDDLE_BOOST = 1.15;

/** Deterministic fog density for one chunk (before blending). */
export function chunkFogDensity(cx: number, cz: number, puddleChunks?: ReadonlySet<string>): number {
  // Roll 0..1 from chunk coords; map into [FOG_MIN_MULT, FOG_MAX_MULT].
  const roll = rand2(cx, cz, FOG_SALT);
  let d = FOG_MIN_MULT + roll * (FOG_MAX_MULT - FOG_MIN_MULT);
  if (puddleChunks && puddleChunks.has(chunkKey(cx, cz))) {
    d *= PUDDLE_BOOST;
  }
  return d;
}


/** Stable string key for a chunk coordinate pair. */
export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

/** Continuous per-position fog density sampler. */
export interface FogVariation {
  /**
   * Replace the puddle-chunk set from world-space puddle positions. Each
   * point maps to the key of the chunk containing it.
   */
  updatePuddleSet(points: ReadonlyArray<{ x: number; z: number }>): void;

  /** Bilinearly blended fog multiplier at a world position. */
  multiplierAt(px: number, pz: number): number;
}

/**
 * Build a fog-variation sampler. Stateless apart from the puddle set, so
 * one instance can serve the whole frame loop.
 */
export function createFogVariation(): FogVariation {
  const puddleChunks = new Set<string>();

  return {
    updatePuddleSet(points: ReadonlyArray<{ x: number; z: number }>): void {
      puddleChunks.clear();
      for (const p of points) {
        puddleChunks.add(chunkKey(Math.floor(p.x / CHUNK_SIZE), Math.floor(p.z / CHUNK_SIZE)));
      }
    },

    multiplierAt(px: number, pz: number): number {
      // Position inside chunk space; (cx, cz) is the lower-left neighbour.
      const fx = px / CHUNK_SIZE;
      const fz = pz / CHUNK_SIZE;
      const cx = Math.floor(fx);
      const cz = Math.floor(fz);
      const tx = fx - cx;
      const tz = fz - cz;

      // Bilinear blend of the 2x2 chunk neighbourhood. All four corners
      // see the same puddle set so boosted low areas bleed smoothly into
      // their neighbours instead of stepping at the border.
      const d00 = chunkFogDensity(cx, cz, puddleChunks);
      const d10 = chunkFogDensity(cx + 1, cz, puddleChunks);
      const d01 = chunkFogDensity(cx, cz + 1, puddleChunks);
      const d11 = chunkFogDensity(cx + 1, cz + 1, puddleChunks);

      return (d00 * (1 - tx) + d10 * tx) * (1 - tz) + (d01 * (1 - tx) + d11 * tx) * tz;
    },
  };
}
