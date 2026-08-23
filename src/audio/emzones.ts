/**
 * EM interference fields for BACKROOMS: MEMORY BLEED.
 *
 * Rare fixed pockets of the Backrooms where the electrics go wrong:
 * radio static intensifies, torches flicker erratically, the mains hum
 * distorts and buzzes sharp, and electrical crackles pop through the
 * air like arcing relays.
 *
 * Fully deterministic: placement derives from integer hashes of
 * (world seed, chunk coords), so any zone can be regenerated identically
 * at any time, in any order (see ../core/rng.ts). Roughly one chunk in
 * twenty carries a zone.
 *
 * Zone character is an intensity profile: a center peak with a gaussian
 * falloff over a fixed 12 m radius. Everything downstream reads the same
 * 0..1 scalar via getInterference() --
 *
 *   audio    buzz harmonics detune sharply with interference, and
 *            crackle pops fire on a deterministic per-zone schedule
 *            (sampleCrackle) that any layer can poll without state.
 *   visual   getInterference(x, z) modulates torch flicker directly.
 */

import { hash2i, hash3i } from '../core/rng';

/** Mirrors world/constants.CHUNK_SIZE (30 m) -- kept local so this pure
 *  data module stays runnable under plain Node strip-only mode, matching
 *  the pattern used by world/neonsign.ts. */
const CHUNK_SIZE = 30;
const worldToChunk = (w: number): number => Math.floor(w / CHUNK_SIZE);

/** Salt so EM placement never correlates with other hashed features. */
export const EM_ZONE_SALT = 0xe7;

/** Fraction of chunks carrying a zone (~5%). */
export const EM_ZONE_CHANCE = 0.05;

/** Gaussian falloff radius in meters (center peak -> gone by this edge). */
export const EM_RADIUS = 12;

/** Standard deviation of the falloff; edge value ~ exp(-2.47) ~ 8%. */
const SIGMA = EM_RADIUS * 0.45;

/** Zone core stays this fraction inside its chunk so it reads as "a spot". */
const CORE_MIN = 0.3;


