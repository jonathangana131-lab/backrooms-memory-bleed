/**
 * FloorCracks: procedural branching crack decals across floor tiles.
 *
 * High-wear carpet splits along the tile grid: every crack is a walker
 * that starts on a tile boundary line, shuffles along it with organic
 * jitter, occasionally kinks across into the neighbouring tile, and
 * spawns thinner side branches. Each walk step emits one thin dark quad
 * (tapering width, per-corner tint noise) slightly proud of the carpet
 * and above the mesher's wear patches -- the same decal/tint pattern the
 * mesher already uses for wear, baseboards and graffiti, so output drops
 * straight into quad() plus a per-vertex tint pass without new materials.
 *
 * Wear correlation mirrors addFloorWear in src/world/mesher.ts:
 * CORRIDOR_GRID corridors activate far more crack slots than rooms, and
 * their crack start cells are biased toward the very cells the mesher
 * already bleaches with footfall wear patches.
 *
 * Pure data in / pure data out: placement and shape are hash-driven
 * functions of (seed, chunk, slot), no Babylon dependencies, safe to
 * call from workers or tests. Same chunk always yields identical quads.
 */
import { CELL, CHUNK_CELLS, District } from '../world/constants';
import { hash2i, hash3i } from '../core/rng';
import type { QuadInstance } from './cornerao';

/** Salt so crack hashes never correlate with other hashed features. */
const SALT = 0x0c7a;

/** Height above carpet where crack quads sit (above WEAR_Y = 0.002). */
export const CRACK_Y = 0.004;

/** Potential crack roots evaluated per chunk; each activates by district. */
export const MAX_CRACK_SLOTS = 8;

/** Per-slot activation chance keyed by District ordinal. */
export const DISTRICT_CRACK_CHANCE: readonly number[] = [
  0.20, // MAZE
  0.08, // OPEN_OFFICE -- pristine open floors
  0.14, // HONEYCOMB
  0.60, // CORRIDOR_GRID -- heavy footfall, most cracks
  0.12, // STORAGE
];

/** Chance a walk step spawns a side branch (thinner, shorter). */
export const BRANCH_CHANCE = 0.18;

/** Hard cap on emitted quads per chunk (safety valve). */
export const MAX_QUADS_PER_CHUNK = 400;

/**
 * One dark quad of a crack polyline: four world-space corners on the
 * floor plane, normal [0,1,0], per-corner RGB multipliers (dark < 1).
 * Same shape as CornerAO's QuadInstance; consumers auto-orient winding.
 */
export type CrackQuad = QuadInstance;

/** Mutable walker state for one crack path (main trunk or branch). */
interface Walker {
  x: number;
  z: number;
  /** Unit direction (dx, dz). */
  dx: number;
  dz: number;
  /** Steps remaining before this path tip dies out. */
  stepsLeft: number;
  /** Quad half-width at the current step (metres). */
  halfWidth: number;
  /** Base half-width this walker started with. */
  baseHalfWidth: number;
  /** Anchor coordinate of the tile boundary being loosely followed. */
  anchor: number;
  /** True if the boundary runs along x (anchor is a z value), else along z. */
  alongX: boolean;
  /** Total steps budget, for width tapering. */
  totalSteps: number;
  /** Darkness tone for this crack (tint multiplier; lower = darker). */
  dark: number;
  /** Branch depth (0 = main trunk). */
  depth: number;
}

/** Integer-hash derived uniform in [0,1). Deterministic, never Math.random. */
function u01(a: number, b: number, c: number, salt: number): number {
  return (hash3i(a, b, c, salt) % 65536) / 65536;
}

/** Hash-derived float in [lo, hi). */
function range(lo: number, hi: number, a: number, b: number, c: number, salt: number): number {
  return lo + (hi - lo) * u01(a, b, c, salt);
}

/** Clamp helper. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Generates deterministic branching floor-crack decals for one chunk.
 *
 * Integrate-ready for the mesher: for each returned q, call quad(floor,
 * cornerA..cornerD, [0,1,0], ...standard uv quartet), then multiply the
 * four fresh vertices' color channels pairwise by q.tints.
 */
export class FloorCracks {
  readonly seed: number;

  constructor(opts: { seed?: number } = {}) {
    this.seed = opts.seed ?? 0;
  }

  /**
   * All crack quads for chunk (cx, cz) in the given district.
   * Deterministic: identical inputs produce identical quad lists.
   */
  generateForChunk(cx: number, cz: number, district: District): CrackQuad[] {
    const out: CrackQuad[] = [];
    const chance = DISTRICT_CRACK_CHANCE[district] ?? 0.1;
    for (let slot = 0; slot < MAX_CRACK_SLOTS; slot++) {
      if (out.length >= MAX_QUADS_PER_CHUNK) break;
      const roll = u01(cx, cz, slot * 31 + 7, SALT ^ this.seed);
      if (roll >= chance) continue;
      this.walkCrack(cx, cz, district, slot, out);
    }
    return out;
  }

  /**
   * Pick a start cell for a crack root. In CORRIDOR_GRID districts the
   * choice is biased (up to 6 candidate draws) toward cells the mesher's
   * addFloorWear already bleaches, tying cracks to visible wear.
   */
  private pickStartCell(
    cx: number, cz: number, district: District, slot: number,
  ): { lx: number; lz: number } {
    const N = CHUNK_CELLS;
    const wantWorn = district === District.CORRIDOR_GRID;
    let lx = 0;
    let lz = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      lx = clamp(Math.floor(range(0, N, cx, cz, slot * 101 + attempt * 17 + 11, SALT ^ 0x51 ^ this.seed)), 0, N - 1);
      lz = clamp(Math.floor(range(0, N, cx, cz, slot * 211 + attempt * 29 + 13, SALT ^ 0x52 ^ this.seed)), 0, N - 1);
      if (!wantWorn) return { lx, lz };
      const wx = cx * N + lx;
      const wz = cz * N + lz;
      // Matches mesher.ts addFloorWear's worn-cell predicate exactly.
      const worn = hash2i(wx, wz, 4242) % 100 < 55;
      if (worn) return { lx, lz };
    }
    return { lx, lz };
  }

  /** Seed and walk one crack (trunk + branches), emitting dark quads. */
  private walkCrack(
    cx: number, cz: number, district: District, slot: number, out: CrackQuad[],
  ): void {
    const N = CHUNK_CELLS;
    const bx = cx * N * CELL;
    const bz = cz * N * CELL;
    const start = this.pickStartCell(cx, cz, district, slot);

    // Root sits on one of the two boundaries of the chosen cell, near its
    // midpoint, with a small perpendicular offset off the gridline.
    const alongX = u01(cx, cz, slot * 7 + 3, SALT ^ 0x53 ^ this.seed) < 0.5;
    const whichEdge = u01(cx, cz, slot * 13 + 5, SALT ^ 0x54 ^ this.seed) < 0.5 ? 0 : 1;
    const edgeCoord = alongX
      ? bz + (start.lz + whichEdge) * CELL
      : bx + (start.lx + whichEdge) * CELL;
    const alongPos = alongX
      ? bx + (start.lx + 0.15 + 0.7 * u01(cx, cz, slot * 17 + 1, SALT ^ 0x55 ^ this.seed)) * CELL
      : bz + (start.lz + 0.15 + 0.7 * u01(cx, cz, slot * 19 + 2, SALT ^ 0x56 ^ this.seed)) * CELL;

    // Travel direction: along the boundary, either way.
    const sign = u01(cx, cz, slot * 23 + 9, SALT ^ 0x57 ^ this.seed) < 0.5 ? 1 : -1;
    const dx = alongX ? sign : 0;
    const dz = alongX ? 0 : sign;

    const steps = 14 + Math.floor(u01(cx, cz, slot * 29 + 4, SALT ^ 0x58 ^ this.seed) * 17);
    const baseHalfWidth = range(0.010, 0.022, cx, cz, slot * 37 + 6, SALT ^ 0x59 ^ this.seed);
    const dark = range(0.24, 0.36, cx, cz, slot * 41 + 8, SALT ^ 0x5a ^ this.seed);

    const trunk: Walker = {
      x: alongX ? alongPos : edgeCoord + range(-0.06, 0.06, cx, cz, slot + 21, SALT ^ 0x5b ^ this.seed),
      z: alongX ? edgeCoord + range(-0.06, 0.06, cx, cz, slot + 22, SALT ^ 0x5c ^ this.seed) : alongPos,
      dx, dz,
      stepsLeft: steps,
      halfWidth: baseHalfWidth,
      baseHalfWidth,
      anchor: edgeCoord,
      alongX,
      totalSteps: steps,
      dark,
      depth: 0,
    };

    // Stack over trunks and branches; branches never spawn further
    // branches (depth stays 1) so density stays bounded and hairline-like.
    const stack: Walker[] = [trunk];
    while (stack.length > 0) {
      if (out.length >= MAX_QUADS_PER_CHUNK) return;
      const w = stack.pop()!;
      this.walkPath(cx, cz, w, out, stack);
    }
  }

  /**
   * Walk one path to exhaustion, emitting one tapering dark quad per
   * step. The walker hugs its anchor tile boundary via a weak spring,
   * kinks sharply now and then (sometimes hopping to a neighbouring
   * gridline), and may spawn branch walkers onto the branch stack.
   */
  private walkPath(cx: number, cz: number, w: Walker, out: CrackQuad[], stack: Walker[]): void {
    let px = w.x;
    let pz = w.z;
    while (w.stepsLeft > 0 && out.length < MAX_QUADS_PER_CHUNK) {
      w.stepsLeft--;
      const stepIdx = w.totalSteps - w.stepsLeft;
      const h = (salt: number): number => (salt ^ ((px * 977 + pz * 131) | 0));

      // --- steering --------------------------------------------------
      // Weak spring back toward the anchor gridline so cracks follow tile
      // boundaries partially, plus organic jitter each step.
      const tangentX = w.alongX ? 1 : 0;
      const tangentZ = w.alongX ? 0 : 1;
      const perpX = w.alongX ? 0 : 1;
      const perpZ = w.alongX ? 1 : 0;
      const lat = w.alongX ? pz - w.anchor : px - w.anchor;

      // jitter rotation
      const jit = range(-0.38, 0.38, (px * 100) | 0, (pz * 100) | 0, stepIdx, h(SALT ^ 0x61));
      const cj = Math.cos(jit);
      const sj = Math.sin(jit);
      const jx = w.dx * cj - w.dz * sj;
      const jz = w.dx * sj + w.dz * cj;
      // decompose into tangent/perp relative to the boundary
      const tc = jx * tangentX + jz * tangentZ;
      let pc = jx * perpX + jz * perpZ;
      pc -= clamp(lat * 1.35, -0.55, 0.55); // spring home
      const len = Math.sqrt(tc * tc + pc * pc) || 1;
      let dirX = (tc * tangentX + pc * perpX) / len;
      let dirZ = (tc * tangentZ + pc * perpZ) / len;

      // occasional kink: sharp turn, sometimes hopping to a neighbouring
      // tile boundary so cracks cross tiles organically instead of
      // hugging one line forever
      if (u01((px * 31) | 0, (pz * 17) | 0, stepIdx, h(SALT ^ 0x62)) < 0.09) {
        const kink = range(0.55, 1.1, (px * 7) | 0, (pz * 11) | 0, stepIdx, h(SALT ^ 0x63));
        const ks = u01((px * 13) | 0, (pz * 19) | 0, stepIdx, h(SALT ^ 0x64)) < 0.5 ? 1 : -1;
        const ck = Math.cos(kink * ks);
        const sk = Math.sin(kink * ks);
        const kx = dirX * ck - dirZ * sk;
        const kz = dirX * sk + dirZ * ck;
        dirX = kx;
        dirZ = kz;
        if (u01((px * 23) | 0, (pz * 29) | 0, stepIdx, h(SALT ^ 0x65)) < 0.45) {
          // re-anchor to a nearby parallel gridline in the new heading
          const hop = range(-CELL, CELL, (px * 37) | 0, (pz * 41) | 0, stepIdx, h(SALT ^ 0x66));
          w.anchor += Math.abs(hop) < CELL * 0.4 ? Math.sign(hop || 1) * CELL : hop;
        }
      }

      // --- advance ---------------------------------------------------
      const stepLen = range(0.16, 0.30, (px * 43) | 0, (pz * 47) | 0, stepIdx, h(SALT ^ 0x67));
      const nx = px + dirX * stepLen;
      const nz = pz + dirZ * stepLen;

      // Die at chunk borders (+small margin) so decals never spill into a
      // neighbouring chunk and double-draw when that chunk generates too.
      const N2 = CHUNK_CELLS * CELL;
      if (nx < cx * N2 - 0.35 || nx > (cx + 1) * N2 + 0.35 ||
          nz < cz * N2 - 0.35 || nz > (cz + 1) * N2 + 0.35) break;

      // --- width taper -------------------------------------------------
      const progress = stepIdx / w.totalSteps;
      const bulge = 1 + 0.18 * Math.sin(progress * Math.PI * 2 + w.baseHalfWidth * 40);
      let hw = w.baseHalfWidth * (1 - 0.78 * progress) * bulge;
      if (hw < 0.0025) hw = 0.0025;

      // --- branch spawn -----------------------------------------------
      if (
        w.depth === 0 && w.stepsLeft > 5 &&
        u01((px * 53) | 0, (pz * 59) | 0, stepIdx, h(SALT ^ 0x68)) < BRANCH_CHANCE
      ) {
        const ba = range(0.6, 1.15, (px * 61) | 0, (pz * 67) | 0, stepIdx, h(SALT ^ 0x69));
        const bSign = u01((px * 71) | 0, (pz * 73) | 0, stepIdx, h(SALT ^ 0x6a)) < 0.5 ? 1 : -1;
        const cb = Math.cos(ba * bSign);
        const sb = Math.sin(ba * bSign);
        const branchSteps = Math.max(
          4,
          Math.floor(w.stepsLeft * range(0.35, 0.6, (px * 79) | 0, (pz * 83) | 0, stepIdx, h(SALT ^ 0x6b))),
        );
        const branch: Walker = {
          x: px,
          z: pz,
          dx: dirX * cb - dirZ * sb,
          dz: dirX * sb + dirZ * cb,
          stepsLeft: branchSteps,
          halfWidth: hw * 0.65,
          baseHalfWidth: w.baseHalfWidth * 0.65,
          anchor: w.anchor + range(-CELL * 0.5, CELL * 0.5, (px * 89) | 0, (pz * 97) | 0, stepIdx, h(SALT ^ 0x6c)),
          alongX: !w.alongX,
          totalSteps: branchSteps,
          dark: clamp(w.dark + range(-0.05, 0.08, (px * 101) | 0, (pz * 103) | 0, stepIdx, h(SALT ^ 0x6d)), 0.18, 0.5),
          depth: w.depth + 1,
        };
        stack.push(branch);
      }

      // --- emit segment quad -------------------------------------------
      const segLen = Math.hypot(nx - px, nz - pz) || 1;
      const pnx = -(nz - pz) / segLen;
      const pnz = (nx - px) / segLen;
      // darkness: crack base tone plus tiny per-step and per-corner noise
      const dBase = clamp(w.dark + range(-0.02, 0.02, (px * 107) | 0, (pz * 109) | 0, stepIdx, h(SALT ^ 0x6e)), 0.15, 0.55);
      const dA = clamp(dBase + range(-0.02, 0.02, (px * 113) | 0, (pz * 127) | 0, stepIdx, h(SALT ^ 0x6f)), 0.12, 0.6);
      const dB = clamp(dBase + range(-0.02, 0.02, (px * 131) | 0, (pz * 137) | 0, stepIdx, h(SALT ^ 0x70)), 0.12, 0.6);
      const dC = clamp(dBase + range(-0.02, 0.02, (px * 139) | 0, (pz * 149) | 0, stepIdx, h(SALT ^ 0x71)), 0.12, 0.6);
      const dD = clamp(dBase + range(-0.02, 0.02, (px * 151) | 0, (pz * 157) | 0, stepIdx, h(SALT ^ 0x72)), 0.12, 0.6);
      out.push({
        positions: [
          px - pnx * hw, CRACK_Y, pz - pnz * hw,
          px + pnx * hw, CRACK_Y, pz + pnz * hw,
          nx + pnx * hw, CRACK_Y, nz + pnz * hw,
          nx - pnx * hw, CRACK_Y, nz - pnz * hw,
        ],
        normal: [0, 1, 0],
        tints: [
          dA, dA, dA,
          dB, dB, dB,
          dC, dC, dC,
          dD, dD, dD,
        ],
      });

      px = nx;
      pz = nz;
    }
  }
}


