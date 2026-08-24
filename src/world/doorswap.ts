/**
 * Door/wall swaps (F23): the place rebuilds its own openings wrong.
 *
 * A door opens into solid wall while an adjacent wall becomes a door. The
 * swap is expressed as ONE atomic multi-cell write over an injected cell-grid
 * model, so a grid is never observably half-swapped: callers hand us a grid
 * whose `putCells` applies every entry before the next read, and this module
 * issues exactly one such call per swap or revert. Like ChunkDeltas, nothing
 * here rewrites canonical generation - swaps are session mutations a mesher
 * consumes through the cell markers, and revertSwap restores byte-identical
 * prior cells.
 */
import { RNG, hash3i } from '../core/rng';

/** Salt so swap-variant draws never correlate with any other feature. */
const SWAP_SALT = 0x0d00;

/** Mesher-facing marker for a cell: open floor, solid wall, or doorway. */
export type SwapMarker = 'open' | 'wall' | 'door';

/**
 * One mutable cell of the injected grid. Invariants the mesher relies on:
 * `wall` cells are never navigable and always collide; `door`/`open` cells
 * are navigable and collision-free.
 */
export interface SwapCell {
  /** Mesher-facing marker consumed by chunk rebuilds. */
  marker: SwapMarker;
  /** Whether agents may path through this cell. */
  nav: boolean;
  /** Whether the collision world blocks movement through this cell. */
  solid: boolean;
}

/** One pending cell write inside an atomic bulk write. */
export interface CellWrite {
  /** Grid x coordinate of the cell to write. */
  x: number;
  /** Grid z coordinate of the cell to write. */
  z: number;
  /** The complete replacement cell. */
  cell: SwapCell;
}

/**
 * Cell-grid model the swap operates on. Implementations own storage; the
 * atomicity contract lives in `putCells`: every entry must be applied before
 * `putCells` returns and before any subsequent `getCell` observation, so a
 * freeze-and-inspect probe sees either all-old or all-new state.
 */
export interface SwapGrid {
  /** Read one cell, or undefined when the coordinate was never written. */
  getCell(x: number, z: number): SwapCell | undefined;
  /** Apply every write as one unit - no partial application may be observed. */
  putCells(writes: readonly CellWrite[]): void;
}

/** Coordinates naming one cell of the grid. */
export interface CellCoord {
  /** Grid x coordinate. */
  x: number;
  /** Grid z coordinate. */
  z: number;
}

/** Canonical wall cell: solid, impassable, mesher renders wallpaper. */
export function wallCell(): SwapCell {
  return { marker: 'wall', nav: false, solid: true };
}

/** Canonical doorway cell: passable, no collision, mesher renders a frame. */
export function doorCell(): SwapCell {
  return { marker: 'door', nav: true, solid: false };
}

/** Canonical open floor cell: passable, no collision, no architecture. */
export function openCell(): SwapCell {
  return { marker: 'open', nav: true, solid: false };
}

function cloneCell(c: SwapCell): SwapCell {
  return { marker: c.marker, nav: c.nav, solid: c.solid };
}

/** Prior and replacement state of one swapped cell, for revert + audit. */
export interface SwappedSide {
  /** Coordinate of the cell. */
  x: number;
  z: number;
  /** Byte-identical snapshot taken before the swap. */
  before: SwapCell;
  /** State written by the swap. */
  after: SwapCell;
}

/**
 * Revert record for one applied swap. Holds complete prior cells so
 * revertSwap restores the grid exactly, with no dependence on current state.
 */
export interface DoorWallSwapRecord {
  /** Seed the swap variant was derived from. */
  seed: number;
  /** Former door: became solid wall (opens into wall). */
  door: SwappedSide;
  /** Former wall: became a doorway. */
  wall: SwappedSide;
  /** Seeded doorway variant (0..3) for the new door's mesh dressing. */
  doorVariant: number;
}

/**
 * Verify the marker/nav/solid invariants on both sides of a swap record
 * against live grid state. Throws when any observed cell disagrees with its
 * expected post-swap values - the nav+collision+mesh consistency gate.
 * @param grid Grid the swap was applied to.
 * @param record Record returned by swapDoorWall.
 */
export function assertSwapConsistent(grid: SwapGrid, record: DoorWallSwapRecord): void {
  const check = (side: SwappedSide): void => {
    const c = grid.getCell(side.x, side.z);
    if (!c) throw new Error(`doorswap: cell ${side.x},${side.z} missing after swap`);
    if (c.marker !== side.after.marker || c.nav !== side.after.nav || c.solid !== side.after.solid) {
      throw new Error(
        `doorswap: inconsistent cell ${side.x},${side.z}` +
        ` marker=${c.marker} nav=${c.nav} solid=${c.solid}`,
      );
    }
    if ((c.marker === 'wall') !== !c.nav) throw new Error(`doorswap: wall/nav mismatch at ${side.x},${side.z}`);
    if ((c.marker === 'wall') !== c.solid) throw new Error(`doorswap: wall/collision mismatch at ${side.x},${side.z}`);
  };
  check(record.door);
  check(record.wall);
}

/**
 * Atomic door/wall swap: validate, then flip both cells in ONE delta record
 * issued as a single bulk write. Deterministic per (seed, coord pair) - the
 * only seeded output is the new door's variant, drawn from rng.ts hashes.
 * @param grid Injected cell-grid model.
 * @param doorCoord Coordinate that must currently hold a doorway cell.
 * @param wallCoord Coordinate that must currently hold a solid wall cell.
 * @param seed Master run seed.
 * @returns The revert record; pass it to revertSwap to undo byte-identically.
 * @throws When the coordinates coincide, the door is missing/not a door, or
 *   the target is not solid wall - swaps fail loud rather than partially.
 */
export function swapDoorWall(
  grid: SwapGrid,
  doorCoord: CellCoord,
  wallCoord: CellCoord,
  seed: number,
): DoorWallSwapRecord {
  if (doorCoord.x === wallCoord.x && doorCoord.z === wallCoord.z) {
    throw new Error('doorswap: door and wall coordinates coincide');
  }
  const before = (coord: CellCoord): SwapCell => {
    const c = grid.getCell(coord.x, coord.z);
    if (!c) throw new Error(`doorswap: no cell at ${coord.x},${coord.z}`);
    return cloneCell(c);
  };
  const doorBefore = before(doorCoord);
  const wallBefore = before(wallCoord);
  if (doorBefore.marker !== 'door' || !doorBefore.nav || doorBefore.solid) {
    throw new Error(
      `doorswap: ${doorCoord.x},${doorCoord.z} is not an open door` +
      ` (marker=${doorBefore.marker})`,
    );
  }
  if (wallBefore.marker !== 'wall' || wallBefore.nav || !wallBefore.solid) {
    throw new Error(
      `doorswap: ${wallCoord.x},${wallCoord.z} is not solid wall` +
      ` (marker=${wallBefore.marker})`,
    );
  }
  const rr = new RNG(hash3i(doorCoord.x, doorCoord.z, hash3i(wallCoord.x, wallCoord.z, seed), SWAP_SALT));
  const doorVariant = rr.int(0, 4);
  const doorAfter = wallCell();
  const wallAfter = doorCell();
  // Single atomic multi-cell write: observers see both flipped or neither.
  grid.putCells([
    { x: doorCoord.x, z: doorCoord.z, cell: doorAfter },
    { x: wallCoord.x, z: wallCoord.z, cell: wallAfter },
  ]);
  const record: DoorWallSwapRecord = {
    seed,
    door: { x: doorCoord.x, z: doorCoord.z, before: doorBefore, after: doorAfter },
    wall: { x: wallCoord.x, z: wallCoord.z, before: wallBefore, after: wallAfter },
    doorVariant,
  };
  assertSwapConsistent(grid, record);
  return record;
}

/**
 * Undo one applied swap by restoring both prior cells in a single bulk
 * write. After revert, the affected coordinates compare byte-identical
 * (deep-equal cells) to their pre-swap state.
 * @param grid Grid the swap was applied to.
 * @param record Record returned by swapDoorWall.
 */
export function revertSwap(grid: SwapGrid, record: DoorWallSwapRecord): void {
  grid.putCells([
    { x: record.door.x, z: record.door.z, cell: cloneCell(record.door.before) },
    { x: record.wall.x, z: record.wall.z, cell: cloneCell(record.wall.before) },
  ]);
}
