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

(Showing lines 1-45 of 97. Use offset=46 to continue.)

