/**
 * Fog density variation — per-chunk atmospheric thickness with smooth blends.
 *
 * Every chunk rolls a deterministic density multiplier in [0.9, 1.1] from a
 * hash of its chunk coordinates (salted so it never correlates with other
 * hashed world features). Chunks containing registered puddles are "low
 * areas": their base density is boosted by +15% (heavier air settles low),
 * mirroring how moisture.ts treats leak chunks.
 *
 * Memory contamination adds a third term: reconstruction zones (chunks whose
 * layout.memIntensity runs high) breathe denser murk via CONTAM_FOG_BOOST,
 * and warmthAt() exposes the blended contamination for callers that also
 * warm the fog colour. Both terms are opt-in through updateContamSet(); an
 * empty set reproduces the classic puddle-only behaviour exactly.
 *
 * Sampling is continuous: multiplierAt(px, pz) bilinearly blends the 2x2
 * chunk neighbourhood around the player position, weighted by where the
 * player sits inside their chunk, so fog thickens and thins gradually while
 * walking — no visible seams at chunk borders even though adjacent chunks
 * usually roll different densities.
 *
 * Pure logic — no engine dependencies, no state beyond the puddle and
 * contamination sets.
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

/** Density multiplier a fully contaminated (reconstruction) chunk reaches. */
export const CONTAM_FOG_BOOST = 1.35;

/** One contaminated chunk entry: intensity is layout.memIntensity (0..1). */
export interface ContamEntry {
  cx: number;
  cz: number;
  /** Contamination density of the chunk, 0..1. Entries <= 0 are ignored. */
  intensity: number;
}

/**
 * Deterministic fog density for one chunk (before blending).
 * @param cx chunk x
 * @param cz chunk z
 * @param puddleChunks keys of chunks holding puddles (low-area boost)
 * @param contam contamination density of THIS chunk 0..1 (0 = classic behaviour)
 */
export function chunkFogDensity(
  cx: number, cz: number, puddleChunks?: ReadonlySet<string>, contam = 0,
): number {
  // Roll 0..1 from chunk coords; map into [FOG_MIN_MULT, FOG_MAX_MULT].
  const roll = rand2(cx, cz, FOG_SALT);
  let d = FOG_MIN_MULT + roll * (FOG_MAX_MULT - FOG_MIN_MULT);
  if (puddleChunks && puddleChunks.has(chunkKey(cx, cz))) {
    d *= PUDDLE_BOOST;
  }
  if (contam > 0) {
    d *= 1 + (CONTAM_FOG_BOOST - 1) * Math.min(1, contam);
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

  /**
   * Replace the contamination-chunk map from loaded layouts. Chunks absent
   * from entries count as uncontaminated; an empty set disables the
   * contamination term entirely.
   */
  updateContamSet(entries: ReadonlyArray<ContamEntry>): void;

  /** Bilinearly blended fog multiplier at a world position. */
  multiplierAt(px: number, pz: number): number;

  /**
   * Bilinearly blended contamination density (0..1) at a world position.
   * Consumers warm the fog colour proportionally to this ("warmer murk in
   * reconstruction zones") while multiplierAt handles the density side.
   */
  warmthAt(px: number, pz: number): number;
}

/**
 * Build a fog-variation sampler. Stateless apart from the puddle and
 * contamination sets, so one instance can serve the whole frame loop.
 */
export function createFogVariation(): FogVariation {
  const puddleChunks = new Set<string>();
  const contamChunks = new Map<string, number>();

  /** Bilinear blend of any per-corner value over the 2x2 chunk neighbourhood. */
  const blend = (px: number, pz: number, corner: (cx: number, cz: number) => number): number => {
    const fx = px / CHUNK_SIZE;
    const fz = pz / CHUNK_SIZE;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    const tx = fx - cx;
    const tz = fz - cz;
    const d00 = corner(cx, cz);
    const d10 = corner(cx + 1, cz);
    const d01 = corner(cx, cz + 1);
    const d11 = corner(cx + 1, cz + 1);
    return (d00 * (1 - tx) + d10 * tx) * (1 - tz) + (d01 * (1 - tx) + d11 * tx) * tz;
  };

  return {
    updatePuddleSet(points: ReadonlyArray<{ x: number; z: number }>): void {
      puddleChunks.clear();
      for (const p of points) {
        puddleChunks.add(chunkKey(Math.floor(p.x / CHUNK_SIZE), Math.floor(p.z / CHUNK_SIZE)));
      }
    },

    updateContamSet(entries: ReadonlyArray<ContamEntry>): void {
      contamChunks.clear();
      for (const e of entries) {
        if (!(e.intensity > 0)) continue;
        contamChunks.set(chunkKey(e.cx, e.cz), e.intensity);
      }
    },

    multiplierAt(px: number, pz: number): number {
      // All four corners see the same puddle and contamination sets so
      // boosted areas bleed smoothly into their neighbours instead of
      // stepping at the border.
      return blend(px, pz, (cx, cz) =>
        chunkFogDensity(cx, cz, puddleChunks, contamChunks.get(chunkKey(cx, cz)) ?? 0));
    },

    warmthAt(px: number, pz: number): number {
      return blend(px, pz, (cx, cz) => contamChunks.get(chunkKey(cx, cz)) ?? 0);
    },
  };
}
