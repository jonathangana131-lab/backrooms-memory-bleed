/**
 * Pocket dimensions (F15): certain doors open into interiors far larger than
 * their exterior frontage could contain. Given (worldSeed, doorKey) the
 * generator derives a private RNG stream and lays out a full interior grid -
 * walls, rooms, props, lights, an exit - as a pure function of those inputs,
 * so any session regenerates the same pocket byte-for-byte. The exterior
 * world only ever sees the small fixed footprint reported separately; the
 * interior dimensions never leak back into facade generation.
 */
import { RNG, hash2i, seedFromString } from '../core/rng';
import type { PropKind, PropInstance, LightFixture } from './architect';

/** Salt isolating pocket-dimension draws from every other hashed feature. */
const POCKET_SALT = 0x70cd;

/** Minimum interior width in cells - already wider than any door frontage. */
export const MIN_INTERIOR_WIDTH = 10;
/** Minimum interior depth in cells. */
export const MIN_INTERIOR_DEPTH = 12;

/** Exterior frontage a pocket door occupies, in cells - fixed, never grown. */
export const FOOTPRINT_CELLS_WIDE = 3;
/** Exterior depth behind the door plane occupied outside, in cells. */
export const FOOTPRINT_CELLS_DEEP = 1;

/** Cardinal wall a door sits on, in key suffix form. */
export type DoorFace = 'n' | 's' | 'e' | 'w';

/** A parsed pocket-door identity. */
export interface DoorRef {
  /** Door cell x in world-cell coordinates. */
  x: number;
  /** Door cell z in world-cell coordinates. */
  z: number;
  /** Which exterior wall the door faces. */
  face: DoorFace;
}

/**
 * Exterior-facing footprint metadata: what the outside building reserves for
 * this door. Deliberately independent of interior size - facades never learn
 * how deep the pocket goes.
 */
export interface PocketFootprint {
  /** Door cell x (mirrors DoorRef). */
  doorX: number;
  /** Door cell z (mirrors DoorRef). */
  doorZ: number;
  /** Exterior wall the door faces. */
  face: DoorFace;
  /** Frontage width reserved outside, in cells (constant). */
  cellsWide: number;
  /** Depth reserved outside, in cells (constant). */
  cellsDeep: number;
}

/** One interior grid cell of a pocket. */
export interface PocketCell {
  /** Cell x within the interior grid. */
  x: number;
  /** Cell z within the interior grid. */
  z: number;
  /** Solid wall or walkable floor. */
  kind: 'wall' | 'floor';
}

/** A generated pocket dimension interior. Pure data, JSON-serializable. */
export interface PocketInterior {
  /** Door key this pocket hangs from. */
  doorKey: string;
  /** World seed the pocket was generated from. */
  worldSeed: number;
  /** Exterior footprint (small, constant-sized). */
  footprint: PocketFootprint;
  /** Interior grid width in cells (independent of footprint). */
  width: number;
  /** Interior grid depth in cells (independent of footprint). */
  depth: number;
  /** Every cell of the interior, row-major by z then x. */
  cells: PocketCell[];
  /** Furnishings placed inside the pocket. */
  props: PropInstance[];
  /** Light fixtures hung inside the pocket. */
  lights: LightFixture[];
  /** Walkable cell of the way out (farthest from the entry). */
  exit: { x: number; z: number };
}

/** Furniture the pocket furnisher may place. */
const POCKET_PROPS: readonly PropKind[] = [
  'desk', 'chair', 'cabinet', 'sofa', 'bed', 'locker', 'crate', 'shelf',
];

/**
 * Parse a door key of the form "<x>,<z>:<face>".
 * @param key Door key as issued by the chunk/door layer, e.g. '12,7:n'.
 * @returns The parsed door reference.
 * @throws When the key is malformed - bad keys fail loud, never silently map.
 */
export function parseDoorKey(key: string): DoorRef {
  const m = /^(-?\d+),(-?\d+):([nsew])$/.exec(key);
  if (!m) throw new Error('malformed pocket door key: ' + key);
  return { x: Number(m[1]), z: Number(m[2]), face: m[3] as DoorFace };
}

/**
 * Exterior footprint for a pocket door - what the outside building accounts
 * for. Constant-sized by design: interiors vary wildly, facades never change.
 * @param key Door key of the pocket entrance.
 * @returns Fixed footprint metadata for the door's exterior frontage.
 */
export function pocketFootprint(key: string): PocketFootprint {
  const door = parseDoorKey(key);
  return {
    doorX: door.x,
    doorZ: door.z,
    face: door.face,
    cellsWide: FOOTPRINT_CELLS_WIDE,
    cellsDeep: FOOTPRINT_CELLS_DEEP,
  };
}

/** Entry cell of an interior for a given door face. */
function entryCell(face: DoorFace, width: number, depth: number, rng: RNG): { x: number; z: number } {
  switch (face) {
    case 'n': return { x: 1 + rng.int(1, width - 2), z: 0 };
    case 's': return { x: 1 + rng.int(1, width - 2), z: depth - 1 };
    case 'w': return { x: 0, z: 1 + rng.int(1, depth - 2) };
    case 'e': return { x: width - 1, z: 1 + rng.int(1, depth - 2) };
  }
}

/**
 * Generate the interior of a pocket dimension.
 * Pure function of (worldSeed, doorKey): the whole layout flows from one
 * hashed RNG stream, so regeneration is byte-identical for identical inputs
 * and different keys derive independent streams (no collisions in practice).
 * @param worldSeed Master run seed.
 * @param doorKey Door key of the pocket entrance, e.g. '12,7:n'.
 * @returns The complete interior layout, strictly larger than the exterior footprint.
 */
export function generatePocketInterior(worldSeed: number, doorKey: string): PocketInterior {
  const door = parseDoorKey(doorKey);
  const rng = new RNG(hash2i(seedFromString(doorKey), worldSeed, POCKET_SALT));

  const width = rng.int(MIN_INTERIOR_WIDTH, MIN_INTERIOR_WIDTH + 8);
  const depth = rng.int(MIN_INTERIOR_DEPTH, MIN_INTERIOR_DEPTH + 9);

  // Border-walled slab, then carve the walkable interior.
  const grid: Uint8Array = new Uint8Array(width * depth).fill(1);
  const FLOOR = 0;
  const at = (x: number, z: number) => z * width + x;
  for (let z = 1; z < depth - 1; z++) {
    for (let x = 1; x < width - 1; x++) grid[at(x, z)] = FLOOR;
  }

  // Internal partitions: wall lines with gaps, so rooms form but connect.
  const partitions = 2 + rng.int(0, 4);
  for (let p = 0; p < partitions; p++) {
    const horizontal = rng.chance(0.5);
    if (horizontal) {
      const z = 2 + rng.int(0, depth - 4);
      const gap = 1 + rng.int(0, width - 2);
      for (let x = 1; x < width - 1; x++) if (x !== gap) grid[at(x, z)] = 1;
    } else {
      const x = 2 + rng.int(0, width - 4);
      const gap = 1 + rng.int(0, depth - 2);
      for (let z = 1; z < depth - 1; z++) if (z !== gap) grid[at(x, z)] = 1;
    }
  }

  const entry = entryCell(door.face, width, depth, rng);
  grid[at(entry.x, entry.z)] = FLOOR;
  const inw = entry.x === 0 ? 1 : entry.x === width - 1 ? -1 : 0;
  const ind = entry.z === 0 ? 1 : entry.z === depth - 1 ? -1 : 0;
  grid[at(entry.x + inw, entry.z + ind)] = FLOOR;

  // Connectivity repair: flood from entry, knock holes until all floors reach.
  const reach = new Uint8Array(width * depth);
  const stack: number[] = [at(entry.x, entry.z)];
  reach[at(entry.x, entry.z)] = 1;
  let reached = 1;
  let totalFloors = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === FLOOR) totalFloors++;
  let guard = width * depth;
  while (reached < totalFloors && guard-- > 0) {
    stack.length = 0;
    reach.fill(0);
    stack.push(at(entry.x, entry.z));
    reach[at(entry.x, entry.z)] = 1;
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
        if (reach[nbrs[n]] || grid[nbrs[n]] !== FLOOR) continue;
        reach[nbrs[n]] = 1;
        count++;
        stack.push(nbrs[n]);
      }
    }
    if (count >= totalFloors) break;
    // Open one wall between reached and unreached space.
    let opened = false;
    for (let z = 1; z < depth - 1 && !opened; z++) {
      for (let x = 1; x < width - 1 && !opened; x++) {
        const i = at(x, z);
        if (grid[i] !== 1) continue;
        const nb =
          (x > 0 && reach[i - 1] === 1) || (x < width - 1 && reach[i + 1] === 1) ||
          (z > 0 && reach[i - width] === 1) || (z < depth - 1 && reach[i + width] === 1);
        if (nb) { grid[i] = FLOOR; opened = true; totalFloors++; }
      }
    }
    if (!opened) break;
  }

  // Furnish: wall-hugging props, sparse hanging lights.
  const props: PropInstance[] = [];
  const lights: LightFixture[] = [];
  const maxProps = Math.floor((width * depth) / 14);
  for (let z = 1; z < depth - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      if (grid[at(x, z)] !== FLOOR) continue;
      const nearWall =
        grid[at(x - 1, z)] === 1 || grid[at(x + 1, z)] === 1 ||
        grid[at(x, z - 1)] === 1 || grid[at(x, z + 1)] === 1;
      if (nearWall && props.length < maxProps && rng.chance(0.09)) {
        props.push({
          kind: rng.pick(POCKET_PROPS),
          x: x + 0.5,
          z: z + 0.5,
          rot: rng.int(0, 4) as PropInstance['rot'],
          variant: rng.int(0, 4),
        });
      }
      if ((x + z) % 3 === 0 && lights.length < 64 && rng.chance(0.35)) {
        lights.push({ x: x + 0.5, z: z + 0.5, flicker: rng.range(0.04, 0.6), alive: true });
      }
    }
  }

  // Exit: farthest reachable floor cell from the entry (BFS distance).
  const dist = new Int32Array(width * depth).fill(-1);
  const q: number[] = [at(entry.x, entry.z)];
  dist[q[0]] = 0;
  let head = 0;
  let far = q[0];
  while (head < q.length) {
    const cur = q[head++];
    const cx = cur % width;
    const cz = (cur - cx) / width;
    const nbrs = [[cx - 1, cz], [cx + 1, cz], [cx, cz - 1], [cx, cz + 1]];
    for (const [nx, nz] of nbrs) {
      if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
      const ni = at(nx, nz);
      if (dist[ni] !== -1 || grid[ni] !== FLOOR) continue;
      dist[ni] = dist[cur] + 1;
      if (dist[ni] > dist[far]) far = ni;
      q.push(ni);
    }
  }

  const cells: PocketCell[] = [];
  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      cells.push({ x, z, kind: grid[at(x, z)] === FLOOR ? 'floor' : 'wall' });
    }
  }

  return {
    doorKey,
    worldSeed,
    footprint: pocketFootprint(doorKey),
    width,
    depth,
    cells,
    props,
    lights,
    exit: { x: far % width, z: (far - (far % width)) / width },
  };
}

/** Floor-area of an interior, in cells. */
export function pocketArea(interior: PocketInterior): number {
  return interior.cells.filter((c) => c.kind === 'floor').length;
}
