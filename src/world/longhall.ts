/**
 * The Long Hall (F54): a rare 300 m corridor whose exit doors cycle behind
 * you.
 *
 * Pure model, no Babylon imports. A hall descriptor is generated per
 * (seed, chunk) under a rarity gate of roughly one hall per 40 chunks of
 * exploration. Door slots sit at fixed distances along the hall; the door
 * identity assigned to each slot BEHIND the player is rotated through a
 * seeded order every time walkedM crosses a cycle threshold. Forward slots
 * never change - the wrongness only exists where you can no longer look.
 *
 * All randomness derives from src/core/rng.ts hashes, so the same seed and
 * walk timeline always produce identical exit sequences and an identical
 * cycle log.
 */
import { RNG, hash2i } from '../core/rng';

/** Salt so long-hall draws never correlate with any other feature. */
const HALL_SALT = 0x1e54;

/** Corridor length in metres. */
export const HALL_LENGTH_M = 300;

/** Distance between door slots along the corridor, in metres. */
export const DOOR_SPACING_M = 30;

/** Walked distance between successive cycles of the behind-door order. */
export const CYCLE_INTERVAL_M = 60;

/** Expected halls per explored chunk (rarity gate target). */
export const HALLS_PER_CHUNK = 1 / 40;

/**
 * One exit-door slot at a fixed distance along the hall.
 */
export interface DoorSlot {
  /** Distance from the hall entrance in metres; fixed for the slot's life. */
  readonly posM: number;
}

/**
 * Generated descriptor for one Long Hall occurrence. Everything downstream
 * (currentExits, cycle log) is a pure function of this plus walkedM.
 */
export interface LongHallDescriptor {
  /** Master run seed the hall was generated from. */
  readonly seed: number;
  /** Chunk index whose rarity gate produced this hall. */
  readonly chunkIndex: number;
  /** Seeded rotation order over door identities (permutation of 0..N-1). */
  readonly doorOrder: readonly number[];
  /** Fixed slots along the hall, ascending by posM. */
  readonly slots: readonly DoorSlot[];
}

/**
 * One observed exit door at a moment in the walk.
 */
export interface ExitView {
  /** Slot position in metres (stable across cycles). */
  readonly posM: number;
  /** Current door identity shown at this slot. */
  readonly doorId: number;
  /** True when the slot lies behind the walked distance (cycles). */
  readonly behind: boolean;
}

/**
 * One recorded threshold crossing in the cycle log.
 */
export interface CycleEntry {
  /** Cycle index k, reached when walkedM first crossed k*CYCLE_INTERVAL_M. */
  readonly cycleIndex: number;
  /** Threshold in metres that was crossed. */
  readonly thresholdM: number;
  /** Behind-slot door identities after applying this cycle's rotation. */
  readonly behindDoorIds: readonly number[];
}

/**
 * Rarity gate: does exploring `chunkIndex` produce a Long Hall? Deterministic
 * per (seed, chunkIndex); calibrated so ~1 in 40 chunks yields a hall.
 * @param seed Master run seed.
 * @param chunkIndex Index of the explored chunk.
 * @returns True when the chunk hosts a Long Hall.
 */
export function rollLongHallChunk(seed: number, chunkIndex: number): boolean {
  return hash2i(chunkIndex, 0x5eed, seed ^ HALL_SALT) < HALLS_PER_CHUNK * 4294967296;
}

/**
 * Generate the Long Hall descriptor for a gated chunk, or null when the
 * rarity gate rejects it. Deterministic per (seed, chunkIndex).
 * @param seed Master run seed.
 * @param chunkIndex Chunk index that rolled true on rollLongHallChunk.
 * @returns The descriptor, or null when this chunk has no Long Hall.
 */
export function createLongHall(seed: number, chunkIndex: number): LongHallDescriptor | null {
  if (!rollLongHallChunk(seed, chunkIndex)) return null;
  const rr = new RNG(hash2i(seed, chunkIndex, HALL_SALT));
  // Seeded cyclic order: Fisher-Yates over identity permutation 0..9
  // (HALL_LENGTH_M / DOOR_SPACING_M slots).
  const slotCount = Math.floor(HALL_LENGTH_M / DOOR_SPACING_M);
  const order: number[] = Array.from({ length: slotCount }, (_, i) => i);
  for (let i = slotCount - 1; i > 0; i--) {
    const j = rr.int(0, i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const slots: DoorSlot[] = Array.from({ length: slotCount }, (_, i) => ({
    posM: i * DOOR_SPACING_M,
  }));
  return { seed, chunkIndex, doorOrder: order, slots };
}

/**
 * Apply k rotations of the seeded order to the base assignment and report
 * which door id now hangs on each slot. Slots strictly ahead of walkedM keep
 * their base ids (forward exits stable); slots at or behind walkedM rotate.
 * @param hall Descriptor from createLongHall.
 * @param walkedM Distance walked into the hall, clamped to [0, length].
 * @returns Every exit view, ascending by slot position.
 */
export function currentExits(hall: LongHallDescriptor, walkedM: number): ExitView[] {
  const w = Math.max(0, Math.min(HALL_LENGTH_M, walkedM));
  const cycleIndex = Math.floor(w / CYCLE_INTERVAL_M);
  const slotCount = hall.slots.length;
  const views: ExitView[] = [];
  for (let i = 0; i < slotCount; i++) {
    const behind = hall.slots[i].posM <= w;
    // Base id for slot i comes from the un-rotated seeded order; behind slots
    // read their id after `cycleIndex` applications of the rotation.
    const baseIdx = i;
    const rotIdx = (i + cycleIndex) % slotCount;
    const doorId = behind ? hall.doorOrder[rotIdx] : hall.doorOrder[baseIdx];
    views.push({ posM: hall.slots[i].posM, doorId, behind });
  }
  return views;
}

/**
 * Pure replay of the cycle log for a walk timeline: every threshold crossing
 * between fromWalkedM (exclusive, already visited) and toWalkedM, in walking
 * order, with the resulting behind-slot ids. Identical timelines yield
 * byte-identical logs.
 * @param hall Descriptor from createLongHall.
 * @param fromWalkedM Starting walked distance (already consumed thresholds).
 * @param toWalkedM Ending walked distance.
 * @returns Cycle entries for each newly crossed threshold, ascending.
 */
export function cycleLog(
  hall: LongHallDescriptor,
  fromWalkedM: number,
  toWalkedM: number,
): CycleEntry[] {
  const entries: CycleEntry[] = [];
  if (toWalkedM < fromWalkedM) return entries;
  const firstK = Math.floor(Math.max(0, Math.min(HALL_LENGTH_M, fromWalkedM)) / CYCLE_INTERVAL_M);
  const lastK = Math.floor(Math.max(0, Math.min(HALL_LENGTH_M, toWalkedM)) / CYCLE_INTERVAL_M);
  for (let k = firstK + 1; k <= lastK; k++) {
    entries.push({
      cycleIndex: k,
      thresholdM: k * CYCLE_INTERVAL_M,
      behindDoorIds: currentExits(hall, k * CYCLE_INTERVAL_M)
        .filter((v) => v.behind)
        .map((v) => v.doorId),
    });
  }
  return entries;
}

/**
 * Stateful walk tracker over a hall: advance() consumes walked distances and
 * appends to an immutable-by-callers cycle log. Determinism contract: the
 * same sequence of advance() targets produces the same log as the pure
 * cycleLog replay.
 */
export class LongHallWalker {
  private walked: number;
  private log: CycleEntry[];

  /**
   * @param hall Descriptor from createLongHall.
   * @param startWalkedM Initial walked distance (defaults to 0).
   */
  constructor(private readonly hall: LongHallDescriptor, startWalkedM = 0) {
    this.walked = Math.max(0, Math.min(HALL_LENGTH_M, startWalkedM));
    this.log = cycleLog(hall, 0, this.walked);
  }

  /**
   * Advance to a further walked distance and record any crossed thresholds.
   * Backwards motion is ignored (the doors only cycle going deeper).
   * @param walkedM New walked-distance high-water mark in metres.
   * @returns Entries appended by this call.
   */
  advance(walkedM: number): readonly CycleEntry[] {
    const target = Math.max(0, Math.min(HALL_LENGTH_M, walkedM));
    if (target <= this.walked) return [];
    const added = cycleLog(this.hall, this.walked, target);
    this.walked = target;
    this.log = this.log.concat(added);
    return added;
  }

  /** Exits currently visible, per currentExits(hall, walked). */
  currentExits(): ExitView[] {
    return currentExits(this.hall, this.walked);
  }

  /** Full cycle log so far; callers must not mutate. */
  get cycleLog(): readonly CycleEntry[] {
    return this.log;
  }

  /** High-water walked distance in metres. */
  get walkedM(): number {
    return this.walked;
  }
}
