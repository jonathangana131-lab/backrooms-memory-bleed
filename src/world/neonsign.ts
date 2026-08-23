/**
 * Rare neon signs — dead-mall remnants bleeding into the Backrooms.
 *
 * A CORRIDOR_GRID chunk has a 1-in-15 chance of hosting exactly one neon
 * sign, bolted to a block wall and facing straight down an open corridor
 * band (the lat-7 grid's gx/gz == 3..4 strips, matching architect.ts).
 * Text is chosen deterministically from the chunk hash, so the same chunk
 * always grows the same sign.
 *
 * Pure data + logic — no Babylon dependency. The mesher consumes
 * NeonSignInstance directly (emissive quad + halo), and the audio layer
 * drives the buzz with sampleFlicker/buzzGain or attaches the ready-made
 * Web Audio graph via createNeonBuzz. Everything is a pure function of
 * (seed, tMs) so flicker is identical across clients and reloads.
 */

/** Grid cell size in meters (mirrors constants.CELL). */
const CELL = 2.5;
/** Cells per chunk side (mirrors constants.CHUNK_CELLS). */
const CHUNK_CELLS = 12;

/** District.CORRIDOR_GRID ordinal in constants.ts. */
const CORRIDOR_GRID = 3;

/** Lat spacing of the corridor super-grid (mirrors architect.decideEdge). */
const LAT = 7;

/** Private salt so neon placement never correlates with any other feature. */
const NEON_SALT = 0x6e30;

/** Buzz is audible within this radius (m). */
export const BUZZ_RADIUS = 8;

const TEXT_POOL = ['MOTEL', 'OPEN 24 HRS', 'VACANCY', 'NO VACANCY', 'DINER'] as const;
export type NeonText = (typeof TEXT_POOL)[number];

/** Tube color per text — motel-red, exit-green, vacancy-cyan, diner-amber. */
const TEXT_COLORS: Record<NeonText, string> = {
  'MOTEL': '#ff3038',
  'OPEN 24 HRS': '#39ff88',


