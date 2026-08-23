/**
 * WallWear: deterministic human-contact wear layers on wall faces.
 *
 * People leave marks where their bodies brush walls:
 *
 *   - 'kick'    floor level (~0.15 m)   -- shoe scuffs from walking past
 *   - 'scuff'   knee height  (~0.5 m)   -- bags, hips, knees in tight spots
 *   - 'dent'    chair rail   (0.9 m)    -- chair backs and cart handles
 *   - 'smudge'  shoulder     (~1.45 m)  -- shoulders and steadying hands
 *
 * Every mark is a subtle darker decal quad hugging one wall face, exactly
 * the decal/tint pattern the mesher uses for graffiti and landmark dressing
 * (see cornerao.ts): a consumer emits an axis-aligned quad of the type's
 * size centered at (wallX, y, wallZ), rotated by rotY around +Y so its
 * normal matches the wall face, then multiplies the wall material tint by
 * (1 - alpha). No new materials needed.
 *
 * Density is traffic-correlated: it reuses the architect's corridor-lattice
 * picture of CORRIDOR_GRID chunks -- corridors run on lattice cells whose
 * (x mod 7, z mod 7) lands on lanes 3-4 in exactly one axis -- and weights
 * per-district like floorcracks does. Walls bordering corridor lanes get
 * the heaviest wear; SOLID edges beside DOORWAY edges cluster extra marks
 * near the opening because people brush the jambs entering.
 *
 * Pure data in / pure data out: deterministic function of the ChunkLayout,
 * hash-driven scatter (no Math.random), no Babylon dependencies, safe to
 * call from workers or tests.
 */
import { CELL, CHUNK_CELLS, WALL_T, District, EdgeCode } from '../world/constants';
import { hash2i } from '../core/rng';
import type { ChunkLayout } from '../world/architect';

/** The four wear layers, ordered floor -> shoulder. */
export type WallWearType = 'kick' | 'scuff' | 'dent' | 'smudge';

/**
 * One wall-wear decal. Compatible with decal/quad consumers: center
 * (wallX, y, wallZ) sits just proud of the wall face; rotY orients the
 * decal's +z normal outward from that face (rotY = 0 faces +z, PI faces
 * -z, +PI/2 faces +x, -PI/2 faces -x); alpha drives the darkening
 * strength as a multiply tint of (1 - alpha).
 */
export interface WearInstance {
  /** Decal center x, world space. */
  wallX: number;
  /** Decal center z, world space. */
  wallZ: number;
  /** Decal center height above the floor (metres). */
  y: number;
  /** Yaw around +Y aligning the decal plane with its wall face. */
  rotY: number;
  /** Which wear layer this mark belongs to. */
  type: WallWearType;
  /** Opacity / darkening strength, 0..1 (kept subtle by design). */
  alpha: number;
}

/** Half-widths of each layer's decal quad [along-wall half w, half h]. */
export const WEAR_SIZE: Record<WallWearType, [number, number]> = {
  kick:   [0.14, 0.10],
  scuff:  [0.11, 0.12],
  dent:   [0.08, 0.07],
  smudge: [0.13, 0.16],
};

/** Nominal center heights per layer (metres above floor). */
export const WEAR_Y: Record<WallWearType, number> = {
  kick:   0.15,
  scuff:  0.50,
  dent:   0.90,
  smudge: 1.45,
};

/** How far decal planes sit proud of the wall face (no z-fighting). */
export const WEAR_OFFSET = 0.006;

/**
 * Per-district traffic weight, indexed by District ordinal -- same shape
 * as floorcracks' district table. CORRIDOR_GRID halls carry the most
 * footfall; STORAGE canyons see carts; OPEN_OFFICE sees chairs.
 */
export const DISTRICT_TRAFFIC = [
  0.45, // MAZE          -- wandering traffic
  0.55, // OPEN_OFFICE   -- furniture scrapes, moderate bodies
  0.40, // HONEYCOMB     -- cell dwellers pass rarely
  1.00, // CORRIDOR_GRID -- heavy corridor footfall, most wear
  0.60, // STORAGE       -- handcart routes along canyon walls
] as const;

// Hash salts so scatter positions never correlate with other features.
const SALT_COUNT = 0x5a1;   // how many marks an edge spawns
const SALT_POS   = 0x5a2;   // position along the wall run
const SALT_TYPE  = 0x5a3;   // which wear layer
const SALT_FACE  = 0x5a4;   // which side of the wall
const SALT_Y     = 0x5a5;   // vertical jitter within the band

/** Corridor lane constants mirrored from architect.decideEdge. */
const LATTICE = 7;
const LANE_LO = 3;
const LANE_HI = 4;

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** A lattice cell is a corridor cell when exactly one axis lands on lanes. */
function cellIsCorridor(cx: number, cz: number): boolean {
  const mx = mod(cx, LATTICE);
  const mz = mod(cz, LATTICE);
  const laneX = mx === LANE_LO || mx === LANE_HI;
  const laneZ = mz === LANE_LO || mz === LANE_HI;
  return laneX !== laneZ;
}

/**
 * Traffic multiplier for the two carpet cells flanking a wall edge at
 * world lattice coordinates (wx, wz). Mirrors the architect's corridor
 * test in decideEdge: a cell is ON a corridor lane when exactly one of
 * its lattice coords sits on lanes 3-4. A wall bordering any corridor
 * cell is brushed by everyone walking that lane; a wall between two
 * off-lane cells barely sees traffic at all.
 */
function edgeTraffic(wx: number, wz: number, horizontal: boolean): number {
  // A horizontal edge runs along X at z line wz: its flanking cells sit
  // at z indices wz-1 and wz. A vertical edge mirrors on x.
  const a = horizontal ? cellIsCorridor(wx, wz - 1) : cellIsCorridor(wx - 1, wz);
  const b = horizontal ? cellIsCorridor(wx, wz) : cellIsCorridor(wx, wz);
  return a || b ? 1 : 0.25;
}

/** Either flanking carpet cell of an edge sees any corridor traffic. */
function cellNearTraffic(wx: number, wz: number): boolean {
  return edgeTraffic(wx, wz, true) > 0.25 || edgeTraffic(wx, wz, false) > 0.25;
}

/**
 * Generates wall-wear decals for one chunk. Deterministic: identical
 * layouts produce identical instance lists.
 */
export class WallWear {
  /** Global subtlety cap; every alpha stays <= this. */
  readonly maxAlpha: number;
  /** Extra marks clustered around each doorway jamb. */
  readonly doorwayBoost: number;

  constructor(opts: { maxAlpha?: number; doorwayBoost?: number } = {}) {
    this.maxAlpha = Math.min(0.6, Math.max(0.05, opts.maxAlpha ?? 0.32));
    this.doorwayBoost = Math.max(0, opts.doorwayBoost ?? 2);
  }

  generateForChunk(layout: ChunkLayout): WearInstance[] {
    const out: WearInstance[] = [];
    const N = CHUNK_CELLS;
    const bx = layout.cx * N;
    const bz = layout.cz * N;
    const districtW = DISTRICT_TRAFFIC[layout.district] ?? 0.5;
    // Decal planes sit just proud of the wall FACES (half thickness + gap).
    const off = WALL_T / 2 + WEAR_OFFSET;

    /**
     * Scatter marks along one wall edge. (wx, wz) are the edge's lattice
     * coords used for hashing; s0..s1 span the wall run in world metres;
     * horizontal says whether the run goes along X; faceSign picks which
     * of the two wall faces (+1 south/east, -1 north/west).
     */
    const emitEdge = (
      wx: number, wz: number, horizontal: boolean,
      s0: number, s1: number, faceSign: 1 | -1,
      doorProximity: number,
    ): void => {
      const traffic = edgeTraffic(wx, wz, horizontal) * districtW;
      if (traffic <= 0) return;
      // Base count scales with traffic; doorways add a dense local burst.
      const baseRoll = (hash2i(wx, wz, SALT_COUNT) % 100) / 100;
      let count = Math.floor(traffic * (1 + baseRoll * 2));
      count += Math.round(doorProximity * this.doorwayBoost);
      if (count <= 0) return;

      const runLen = s1 - s0;
      for (let i = 0; i < count; i++) {
        const tPos = (hash2i(wx * 131 + i, wz * 197 + i, SALT_POS) % 1000) / 1000;
        const s = s0 + tPos * runLen;
        const typeRoll = (hash2i(wx + i * 17, wz + i * 23, SALT_TYPE) % 100) / 100;
        let type: WallWearType;
        if (typeRoll < 0.34) type = 'kick';
        else if (typeRoll < 0.62) type = 'scuff';
        else if (typeRoll < 0.80) type = 'dent';
        else type = 'smudge';
        const yJit = ((hash2i(wx * 7 + i, wz * 11 - i, SALT_Y) % 100) / 100 - 0.5)
          * (WEAR_SIZE[type][1] * 0.8);

        let wallX: number, wallZ: number, rotY: number;
        if (horizontal) {
          // Wall runs along X at some z line; faceSign +1 = south (+z) face.
          wallX = s;
          wallZ = wz * CELL + faceSign * off;
          rotY = faceSign === 1 ? 0 : Math.PI;
        } else {
          // Wall runs along Z at some x line; faceSign +1 = east (+x) face.
          wallX = wx * CELL + faceSign * off;
          wallZ = s;
          rotY = faceSign === 1 ? Math.PI / 2 : -Math.PI / 2;
        }
        const alphaBase = 0.10 + traffic * 0.12 + doorProximity * 0.06;
        const alphaJit = ((hash2i(wx - i, wz + i * 29, SALT_FACE) % 100) / 100) * 0.06;


        const alpha = Math.min(this.maxAlpha, alphaBase + alphaJit);
        out.push({
          wallX,
          wallZ,
          y: WEAR_Y[type] + yJit,
          rotY,
          type,
          alpha,
        });
      }
    };

    /** Door proximity: 1 when an adjacent parallel edge is a doorway. */
    const doorProximityFor = (
      wx: number, wz: number, horizontal: boolean,
    ): number => {
      if (horizontal) {
      const lx = wx - bx;
      const lz = wz - bz;
        const left = lx > 0 ? layout.hEdges[lz * N + lx - 1] : EdgeCode.OPEN;
        const right = lx < N - 1 ? layout.hEdges[lz * N + lx + 1] : EdgeCode.OPEN;
        return left === EdgeCode.DOORWAY || right === EdgeCode.DOORWAY ? 1 : 0;
      }
      const lx = wx - bx;
      const lz = wz - bz;
      const up = lz > 0 ? layout.vEdges[(lz - 1) * (N + 1) + lx] : EdgeCode.OPEN;
      const down = lz < N - 1 ? layout.vEdges[(lz + 1) * (N + 1) + lx] : EdgeCode.OPEN;
      return up === EdgeCode.DOORWAY || down === EdgeCode.DOORWAY ? 1 : 0;
    };

    // Walk every wall edge exactly like mesher.addWalls: horizontal runs
    // from hEdges, vertical runs from vEdges, lattice coords derived from
    // the same baseX/baseZ walk so hashing matches the architect's picture
    // of the chunk. Doorway edges are openings, not wall planes; their
    // neighbours carry the jamb clusters instead. Both faces of each wall
    // see traffic.
    for (let lz = 0; lz <= N; lz++) {
      for (let lx = 0; lx < N; lx++) {
        const code = layout.hEdges[lz * N + lx];
        if (code !== EdgeCode.SOLID) continue;
        const wx = bx + lx;
        const wz = bz + lz;
        const prox = doorProximityFor(wx, wz, true);
        if (prox <= 0 && !cellNearTraffic(wx, wz)) continue;
        for (const faceSign of [1, -1] as const) {
          emitEdge(wx, wz, true, wx * CELL, (wx + 1) * CELL, faceSign, prox);
        }
      }
    }
    for (let lz = 0; lz < N; lz++) {
      for (let lx = 0; lx <= N; lx++) {
        const code = layout.vEdges[lz * (N + 1) + lx];
        if (code !== EdgeCode.SOLID) continue;
        const wx = bx + lx;
        const wz = bz + lz;
        const prox = doorProximityFor(wx, wz, false);
        if (prox <= 0 && !cellNearTraffic(wx, wz)) continue;
        for (const faceSign of [1, -1] as const) {
          emitEdge(wx, wz, false, wz * CELL, (wz + 1) * CELL, faceSign, prox);
        }
      }
    }

    return out;
  }
}

/**
 * Convenience wrapper: one-shot generation with default subtlety. Hot
 * paths should hold a WallWear instance instead.
 */
export function generateWallWear(layout: ChunkLayout): WearInstance[] {
  return new WallWear().generateForChunk(layout);
}
