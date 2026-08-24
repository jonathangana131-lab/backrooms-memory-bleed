/**
 * The Mezzanine That Wasn't (F51): upper floors glimpsed through ceilings
 * become explorable via rare staircases. Given (worldSeed, baseChunkKey) the
 * generator derives hashed streams and produces, as a pure function of those
 * inputs: a rarity gate (~1 chunk in 25), a staircase descriptor with walkable
 * step metadata linking the base floor to the upper level, and the mezzanine
 * interior itself - a small grid with a continuous balcony ring overlooking a
 * partitioned core. Identical inputs regenerate byte-for-byte; the exterior
 * world only ever sees the fixed glimpse footprint reported separately, so
 * facade/ceiling generation never learns how the mezzanine is laid out.
 */
import { RNG, hash2i, seedFromString } from '../core/rng';
import type { PropKind, PropInstance, LightFixture } from './architect';

/** Salt isolating mezzanine gate draws from every other hashed feature. */
const MEZZ_GATE_SALT = 0x51ab;
/** Salt isolating the mezzanine layout stream from every other hashed feature. */
const MEZZ_LAYOUT_SALT = 0x51cd;
/** Salts deriving the seed-independent glimpse footprint position. */
const GLIMPSE_X_SALT = 0x51ef;
const GLIMPSE_Z_SALT = 0x51f1;

/** Expected rarity: about one chunk in this many spawns a staircase. */
export const MEZZ_RARITY_ONE_IN = 25;

/** Minimum mezzanine interior width in cells (balcony-to-balcony). */
export const MIN_MEZZ_WIDTH = 8;
/** Minimum mezzanine interior depth in cells. */
export const MIN_MEZZ_DEPTH = 10;

/** Glimpsed upper-floor frontage reserved outside, in cells (constant). */
export const GLIMPSE_CELLS_WIDE = 4;
/** Glimpsed upper-floor depth reserved outside, in cells (constant). */
export const GLIMPSE_CELLS_DEEP = 4;

/** Cells per chunk side; mirrors CHUNK_CELLS in ./constants for this pure model. */
const CHUNK_CELLS = 12;

/** Grid cell codes used during layout. */
const FLOOR = 0;
const WALL = 1;
const BALCONY = 2;

/** Cardinal ascent direction of a staircase, in key suffix form. */
export type MezzFace = 'n' | 's' | 'e' | 'w';

/** A parsed chunk identity. */
export interface ChunkRef {
  /** Chunk x index. */
  cx: number;
  /** Chunk z index. */
  cz: number;
}

/**
 * Exterior-facing glimpse footprint: what the base floor reserves for the
 * upper level seen through ceilings. Deliberately independent of interior
 * layout and world seed - ceilings never learn what the mezzanine contains.
 */
export interface GlimpseFootprint {
  /** Upper-floor origin cell x, chunk-local. */
  glimpseX: number;
  /** Upper-floor origin cell z, chunk-local. */
  glimpseZ: number;
  /** Frontage width glimpsed through the ceiling, in cells (constant). */
  cellsWide: number;
  /** Depth glimpsed through the ceiling, in cells (constant). */
  cellsDeep: number;
}

/** One walkable staircase riser. Rise climbs monotonically in (0, 1]. */
export interface StairStep {
  /** Cell x, chunk-local. */
  x: number;
  /** Cell z, chunk-local. */
  z: number;
  /** Fraction of the base-to-mezzanine height climbed at this step. */
  rise: number;
}

/**
 * A staircase linking the base floor to a mezzanine. All cell coordinates
 * except {@link landing} are chunk-local base-world cells the mesher mounts;
 * {@link landing} is a cell inside the mezzanine interior grid where the
 * stairs arrive.
 */
export interface MezzanineStaircase {
  /** Base chunk key this staircase hangs from. */
  chunkKey: string;
  /** Cardinal direction of ascent. */
  face: MezzFace;
  /** Flat approach cell at base level, adjacent to the first riser. */
  baseCell: { x: number; z: number };
  /** Walkable risers in ascent order. */
  steps: StairStep[];
  /** Arrival cell at mezzanine level, adjacent to the last riser. */
  topCell: { x: number; z: number };
  /** Mezzanine-interior-local arrival cell on the balcony ring. */
  landing: { x: number; z: number };
  /** Fixed glimpse footprint (seed- and interior-independent). */
  footprint: GlimpseFootprint;
}

/** One grid cell of a mezzanine interior. */
export interface MezzanineCell {
  /** Cell x within the interior grid. */
  x: number;
  /** Cell z within the interior grid. */
  z: number;
  /** Solid wall, core floor, or walkable balcony ring. */
  kind: 'wall' | 'floor' | 'balcony';
}

/** A generated mezzanine interior. Pure data, JSON-serializable. */
export interface MezzanineInterior {
  /** Base chunk key this mezzanine hangs from. */
  chunkKey: string;
  /** World seed the mezzanine was generated from. */
  worldSeed: number;
  /** Interior grid width in cells (independent of the glimpse footprint). */
  width: number;
  /** Interior grid depth in cells (independent of the glimpse footprint). */
  depth: number;
  /** Every cell of the interior, row-major by z then x. */
  cells: MezzanineCell[];
  /** Furnishings placed on the mezzanine. */
  props: PropInstance[];
  /** Light fixtures hung on the mezzanine. */
  lights: LightFixture[];
  /** Balcony cell where the staircase arrives (walkable). */
  entry: { x: number; z: number };
  /** Farthest reachable walkable cell from the entry. */
  exit: { x: number; z: number };
}

/** A gated mezzanine: staircase plus interior, mutually consistent. */
export interface MezzaninePair {
  /** Staircase descriptor linking base floor to the interior. */
  staircase: MezzanineStaircase;
  /** Complete interior layout. */
  interior: MezzanineInterior;
}

/** Furniture the mezzanine furnisher may place. */
const MEZZ_PROPS: readonly PropKind[] = [
  'desk', 'chair', 'cabinet', 'sofa', 'locker', 'crate', 'shelf',
];

/** Ascent unit vectors keyed by face. */
const FACE_DIRS: Record<MezzFace, { dx: number; dz: number }> = {
  n: { dx: 0, dz: -1 },
  s: { dx: 0, dz: 1 },
  e: { dx: 1, dz: 0 },
  w: { dx: -1, dz: 0 },
};

/**
 * Parse a chunk key of the form "<cx>,<cz>".
 * @param key Chunk key as issued by the chunk layer, e.g. '3,-2'.
 * @returns The parsed chunk reference.
 * @throws When the key is malformed - bad keys fail loud, never silently map.
 */
export function parseChunkKey(key: string): ChunkRef {
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  if (!m) throw new Error('malformed mezzanine chunk key: ' + key);
  return { cx: Number(m[1]), cz: Number(m[2]) };
}

/**
 * Glimpse footprint for a chunk - what the base floor accounts for of the
 * upper level seen through ceilings. Derived from the chunk key alone: fixed
 * size, independent of world seed and of the actual interior layout.
 * @param chunkKey Base chunk key, e.g. '3,-2'.
 * @returns Fixed glimpse footprint metadata for the chunk.
 */
export function glimpseFootprint(chunkKey: string): GlimpseFootprint {
  const { cx, cz } = parseChunkKey(chunkKey);
  return {
    glimpseX: hash2i(cx, cz, GLIMPSE_X_SALT) % CHUNK_CELLS,
    glimpseZ: hash2i(cx, cz, GLIMPSE_Z_SALT) % CHUNK_CELLS,
    cellsWide: GLIMPSE_CELLS_WIDE,
    cellsDeep: GLIMPSE_CELLS_DEEP,
  };
}

/**
 * Rarity gate: does this chunk spawn a mezzanine staircase?
 * Pure hash draw - stable across calls and independent of the layout stream.
 * @param worldSeed Master run seed.
 * @param chunkKey Base chunk key, e.g. '3,-2'.
 * @returns True when the chunk is one of the rare ~1-in-25 staircase hosts.
 */
export function mezzanineGate(worldSeed: number, chunkKey: string): boolean {
  parseChunkKey(chunkKey);
  const keySeed = seedFromString(chunkKey);
  return hash2i(keySeed, worldSeed, MEZZ_GATE_SALT) % MEZZ_RARITY_ONE_IN === 0;
}

/**
 * Generate the gated mezzanine for a chunk: staircase descriptor plus
 * interior, mutually consistent ({@link MezzanineStaircase.landing} equals
 * {@link MezzanineInterior.entry}, and {@link stairPathExists} holds).
 * Pure function of (worldSeed, chunkKey): regeneration is byte-identical.
 * @param worldSeed Master run seed.
 * @param chunkKey Base chunk key, e.g. '3,-2'.
 * @returns The pair, or null when the rarity gate stays closed for this chunk.
 */
export function generateMezzanine(
  worldSeed: number,
  chunkKey: string,
): MezzaninePair | null {
  parseChunkKey(chunkKey);
  if (!mezzanineGate(worldSeed, chunkKey)) return null;

  const rng = new RNG(hash2i(seedFromString(chunkKey), worldSeed, MEZZ_LAYOUT_SALT));

  const width = MIN_MEZZ_WIDTH + rng.int(0, 3);
  const depth = MIN_MEZZ_DEPTH + rng.int(0, 3);

  // Staircase geometry: a straight run of risers inside the chunk.
  const face: MezzFace = rng.pick(['n', 's', 'e', 'w']);
  const stepCount = 6 + rng.int(0, 3);
  const dir = FACE_DIRS[face];
  const alongAxis = dir.dx !== 0 ? 'x' : 'z';
  // Foot offset along the ascent axis so every riser and the top cell fit.
  const lo = dir.dx + dir.dz > 0 ? 1 : stepCount + 1;
  const hi = dir.dx + dir.dz > 0 ? CHUNK_CELLS - stepCount - 2 : CHUNK_CELLS - 2;
  const footAlong = lo + rng.int(0, hi - lo + 1);
  const cross = 1 + rng.int(0, CHUNK_CELLS - 2);
  const baseCell = {
    x: alongAxis === 'x' ? footAlong : cross,
    z: alongAxis === 'z' ? footAlong : cross,
  };
  const steps: StairStep[] = [];
  for (let i = 0; i < stepCount; i++) {
    steps.push({
      x: baseCell.x + dir.dx * (i + 1),
      z: baseCell.z + dir.dz * (i + 1),
      rise: (i + 1) / stepCount,
    });
  }
  const last = steps[steps.length - 1];
  const topCell = { x: last.x + dir.dx, z: last.z + dir.dz };

  // Landing: a balcony-ring cell picked along the face the stairs arrive from.
  const landing =
    face === 'n' ? { x: 1 + rng.int(0, width - 2), z: 0 }
    : face === 's' ? { x: 1 + rng.int(0, width - 2), z: depth - 1 }
    : face === 'w' ? { x: 0, z: 1 + rng.int(0, depth - 2) }
    : { x: width - 1, z: 1 + rng.int(0, depth - 2) };

  // Grid: balcony ring, parapet wall line, then a carved core.
  const grid: Uint8Array = new Uint8Array(width * depth);
  const at = (x: number, z: number) => z * width + x;
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      const onRing = x === 0 || z === 0 || x === width - 1 || z === depth - 1;
      grid[at(x, z)] = onRing ? BALCONY : WALL;
    }
  }

  // Core rooms, chained by L-corridors.
  const coreW = width - 4;
  const coreD = depth - 4;
  const rooms = 2 + rng.int(0, 3);
  let prevCx = -1;
  let prevCz = -1;
  for (let r = 0; r < rooms; r++) {
    const rw = Math.min(2 + rng.int(0, 3), coreW);
    const rd = Math.min(2 + rng.int(0, 3), coreD);
    const rx = 2 + rng.int(0, coreW - rw);
    const rz = 2 + rng.int(0, coreD - rd);
    for (let z = rz; z < rz + rd; z++) {
      for (let x = rx; x < rx + rw; x++) grid[at(x, z)] = FLOOR;
    }
    const ccx = rx + (rw >> 1);
    const ccz = rz + (rd >> 1);
    if (prevCx >= 0) {
      for (let x = Math.min(prevCx, ccx); x <= Math.max(prevCx, ccx); x++) {
        grid[at(x, prevCz)] = FLOOR;
      }
      for (let z = Math.min(prevCz, ccz); z <= Math.max(prevCz, ccz); z++) {
        grid[at(ccx, z)] = FLOOR;
      }
    }
    prevCx = ccx;
    prevCz = ccz;
  }

  // Parapet doorways: gaps in the inner wall line toward the balcony.
  const parapet: Array<[number, number]> = [];
  for (let x = 1; x < width - 1; x++) {
    parapet.push([x, 1], [x, depth - 2]);
  }
  for (let z = 2; z < depth - 2; z++) {
    parapet.push([1, z], [width - 2, z]);
  }
  const doorways = 2 + rng.int(0, 2);
  for (let d = 0; d < doorways; d++) {
    const [dx, dz] = parapet[rng.int(0, parapet.length)];
    grid[at(dx, dz)] = FLOOR;
  }

  // Connectivity repair: flood from the landing, knock holes until all
  // walkable cells (floor or balcony) reach.
  const walkable = (i: number) => grid[i] === FLOOR || grid[i] === BALCONY;
  const reach = new Uint8Array(width * depth);
  let totalWalkable = 0;
  for (let i = 0; i < grid.length; i++) if (walkable(i)) totalWalkable++;
  let guard = width * depth;
  while (guard-- > 0) {
    reach.fill(0);
    const stack = [at(landing.x, landing.z)];
    reach[at(landing.x, landing.z)] = 1;
    let count = 1;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      const cx = cur % width;
      const cz = (cur - cx) / width;
      const nbrs = [cur - 1, cur + 1, cur - width, cur + width];
      for (let n = 0; n < 4; n++) {
        const nx = cx + (n === 0 ? -1 : n === 1 ? 1 : 0);
        const nz = cz + (n === 2 ? -1 : n === 3 ? 1 : 0);
        if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
        if (reach[nbrs[n]] || !walkable(nbrs[n])) continue;
        reach[nbrs[n]] = 1;
        count++;
        stack.push(nbrs[n]);
      }
    }
    if (count >= totalWalkable) break;
    let opened = false;
    for (let z = 1; z < depth - 1 && !opened; z++) {
      for (let x = 1; x < width - 1 && !opened; x++) {
        const i = at(x, z);
        if (grid[i] !== WALL) continue;
        const nb =
          (reach[i - 1] === 1) || (reach[i + 1] === 1) ||
          (reach[i - width] === 1) || (reach[i + width] === 1);
        if (nb) { grid[i] = FLOOR; opened = true; totalWalkable++; }
      }
    }
    if (!opened) break;
  }

  // Furnish: wall-hugging props on core floors, sparse hanging lights.
  const props: PropInstance[] = [];
  const lights: LightFixture[] = [];
  const maxProps = Math.floor((width * depth) / 16);
  for (let z = 1; z < depth - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      if (grid[at(x, z)] !== FLOOR) continue;
      const nearWall =
        grid[at(x - 1, z)] === WALL || grid[at(x + 1, z)] === WALL ||
        grid[at(x, z - 1)] === WALL || grid[at(x, z + 1)] === WALL;
      if (nearWall && props.length < maxProps && rng.chance(0.09)) {
        props.push({
          kind: rng.pick(MEZZ_PROPS),
          x: x + 0.5,
          z: z + 0.5,
          rot: rng.int(0, 4) as PropInstance['rot'],
          variant: rng.int(0, 4),
        });
      }
    }
    for (let x = 0; x < width; x++) {
      if (!walkable(at(x, z))) continue;
      if ((x + z) % 3 === 0 && lights.length < 48 && rng.chance(0.3)) {
        lights.push({ x: x + 0.5, z: z + 0.5, flicker: rng.range(0.04, 0.6), alive: true });
      }
    }
  }

  // Exit: farthest reachable core-floor cell from the landing (BFS distance),
  // falling back to the farthest walkable cell if no core floor is reachable.
  const dist = new Int32Array(width * depth).fill(-1);
  const q: number[] = [at(landing.x, landing.z)];
  dist[q[0]] = 0;
  let head = 0;
  let farWalk = q[0];
  let farFloor = -1;
  while (head < q.length) {
    const cur = q[head++];
    if (grid[cur] === FLOOR && (farFloor === -1 || dist[cur] > dist[farFloor])) {
      farFloor = cur;
    }
    if (dist[cur] > dist[farWalk]) farWalk = cur;
    const cx = cur % width;
    const cz = (cur - cx) / width;
    const nbrs = [[cx - 1, cz], [cx + 1, cz], [cx, cz - 1], [cx, cz + 1]];
    for (const [nx, nz] of nbrs) {
      if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
      const ni = at(nx, nz);
      if (dist[ni] !== -1 || !walkable(ni)) continue;
      dist[ni] = dist[cur] + 1;
      q.push(ni);
    }
  }
  const far = farFloor !== -1 ? farFloor : farWalk;

  const cells: MezzanineCell[] = [];
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      const g = grid[at(x, z)];
      cells.push({ x, z, kind: g === WALL ? 'wall' : g === BALCONY ? 'balcony' : 'floor' });
    }
  }

  const interior: MezzanineInterior = {
    chunkKey,
    worldSeed,
    width,
    depth,
    cells,
    props,
    lights,
    entry: landing,
    exit: { x: far % width, z: (far - (far % width)) / width },
  };
  const staircase: MezzanineStaircase = {
    chunkKey,
    face,
    baseCell,
    steps,
    topCell,
    landing,
    footprint: glimpseFootprint(chunkKey),
  };
  return { staircase, interior };
}

/**
 * Verify the full stair contract for a generated pair: the approach cell,
 * every riser, and the top cell form one 4-adjacent ascending chain inside
 * the chunk; the landing is walkable; and a 4-neighbour path exists through
 * walkable interior cells from the landing to the exit.
 * @param staircase Staircase descriptor from {@link generateMezzanine}.
 * @param interior Matching interior from {@link generateMezzanine}.
 * @returns True when base→balcony→exit connectivity holds.
 */
export function stairPathExists(
  staircase: MezzanineStaircase,
  interior: MezzanineInterior,
): boolean {
  const adjacent = (
    a: { x: number; z: number },
    b: { x: number; z: number },
  ) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
  const inChunk = (c: { x: number; z: number }) =>
    c.x >= 0 && c.z >= 0 && c.x < CHUNK_CELLS && c.z < CHUNK_CELLS;
  if (!inChunk(staircase.baseCell) || !inChunk(staircase.topCell)) return false;
  if (staircase.steps.length === 0) return false;
  if (!adjacent(staircase.baseCell, staircase.steps[0])) return false;
  let prevRise = 0;
  let prev = staircase.baseCell;
  for (const step of staircase.steps) {
    if (!adjacent(prev, step)) return false;
    if (!(step.rise > prevRise && step.rise <= 1)) return false;
    if (!inChunk(step)) return false;
    prevRise = step.rise;
    prev = step;
  }
  if (!adjacent(prev, staircase.topCell)) return false;
  if (staircase.landing.x !== interior.entry.x || staircase.landing.z !== interior.entry.z) return false;

  const idx = (x: number, z: number) => z * interior.width + x;
  const walkableCells = interior.cells.filter((c) => c.kind !== 'wall');
  const walkableSet = new Set(walkableCells.map((c) => idx(c.x, c.z)));
  if (!walkableSet.has(idx(interior.entry.x, interior.entry.z))) return false;
  const seen = new Set<number>([idx(interior.entry.x, interior.entry.z)]);
  const queue = [idx(interior.entry.x, interior.entry.z)];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const cx = cur % interior.width;
    const cz = (cur - cx) / interior.width;
    for (const [nx, nz] of [[cx - 1, cz], [cx + 1, cz], [cx, cz - 1], [cx, cz + 1]]) {
      if (nx < 0 || nz < 0 || nx >= interior.width || nz >= interior.depth) continue;
      const ni = idx(nx, nz);
      if (!walkableSet.has(ni) || seen.has(ni)) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return seen.has(idx(interior.exit.x, interior.exit.z));
}

/** Walkable area of a mezzanine interior (core floors plus balcony ring), in cells. */
export function mezzanineWalkableArea(interior: MezzanineInterior): number {
  return interior.cells.filter((c) => c.kind !== 'wall').length;
}
