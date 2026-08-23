/**
 * Ceiling tile displacement -- sagged and ajar suspended-ceiling tiles.
 *
 * The Backrooms ceiling reads as a perfect grid from below; this pass breaks
 * that perfection just enough to feel wrong. Some chunks carry ONE tile whose
 * plane is subtly off:
 *
 *   - SAGGING  -- the tile has dropped ~1 cm below the ceiling plane (water
 *     weight, tired grid). Reads as a soft shadowed lip along its grooves.
 *   - AJAR     -- the tile is tilted 2-5 degrees about its in-plane Z axis,
 *     one corner still seated in the grid, the opposite lip dropped.
 *
 * MISSING TILES are deliberately NOT produced here: the fully-absent-tile
 * dressing (black recessed void) belongs to src/world/ceiling-details.ts,
 * which owns the same visual family at a rarer pitch. This module keeps the
 * missing flag in its payload so the mesher can merge both sources into a
 * single per-tile struct; it always reports false. Callers that want hard
 * coordination should skip a displacement result when ceiling-details
 * already placed a detail on the same cell (the two hashes are salted apart,
 * so double-dressing is rare and never correlated).
 *
 * DETERMINISM
 * Hash-based like every other dressing pass: ~12% of chunks carry exactly
 * one displaced tile; the type (sag vs ajar) varies by a second hash draw.
 * The same (seed, chunk, tile) always produces the same answer, and repeated
 * generateForChunk calls replace rather than append.
 *
 * Pure data + logic -- no engine dependency (mirrors ceiling-details.ts).
 * The mesher consumes getDisplacement during its ceiling pass:
 *
 *   const d = tileDisplacement.getDisplacement(cx, cz, lx, lz);
 *   if (d) { ...emit the tile quad offset by d.yOffset, rotated d.rotZ... }
 */

// --- mirrored constants (keeps the module dependency-free for tests) --------
/** Grid cell size in meters (mirrors constants.CELL). */
export const CELL = 2.5;
/** Cells per chunk side (mirrors constants.CHUNK_CELLS). */
export const CHUNK_CELLS = 12;

/** Private salt so tile displacement never correlates with any other feature
 *  (ceiling-details uses 0xce11; this stays well clear of it). */
export const TILE_DISPLACE_SALT = 0x71e5;

/** Roughly this percent of chunks carry exactly one displaced tile. */
export const DISPLACED_CHUNK_RATE = 12;
/** Of those, this percent sag; the rest sit ajar. */
export const SAG_SHARE = 55;

/** How far a sagging tile hangs below the ceiling plane (meters). */
export const SAG_DROP = 0.01;
/** Ajar tiles pivot down slightly even before rotation, so no corner pokes
 *  above the ceiling plane once rotated. */
export const AJAR_DROP = 0.003;
/** Ajar tilt range in degrees (sign chosen by hash). */
export const AJAR_MIN_DEG = 2;
export const AJAR_MAX_DEG = 5;

/** Default world seed; override with setWorldSeed() for save-seeded worlds. */
export const DEFAULT_TILE_DISPLACE_SEED = 0x600d;

/** Displacement payload consumed by the mesher's ceiling pass. */
export interface TileDisplacementData {
  /** Vertical offset below the ceiling plane (meters, <= 0). */
  yOffset: number;
  /** Tilt about the tile's in-plane Z axis (radians, 0 for sagging tiles). */
  rotZ: number;
  /** True when the tile is absent entirely. Reserved for coordination with
   *  src/world/ceiling-details.ts, which owns missing tiles; always false
   *  from this module. */
  missing: boolean;
}

type DisplacedKind = 'sag' | 'ajar';

interface ChunkRecord {
  /** Local tile indices of the single displaced tile. */
  tx: number;
  ty: number;
  kind: DisplacedKind;
  /** Sign of the ajar tilt (+1 / -1); 0 for sag. */
  sign: number;
  /** |tilt| in degrees within [AJAR_MIN_DEG, AJAR_MAX_DEG]; 0 for sag. */
  deg: number;
}

// --- deterministic hashing (local copies so the module stays dependency-free)

function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(a: number, b: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(a | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(b | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

function frac(h: number): number {
  return h / 4294967296;
}

// --- shared deterministic state ---------------------------------------------

let worldSeed = DEFAULT_TILE_DISPLACE_SEED;

/**
 * Per-chunk displaced-tile records. Key "cx,cz" maps to the record, or null
 * when the chunk carries none. Pre-populated by generateForChunk; read by
 * every TileDisplacement instance so all views agree.
 */
const chunkCache = new Map<string, ChunkRecord | null>();

function keyOf(cx: number, cz: number): string {
  return cx + ',' + cz;
}

/**
 * Compute the single displaced tile for one chunk (or null).
 * Pure function of (worldSeed, chunk coords); safe to call repeatedly --
 * it replaces rather than appends, so rebuilds produce identical data.
 */
function computeChunkRecord(cx: number, cz: number): ChunkRecord | null {
  const gate = hash2(cx, cz, worldSeed ^ TILE_DISPLACE_SALT) % 100;
  if (gate >= DISPLACED_CHUNK_RATE) return null;

  // deterministic tile pick anywhere on the chunk grid
  const tx = hash2(cx * 3 + 1013, cz, worldSeed ^ (TILE_DISPLACE_SALT + 1)) % CHUNK_CELLS;
  const ty = hash2(cx, cz * 7 + 4099, worldSeed ^ (TILE_DISPLACE_SALT + 2)) % CHUNK_CELLS;

  const typeDraw = hash2(cx, cz, worldSeed ^ (TILE_DISPLACE_SALT | 0x77)) % 100;
  if (typeDraw < SAG_SHARE) {
    return { tx, ty, kind: 'sag', sign: 0, deg: 0 };
  }
  const sign = hash2(cx, cz, worldSeed ^ 0xa1a2) % 2 === 0 ? 1 : -1;
  const deg = AJAR_MIN_DEG +
    frac(hash2(cx * 11 + ty, cz * 13 + tx, worldSeed ^ 0xb2b3)) *
      (AJAR_MAX_DEG - AJAR_MIN_DEG);
  return { tx, ty, kind: 'ajar', sign, deg };
}

/**
 * Deterministically generate (or regenerate) the displaced-tile record for
 * one chunk. Call when a chunk enters the streaming window so meshing sees a
 * warm cache; getDisplacement() falls back to this lazily either way.
 */
function generateForChunk(cx: number, cz: number): void {
  chunkCache.set(keyOf(cx, cz), computeChunkRecord(cx, cz));
}

/**
 * Re-key every cached chunk against a new world seed. Save-loaded worlds
 * call this once after load; subsequent queries match the saved layout.
 */
function setWorldSeed(seed: number): void {
  if ((seed | 0) === (worldSeed | 0) && chunkCache.size > 0) return;
  worldSeed = seed | 0;
  chunkCache.clear();
}

function currentWorldSeed(): number {
  return worldSeed;
}

/** Test/inspection helper: how many chunks are cached right now. */
function cachedChunkCount(): number {
  return chunkCache.size;
}

/**
 * View over the shared displacement state. Instances hold no per-instance
 * data; any number can be created (the mesher typically keeps one).
 */
class TileDisplacementImpl {
  /**
   * Visual spec for one ceiling tile, or null when it sits flush.
   * @param cx chunk X coordinate
   * @param cz chunk Z coordinate
   * @param tx local tile column within the chunk (0 .. CHUNK_CELLS-1)
   * @param ty local tile row within the chunk (0 .. CHUNK_CELLS-1)
   */
  getDisplacement(cx: number, cz: number, tx: number, ty: number): TileDisplacementData | null {
    const key = keyOf(cx, cz);
    let rec = chunkCache.get(key);
    if (rec === undefined) {
      rec = computeChunkRecord(cx, cz);
      chunkCache.set(key, rec);
    }
    if (!rec || rec.tx !== (tx | 0) || rec.ty !== (ty | 0)) return null;

    if (rec.kind === 'sag') {
      return { yOffset: -SAG_DROP, rotZ: 0, missing: false };
    }
    const rad = rec.sign * rec.deg * (Math.PI / 180);
    return { yOffset: -AJAR_DROP, rotZ: rad, missing: false };
  }

  /**
   * Deterministic identity of the chunk's displaced tile without building a
   * payload -- lets callers check "is this THE tile" cheaply. Null when the
   * chunk carries none.
   */
  getHostTile(cx: number, cz: number): { tx: number; ty: number; kind: DisplacedKind } | null {
    const key = keyOf(cx, cz);
    let rec = chunkCache.get(key);
    if (rec === undefined) {
      rec = computeChunkRecord(cx, cz);
      chunkCache.set(key, rec);
    }
    return rec ? { tx: rec.tx, ty: rec.ty, kind: rec.kind } : null;
  }

  static generateForChunk = generateForChunk;
  static setWorldSeed = setWorldSeed;
  static currentWorldSeed = currentWorldSeed;
  static cachedChunkCount = cachedChunkCount;
}

/**
 * Ceiling tile displacement view. See module header for the visual spec and
 * coordination notes with ceiling-details (missing tiles).
 */
export { TileDisplacementImpl as TileDisplacement };


