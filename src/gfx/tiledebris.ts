/**
 * TileDebris -- broken floor-tile fragments clustered at wall-floor corners.
 *
 * Wherever a wall crack has split the glazing, tiles shed shards: small,
 * flat, triangular-to-irregular quads lying proud of the carpet in tight
 * scatter patterns (3-8 fragments per cluster). Clusters spawn
 * preferentially beside wall cracks -- callers pass the chunk's
 * CrackInstance anchors as seeds -- plus sparse ambient clusters keyed by
 * district, densest in STORAGE back rooms and CORRIDOR_GRID halls whose
 * baseboards take the most abuse.
 *
 * Visual spec: LIGHT quads. The mesher's floor is dark; each fragment
 * carries bright tint multipliers (the pale ceramic of an original tile)
 * with slight per-corner noise so shards catch the flashlight differently.
 * Output uses CornerAO's QuadInstance decal pattern (positions + normal +
 * per-corner RGB multipliers), so it drops straight into quad() on the
 * debris material group plus a tintVerts pass -- no new materials.
 *
 * DETERMINISM
 * Everything is hash/RNG driven from (seed, chunk, district, crackSeeds):
 * identical inputs always rebuild byte-identical quads, in any chunk
 * order, in workers or tests. No Math.random, no engine dependency.
 */
import { CELL, CHUNK_CELLS, District } from '../world/constants';
import { hash3i, RNG } from '../core/rng';
import type { QuadInstance } from './cornerao';

/** Private salt so tile-debris hashes never correlate with other features. */
export const TILE_DEBRIS_SALT = 0x71eb;



// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
 * Integrate-ready for the mesher: for each returned q, call
 * quad(debris, cornerA..cornerD, [0,1,0], ...standard uv quartet), then
 * multiply the four fresh vertices' color channels by q.tints.
 */
export class TileDebris {
  readonly seed: number;

  constructor(opts: { seed?: number } = {}) {
    this.seed = opts.seed ?? 0;
  }

  /**
   * All tile-shard quads for chunk (cx, cz).
   *
   * @param cx          chunk X coordinate
   * @param cz          chunk Z coordinate
   * @param district    District ordinal controlling ambient density
   * @param crackSeeds  wall-crack anchors (e.g. from cracks.ts
   *                    generateForChunk) that bias cluster placement
   * @returns deterministic QuadInstance list (empty when nothing spawns)
   */
  generateForChunk(
    cx: number,
    cz: number,
    district: District,
    crackSeeds: readonly TileDebrisSeed[] = [],
  ): QuadInstance[] {
    const out: QuadInstance[] = [];

    // --- crack-correlated clusters --------------------------------------
    let used = 0;
    const seedCount = Math.min(crackSeeds.length, 32);
    for (let s = 0; s < seedCount && used < MAX_CRACK_CLUSTERS; s++) {
      if (hash3i(cx, cz, s * 131 + 17, TILE_DEBRIS_SALT ^ this.seed ^ 0xc7ac) %
            100 >= CRACK_CLUSTER_CHANCE_PCT) continue;
      used++;
      this.emitCluster(cx, cz, 'crack', s, crackSeeds[s], out);
      if (out.length >= MAX_QUADS_PER_CHUNK) return out.slice(0, MAX_QUADS_PER_CHUNK);
    }

    // --- ambient district clusters ----------------------------------------
    const chance = DISTRICT_DEBRIS_CHANCE[district] ?? 0.08;
    for (let slot = 0; slot < AMBIENT_SLOTS; slot++) {
      if (out.length >= MAX_QUADS_PER_CHUNK) break;
      const roll = hash3i(cx, cz, slot * 71 + 5, TILE_DEBRIS_SALT ^ this.seed) %
        65536 / 65536;
      if (roll >= chance) continue;
      this.emitCluster(cx, cz, 'ambient', slot, null, out);
    }
    return out.length > MAX_QUADS_PER_CHUNK
      ? out.slice(0, MAX_QUADS_PER_CHUNK)
      : out;
  }

  /**
   * Emit one cluster: pick its anchor (beside the given crack seed, or on
   * a pseudo wall-line for ambient slots), then scatter 3-8 rotated shard
   * quads around it.
   */
  private emitCluster(
    cx: number,
    cz: number,
    kind: 'crack' | 'ambient',
    index: number,
    seedPoint: TileDebrisSeed | null,
    out: QuadInstance[],
  ): void {
    const N = CHUNK_CELLS;
    const bx = cx * N * CELL;
    const bz = cz * N * CELL;
    const S = TILE_DEBRIS_SALT ^ this.seed ^ (kind === 'crack' ? 0x5eed : 0xa0b);

    // --- anchor -----------------------------------------------------------
    let ax: number;
    let az: number;
    if (seedPoint !== null && Number.isFinite(seedPoint.x) && Number.isFinite(seedPoint.z)) {
      // hug the crack's wall-floor corner: small scatter, biased slightly
      // toward the wall face when a rotation is supplied
      ax = seedPoint.x + range(-0.35, 0.35, cx, cz, index * 13 + 101, S);
      az = seedPoint.z + range(-0.35, 0.35, cx, cz, index * 29 + 103, S);
      const rot = typeof seedPoint.rotY === 'number' && Number.isFinite(seedPoint.rotY)
        ? seedPoint.rotY
        : null;
      if (rot !== null) {
        const pull = range(0.04, 0.18, cx, cz, index * 41 + 107, S);
        ax += Math.sin(rot) * -pull;
        az += Math.cos(rot) * -pull;
      }
    } else {
      // ambient: anchor beside a candidate wall line -- a cell boundary --
      // the way baseboards do, since we have no layout here
      const lx = hash3i(cx, cz, index * 53 + 211, S) % N;
      const lz = hash3i(cx, cz, index * 59 + 223, S) % N;
      const alongX = hash3i(cx, cz, index * 61 + 227, S) % 2 === 0;
      const whichEdge = hash3i(cx, cz, index * 67 + 229, S) % 2 === 0 ? 0 : 1;
      const off = range(0.06, 0.28, cx, cz, index * 71 + 233, S); // off the wall
      const side = hash3i(cx, cz, index * 73 + 239, S) % 2 === 0 ? 1 : -1;
      const lineCoord = alongX
        ? bz + (lz + whichEdge) * CELL + side * off
        : bx + (lx + whichEdge) * CELL + side * off;
      const cellFrac = range(0.15, 0.85, cx, cz, index * 79 + 241, S);
      ax = alongX ? bx + (lx + cellFrac) * CELL : lineCoord;
      az = alongX ? lineCoord : bz + (lz + cellFrac) * CELL;
    }

    // Clamp the anchor near the chunk so decals never spill far into a
    // neighbouring chunk and double-draw when that chunk generates too.
    const span = N * CELL;
    ax = clamp(ax, bx - 0.2, bx + span + 0.2);
    az = clamp(az, bz - 0.2, bz + span + 0.2);

    // --- fragments ----------------------------------------------------------
    const rng = new RNG(hash3i(Math.round(ax * 64), Math.round(az * 64),
      index * 97 + 307, S));
    const count = FRAGMENTS_MIN +
      rng.int(0, FRAGMENTS_MAX - FRAGMENTS_MIN + 1); // 3..8 inclusive
    for (let f = 0; f < count; f++) {
      if (out.length >= MAX_QUADS_PER_CHUNK) return;

      // scatter position within CLUSTER_RADIUS (uniform over the disc)
      const dist = CLUSTER_RADIUS * Math.sqrt(rng.next());
      const theta = rng.range(0, Math.PI * 2);
      const px = ax + Math.cos(theta) * dist;
      const pz = az + Math.sin(theta) * dist;

      out.push(this.shardQuad(px, pz, cx, cz, index, f, rng));
    }
  }

  /**
   * One shard: a small irregular quad (often reading triangular when one
   * corner collapses toward the centre) lying flat at TILE_DEBRIS_Y, with
   * a hash-varied overall rotation and bright tile-ceramic tints.
   */
  private shardQuad(
    px: number,
    pz: number,
    cx: number,
    cz: number,
    cluster: number,
    frag: number,
    rng: RNG,
  ): QuadInstance {
    const spin = rng.range(0, Math.PI * 2); // varied rotation per fragment
    const cosS = Math.cos(spin);
    const sinS = Math.sin(spin);
    const baseR = rng.range(0.02, 0.06);
    // one corner frequently collapses inward => triangle-like silhouette
    const collapseCorner = rng.chance(0.45);
    const squash = rng.range(0.55, 1.0); // elongation along local odd axes

    const xs: number[] = [];
    const zs: number[] = [];
    for (let k = 0; k < 4; k++) {
      const ang = spin + (k * Math.PI) / 2 + rng.range(-0.45, 0.45);
      let r = baseR * rng.range(0.4, 1.0) * (k % 2 === 0 ? 1 : squash);
      if (collapseCorner && k === 3) r *= rng.range(0.1, 0.35);
      const ox = Math.cos(ang) * r;
      const oz = Math.sin(ang) * r;
      // rotate the offset into world space, then translate
      xs.push(px + ox * cosS - oz * sinS);
      zs.push(pz + ox * sinS + oz * cosS);
    }

    // guard against degenerate slivers: nudge one corner apart
    const area = Math.abs(
      (xs[1] - xs[0]) * (zs[3] - zs[0]) - (xs[3] - xs[0]) * (zs[1] - zs[0]),
    );
    if (area < 1.5e-5) {
      xs[2] += 0.004;
      zs[2] += 0.003;
    }

    // --- tints: light ceramic, brighter than the dark floor -----------------
    const tone = rng.range(1.04, 1.24);
    const duller = rng.chance(0.22) ? 0.82 : 1.0; // occasional grubbier shard
    const tr = clamp(tone * duller * rng.range(0.99, 1.03), 0.7, 1.35);
    const tg = clamp(tone * duller * rng.range(0.99, 1.03), 0.7, 1.35);
    const tb = clamp(tone * duller * rng.range(0.96, 1.0), 0.7, 1.35);
    const tints: number[] = [];
    for (let k = 0; k < 4; k++) {
      const n = rng.range(-0.05, 0.05); // per-corner catch-the-light noise
      tints.push(
        clamp(tr + n, 0.65, 1.4),
        clamp(tg + n, 0.65, 1.4),
        clamp(tb + n, 0.62, 1.38),
      );
    }

    return {
      positions: [
        xs[0], TILE_DEBRIS_Y, zs[0],
        xs[1], TILE_DEBRIS_Y, zs[1],
        xs[2], TILE_DEBRIS_Y, zs[2],
        xs[3], TILE_DEBRIS_Y, zs[3],
      ],
      normal: [0, 1, 0],
      tints,
    };
  }
}


