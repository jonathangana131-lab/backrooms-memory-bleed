/**
 * Sub-floor crawlspaces (F58): floor gaps reveal crawlspace darkness beneath.
 *
 * Pure model, no Babylon imports. A caller injects the floor-cell grid of the
 * streamed world; this module picks seeded gap cells (~1 gap per 6 chunks)
 * among floor cells and derives the under-floor pocket under each gap.
 * Entering a gap cell lowers the player onto a shallow crawlspace layer
 * (CRAWL_Y_OFFSET below the surface floor) instead of a killing fall: gap
 * cells carry { crawlable, fallSafe } nav flags. Every pocket is closed —
 * its boundary ring is wall at the under-floor layer, so a player can never
 * wander from a pocket into the void — and climb-out happens at the gap rim,
 * directly beneath the gap column.
 *
 * All selection randomness derives from src/core/rng.ts hashes, so the gap
 * layout for a given (grid, seed) replays identically in any session order.
 */
import { RNG, hash2i } from '../core/rng';
import { CHUNK_CELLS } from './constants';

/** Salt so gap draws never correlate with any other feature. */
const GAP_SALT = 0x0ba5;

/**
 * Expected fraction of chunks that contain one gap. The plan calls for
 * roughly 1 gap per 6 chunks; each chunk rolls this chance exactly once.
 */
export const GAP_CHUNK_RATE = 1 / 6;

/** Depth of the under-floor layer relative to the surface floor, meters. */
export const CRAWL_Y_OFFSET = -1.2;

/**
 * Half-width of a pocket footprint: pockets are (2 * POCKET_HALF + 1)^2 cells
 * of open crawlspace under the floor, centred on their gap cell.
 */
export const POCKET_HALF = 1;

/** Seeded probe draws per gapped chunk before giving up on finding floor. */
const CANDIDATE_ATTEMPTS = 16;

/** Nav flags for one cell as the crawler exposes them to navigation code. */
export interface CrawlCellFlags {
  /** True when the under-floor layer accepts player movement on this cell. */
  readonly crawlable: boolean;
  /** True when entering this cell can never be lethal (no killing fall). */
  readonly fallSafe: boolean;
}

/** Injected view of the world's walkable floor, in world cell coordinates. */
export interface FloorGrid {
  /** Number of streamed chunks along x that participate in gap selection. */
  readonly chunksX: number;
  /** Number of streamed chunks along z that participate in gap selection. */
  readonly chunksZ: number;
  /**
   * True when the world cell (cellX, cellZ) is walkable floor at surface
   * level. Pure predicate over already-generated geometry.
   */
  readonly isFloor: (cellX: number, cellZ: number) => boolean;
}

/** One gap column and the chunk whose roll selected it. */
export interface GapCell {
  /** World cell coordinate of the gap opening, along x. */
  readonly cellX: number;
  /** World cell coordinate of the gap opening, along z. */
  readonly cellZ: number;
}

/** Serializable snapshot of a crawlspace field's selected gaps. */
export interface CrawlspaceSave {
  /** Format tag, bumped on any incompatible change. */
  readonly version: 1;
  /** Master run seed the gaps were selected with. */
  readonly seed: number;
  /** Selected gaps in stable (cellZ, cellX) order. */
  readonly gaps: readonly GapCell[];
}

/**
 * Deterministic crawlspace model over an injected floor grid.
 * Constructing one selects all gaps up front, so queries are pure lookups
 * and two models built from the same (grid, seed) agree on every answer.
 */
export class CrawlspaceModel {
  /** Master run seed threaded into every gap draw. */
  readonly seed: number;
  private readonly grid: FloorGrid;
  private readonly gapSet: Map<string, GapCell> = new Map();

  constructor(grid: FloorGrid, seed: number) {
    if (!Number.isInteger(grid.chunksX) || grid.chunksX < 0) {
      throw new Error(`crawlspaces: chunksX ${grid.chunksX} must be a non-negative integer`);
    }
    if (!Number.isInteger(grid.chunksZ) || grid.chunksZ < 0) {
      throw new Error(`crawlspaces: chunksZ ${grid.chunksZ} must be a non-negative integer`);
    }
    if (typeof grid.isFloor !== 'function') {
      throw new Error('crawlspaces: grid.isFloor must be a function');
    }
    this.grid = grid;
    this.seed = seed;
    for (let cz = 0; cz < grid.chunksZ; cz++) {
      for (let cx = 0; cx < grid.chunksX; cx++) {
        const gap = selectChunkGap(grid, cx, cz, seed);
        if (gap) this.gapSet.set(gapKey(gap.cellX, gap.cellZ), gap);
      }
    }
  }

  /** All selected gaps in stable (cellZ, cellX) order. */
  gaps(): GapCell[] {
    return [...this.gapSet.values()].sort((a, b) =>
      a.cellZ !== b.cellZ ? a.cellZ - b.cellZ : a.cellX - b.cellX,
    );
  }

  /**
   * True when the world cell opens into a crawlspace pocket.
   * @param cellX World cell coordinate along x.
   * @param cellZ World cell coordinate along z.
   */
  isGap(cellX: number, cellZ: number): boolean {
    return this.gapSet.has(gapKey(cellX, cellZ));
  }

  /**
   * Nav flags for one world cell. Gap cells report
   * { crawlable: true, fallSafe: true }; every other cell reports null —
   * the injected grid's own flags stay untouched and authoritative there.
   * @param cellX World cell coordinate along x.
   * @param cellZ World cell coordinate along z.
   */
  flagsAt(cellX: number, cellZ: number): CrawlCellFlags | null {
    return this.gapSet.has(gapKey(cellX, cellZ)) ? { crawlable: true, fallSafe: true } : null;
  }

  /**
   * Surface y after entering the pocket beneath (cellX, cellZ): the shallow
   * crawlspace layer, never a long fall.
   * @param baseSurfaceY Floor y at the gap rim before entry.
   */
  enterY(baseSurfaceY: number): number {
    return baseSurfaceY + CRAWL_Y_OFFSET;
  }

  /**
   * Open under-floor cells of the pocket beneath `gap`, centre first then
   * ring order. Pocket footprints may overlap when two gaps sit close; each
   * call lists its own footprint without deduplication against others.
   * @param gap A gap returned by gaps() or coordinates answering isGap().
   */
  pocketInterior(gap: GapCell): GapCell[] {
    const cells: GapCell[] = [];
    for (let dz = -POCKET_HALF; dz <= POCKET_HALF; dz++) {
      for (let dx = -POCKET_HALF; dx <= POCKET_HALF; dx++) {
        cells.push({ cellX: gap.cellX + dx, cellZ: gap.cellZ + dz });
      }
    }
    return cells;
  }

  /**
   * Wall cells ringing a pocket at the under-floor layer. Stepping onto any
   * of them is blocked, which is what keeps the pocket closed.
   * @param gap A gap answering isGap().
   */
  pocketWallRing(gap: GapCell): GapCell[] {
    const r = POCKET_HALF + 1;
    const cells: GapCell[] = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const edge = Math.max(Math.abs(dx), Math.abs(dz));
        if (edge === r) cells.push({ cellX: gap.cellX + dx, cellZ: gap.cellZ + dz });
      }
    }
    return cells;
  }

  /**
   * True when (cellX, cellZ) lies inside some pocket's open footprint.
   * @param cellX World cell coordinate along x.
   * @param cellZ World cell coordinate along z.
   */
  isUnderFloor(cellX: number, cellZ: number): boolean {
    for (let dz = -POCKET_HALF; dz <= POCKET_HALF; dz++) {
      for (let dx = -POCKET_HALF; dx <= POCKET_HALF; dx++) {
        if (this.gapSet.has(gapKey(cellX - dx, cellZ - dz))) return true;
      }
    }
    return false;
  }

  /**
   * Climb-out check at the under-floor layer. A player can leave a pocket
   * only by climbing the gap rim: standing in the gap column itself. Wall
   * ring cells refuse; interior cells off the gap column must walk to it.
   * @param cellX Player's under-floor cell along x.
   * @param cellZ Player's under-floor cell along z.
   * @returns True when the player stands at a gap rim and can climb out.
   */
  canClimbOut(cellX: number, cellZ: number): boolean {
    return this.gapSet.has(gapKey(cellX, cellZ));
  }

  /**
   * Snapshot the field for the save system. Round-trips through
   * deserialize() byte-for-byte.
   */
  serialize(): CrawlspaceSave {
    return { version: 1, seed: this.seed, gaps: this.gaps() };
  }

  /**
   * Rebuild a serialized field without re-rolling selection. The result
   * answers isGap/flagsAt/pocket queries identically to the original.
   * @param save A snapshot produced by serialize() of the same format tag.
   * @throws On a foreign format tag or a non-array gap list.
   */
  static deserialize(save: CrawlspaceSave): CrawlspaceModel {
    if (save?.version !== 1 || !Array.isArray(save.gaps)) {
      throw new Error('crawlspaces: malformed save (expected version 1 with a gaps array)');
    }
    const fakeGrid: FloorGrid = { chunksX: 0, chunksZ: 0, isFloor: () => false };
    const model = new CrawlspaceModel(fakeGrid, save.seed);
    for (const g of save.gaps) {
      if (
        typeof g !== 'object' || g === null ||
        !Number.isInteger(g.cellX) || !Number.isInteger(g.cellZ)
      ) {
        throw new Error('crawlspaces: malformed gap entry in save');
      }
      model.gapSet.set(gapKey(g.cellX, g.cellZ), { cellX: g.cellX, cellZ: g.cellZ });
    }
    return model;
  }
}

function gapKey(cellX: number, cellZ: number): string {
  return `${cellX},${cellZ}`;
}

/**
 * Roll whether chunk (chunkX, chunkZ) hosts a gap and, if so, pick the gap
 * cell among that chunk's floor cells. Pure function of (grid, seed,
 * chunk): one rate draw decides presence, then up to CANDIDATE_ATTEMPTS
 * seeded draws probe local cells until one is walkable floor, so results
 * replay identically regardless of query order. A chunk that rolls a gap
 * but has no walkable cell after the attempts yields none — absence of
 * floor is never forced into presence of a gap.
 * @returns The gap cell in world coordinates, or null.
 */
function selectChunkGap(
  grid: FloorGrid,
  chunkX: number,
  chunkZ: number,
  seed: number,
): GapCell | null {
  const rr = new RNG(hash2i(chunkX, chunkZ, seed ^ GAP_SALT));
  if (rr.next() >= GAP_CHUNK_RATE) return null;
  const baseX = chunkX * CHUNK_CELLS;
  const baseZ = chunkZ * CHUNK_CELLS;
  for (let attempt = 0; attempt < CANDIDATE_ATTEMPTS; attempt++) {
    const lx = rr.int(0, CHUNK_CELLS);
    const lz = rr.int(0, CHUNK_CELLS);
    const cellX = baseX + lx;
    const cellZ = baseZ + lz;
    if (grid.isFloor(cellX, cellZ)) return { cellX, cellZ };
  }
  return null;
}
