/**
 * Cartographer's error (F56): map fragments disagree; majority vote reveals
 * truth.
 *
 * Pure model, no Babylon imports. A caller injects the ground-truth room
 * grid for a landmark, and this module derives K survey fragments from it,
 * each written by a different seeded cartographer whose labels go wrong
 * independently per cell at rate rho. voteCell/voteGrid take the majority
 * label per cell: whenever fewer than half the fragments mislabel a cell,
 * the vote returns the true label exactly. fragmentReliability scores one
 * fragment by leave-one-out agreement with the other fragments' votes.
 *
 * All randomness derives from src/core/rng.ts hashes, so the fragment set
 * for a given (seed, roomId, rho) replays byte-identically.
 */
import { RNG, hash2i, seedFromString } from '../core/rng';

/** Salt so cartographer draws never correlate with any other feature. */
const FRAGMENT_SALT = 0xca27;

/** Salt so per-cell corruption draws never correlate across fragment slots. */
const CELL_SALT = 0x5e11;

/**
 * A cell label as a cartographer writes it. WALL is sealed masonry, FLOOR
 * is walkable room interior, DOOR is a traversable opening.
 */
export type CellLabel = 'wall' | 'floor' | 'door';

/** Canonical label order; breaks majority-vote ties deterministically. */
export const LABEL_ORDER = ['wall', 'floor', 'door'] as const;

/** The ground-truth layout of one room, row-major. */
export interface RoomGrid {
  /** Cells per row. */
  readonly width: number;
  /** Number of rows. */
  readonly height: number;
  /** Row-major labels; index = y * width + x; length = width * height. */
  readonly cells: readonly CellLabel[];
}

/** One cartographer's copy of a room grid, possibly partly mislabelled. */
export interface MapFragment {
  /** Stable slot of this fragment in the survey (unique seeds derive from it). */
  readonly fragmentIndex: number;
  /** Room the fragment surveys (ChunkDeltas.key idiom, e.g. "3,-2"). */
  readonly roomId: string;
  /** Grid dimensions; every fragment voting on one room shares them. */
  readonly width: number;
  readonly height: number;
  /** Row-major labels, same indexing as RoomGrid. */
  readonly cells: readonly CellLabel[];
}

/**
 * Derive one survey fragment from the ground truth.
 * Pure function of (truth, roomId, fragmentIndex, seed, corruptionRate):
 * each cell flips to a WRONG label (never accidentally correct) with
 * probability corruptionRate under a draw seeded uniquely by
 * (seed, roomId, fragmentIndex, x, y), so two fragments never share a
 * corruption pattern.
 * @param truth Ground-truth grid for the room.
 * @param roomId Stable room identity threaded into the seed mix.
 * @param fragmentIndex Non-negative slot distinguishing this cartographer.
 * @param seed Master run seed.
 * @param corruptionRate Per-cell mislabel probability in [0, 1]; 1 writes
 *   every cell wrong (the lone-liar fixture for vote tests).
 * @returns The fragment, same dimensions as `truth`.
 * @throws When corruptionRate is outside [0, 1] or fragmentIndex is negative.
 */
export function makeFragment(
  truth: RoomGrid,
  roomId: string,
  fragmentIndex: number,
  seed: number,
  corruptionRate: number,
): MapFragment {
  if (!(corruptionRate >= 0) || corruptionRate > 1) {
    throw new Error(`mapfragments: corruptionRate ${corruptionRate} outside [0, 1]`);
  }
  if (!Number.isInteger(fragmentIndex) || fragmentIndex < 0) {
    throw new Error(`mapfragments: fragmentIndex ${fragmentIndex} must be a non-negative integer`);
  }
  const fragSeed = hash2i(seedFromString(roomId), fragmentIndex, seed ^ FRAGMENT_SALT);
  const cells: CellLabel[] = new Array(truth.cells.length);
  for (let y = 0; y < truth.height; y++) {
    for (let x = 0; x < truth.width; x++) {
      const i = y * truth.width + x;
      const true_ = truth.cells[i];
      const rr = new RNG(hash2i(x, y, fragSeed ^ CELL_SALT));
      if (rr.next() < corruptionRate) {
        // Flip to a definite wrong label: pick among the non-true labels.
        const wrongs = LABEL_ORDER.filter((l) => l !== true_);
        cells[i] = wrongs[rr.int(0, wrongs.length)];
      } else {
        cells[i] = true_;
      }
    }
  }
  return { fragmentIndex, roomId, width: truth.width, height: truth.height, cells };
}

/**
 * Validate a fragment set before voting: all fragments present, dimension
 * matched, coordinates in range.
 * @throws When fragments is empty, a fragment's dimensions differ from the
 *   first fragment's, or (x, y) falls outside the shared grid.
 */
function validateVoters(fragments: readonly MapFragment[], x?: number, y?: number): void {
  if (fragments.length === 0) throw new Error('mapfragments: vote needs at least one fragment');
  const { width, height } = fragments[0];
  for (let f = 1; f < fragments.length; f++) {
    if (fragments[f].width !== width || fragments[f].height !== height) {
      throw new Error(
        `mapfragments: fragment ${f} dims ${fragments[f].width}x${fragments[f].height}` +
        ` differ from ${width}x${height}`,
      );
    }
  }
  if (x !== undefined && y !== undefined && (x < 0 || y < 0 || x >= width || y >= height)) {
    throw new Error(`mapfragments: cell (${x}, ${y}) outside ${width}x${height} grid`);
  }
}

/**
 * Majority label for one cell across the fragment set. Ties - possible only
 * with an even fragment count - resolve to the tied label earliest in
 * LABEL_ORDER ('wall', then 'floor', then 'door'), so the result is a pure
 * function of the fragment contents alone.
 * @param fragments Fragments of one room; must share dimensions.
 * @param x Column.
 * @param y Row.
 * @returns The winning label for that cell.
 * @throws On an empty set, mismatched fragment dimensions, or out-of-range cell.
 */
export function voteCell(fragments: readonly MapFragment[], x: number, y: number): CellLabel {
  validateVoters(fragments, x, y);
  let wall = 0, floor = 0, door = 0;
  for (const f of fragments) {
    if (f.cells[y * f.width + x] === 'wall') wall++;
    else if (f.cells[y * f.width + x] === 'floor') floor++;
    else door++;
  }
  const counts: [CellLabel, number][] = [['wall', wall], ['floor', floor], ['door', door]];
  let best = counts[0];
  for (const c of counts) {
    // Strict > keeps the earlier LABEL_ORDER entry on ties.
    if (c[1] > best[1]) best = c;
  }
  return best[0];
}

/**
 * Majority-voted reconstruction of the whole room grid.
 * @param fragments Fragments of one room; must share dimensions.
 * @returns The voted grid, same dimensions as the fragments.
 * @throws Under the same conditions as voteCell.
 */
export function voteGrid(fragments: readonly MapFragment[]): RoomGrid {
  validateVoters(fragments);
  const { width, height } = fragments[0];
  const cells: CellLabel[] = new Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cells[y * width + x] = voteCell(fragments, x, y);
    }
  }
  return { width, height, cells };
}

/**
 * Leave-one-out reliability of one fragment: the fraction of cells where
 * the fragment agrees with the majority of the OTHER fragments. A lone
 * corrupt cartographer scores near 0 against clean peers; clean fragments
 * score near 1.
 * @param fragments Fragments of one room; needs at least 2 so the
 *   leave-one-out vote has a voter left.
 * @param fragmentIndex Slot of the fragment to score.
 * @returns Agreement fraction in [0, 1].
 * @throws When fewer than 2 fragments are given or no fragment occupies
 *   `fragmentIndex`.
 */
export function fragmentReliability(
  fragments: readonly MapFragment[],
  fragmentIndex: number,
): number {
  if (fragments.length < 2) {
    throw new Error('mapfragments: reliability needs at least 2 fragments');
  }
  const target = fragments.find((f) => f.fragmentIndex === fragmentIndex);
  if (!target) throw new Error(`mapfragments: no fragment with index ${fragmentIndex}`);
  const others = fragments.filter((f) => f !== target);
  let agree = 0;
  const total = target.width * target.height;
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      if (target.cells[y * target.width + x] === voteCell(others, x, y)) agree++;
    }
  }
  return agree / total;
}
