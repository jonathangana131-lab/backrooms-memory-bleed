/**
 * Environmental storytelling vignettes: small prop scenes that imply a
 * human micro-story without any text.
 *
 * Each builder is pure data - it returns PropInstances laid out in a
 * local frame around (x, z) and oriented by a quarter-turn 'rot',
 * reusing ONLY prop geometry the chunk mesher already renders (see
 * addProp in mesher.ts for footprints):
 *
 *   desk    1.50 x 0.75, top at y 0.70     chair   0.46 x 0.46
 *   bench   1.70 x 0.48                    bedframe 1.0 x 2.0 low slab
 *   crate   0.5..0.89 cube                 locker  0.45 x 0.50 x 1.92
 *   tv      0.50 x 0.45 base + screen box  cabinet 0.95 x 0.50 x 1.12
 *
 * The expanded set (10 scenes) still reuses only these kinds. Scenes that
 * would read better with dedicated geometry document their desired new
 * PropKinds inline (see NEW-KIND NOTES below); none are required today.
 */
import { CELL, CHUNK_CELLS, District, EdgeCode } from './constants';
import { RNG } from '../core/rng';
import type { ChunkLayout, PropInstance, PropKind } from './architect';
import { EXPANDED_VIGNETTE_CHANCE, districtEligibility } from './placement-expansion';

type Rot = 0 | 1 | 2 | 3;

/** One prop in the vignette local frame; (ox, oz) is the unrotated offset. */
interface Part {
  kind: PropKind;
  ox: number;
  oz: number;
  rot: Rot;
  variant?: number;
}

/** Quarter-turn a local offset and compose rotations. */
function assemble(x: number, z: number, rot: Rot, parts: readonly Part[]): PropInstance[] {
  return parts.map((p) => {
    let wx: number, wz: number;
    switch (rot) {
      case 0: wx = p.ox; wz = p.oz; break;


