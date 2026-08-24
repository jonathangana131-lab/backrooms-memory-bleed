/**
 * ChunkDeltas: a reversible per-chunk mutation ledger.
 *
 * Anomaly phenomena (see director/anomalies.ts) may not rewrite generated
 * layouts directly - regeneration from (seed, cx, cz) must stay canonical.
 * Instead they bump a per-chunk drift counter here; chunk builds fold that
 * counter into their decor RNG, so every rebuild of a drifted chunk shows
 * the SAME drifted decor while revertAll() restores the canonical world on
 * the next rebuild. The counter is the only extra input to generation.
 *
 * Two further reversible ledgers live here:
 *   BRICKED EDGES   blackout rearrangement (F16) persists one EdgeCode.SOLID
 *                   override per affected chunk for the door it bricked;
 *                   builds consult it so the brick survives rebuilds and it
 *                   is dropped at the NEXT blackout (clearBrickEdges) or by
 *                   revertAll/revertBlackoutShift.
 *   CELL OVERRIDES  door/wall swaps (F23) write their nav+collision+mesher
 *                   markers through DeltasSwapGrid as one bulk putCellOverrides
 *                   call; revertAll removes every override so rebuilds come
 *                   out byte-identically canonical again.
 */
import { RNG, hash2i, hash3i } from '../core/rng';
import type { PropInstance } from './architect';
import type { SwapCell, SwapGrid, CellWrite } from './doorswap';

/** Salt so drift draws never correlate with any other per-chunk feature. */
const DRIFT_SALT = 0x61d7;

/** Salt so blackout draws never correlate with drift or any other feature. */
const BLACKOUT_SALT = 0x6c61;

/** Furniture the drift is allowed to shuffle (matches landmark rearranging). */
const MOVABLE = new Set<string>([
  'desk', 'chair', 'bench', 'crate', 'stacked_chairs', 'gurney',
  'cabinet', 'sofa', 'bed', 'locker', 'planter', 'tv', 'cooler', 'shelf',
]);

/** Furthest a single drift step may slide one prop (metres). */
export const DRIFT_SLIDE_MAX = 0.45;
export class ChunkDeltas {
  private steps = new Map<string, number>();
  /** Ordinals of blackout shifts already folded into each chunk. */
  private blackoutOrdinals = new Map<string, Set<number>>();
  /** Bricked-door SOLID overrides, keyed like steps with the door edge id. */
  private bricks = new Map<string, string>();
  /** Door/wall-swap cell overrides keyed by grid coordinate "x,z". */
  private cellOv = new Map<string, SwapCell>();
  /**
   * F54 Long Hall walked-distance high-water marks, keyed by spawn chunk
   * "cx,cz". The door cycle behind the player is a pure function of this
   * mark (longhall.ts currentExits/cycleLog), so keeping it here preserves
   * the cycle timeline across chunk rebuilds. Progress is world state, not
   * anomaly drift - revertAll() deliberately leaves these untouched.
   */
  private hallWalkedMarks = new Map<string, number>();

  /**
   * Walked-distance high-water mark recorded for the hall spawned at
   * (spawnCx, spawnCz); 0 when the player has never entered it.
   */
  hallWalked(spawnCx: number, spawnCz: number): number {
    return this.hallWalkedMarks.get(ChunkDeltas.key(spawnCx, spawnCz)) ?? 0;
  }

  /**
   * Raise the hall's walked-distance mark to walkedM when that is further
   * than the current mark; backtracking never rewinds the door cycle.
   * @returns The stored mark after the call.
   */
  markHallWalked(spawnCx: number, spawnCz: number, walkedM: number): number {
    const key = ChunkDeltas.key(spawnCx, spawnCz);
    const next = Math.max(this.hallWalkedMarks.get(key) ?? 0, walkedM);
    this.hallWalkedMarks.set(key, next);
    return next;
  }

  static key(cx: number, cz: number): string {
    return cx + ',' + cz;
  }

  /** Current drift step for a chunk (0 = canonical). */
  step(cx: number, cz: number): number {
    return this.steps.get(ChunkDeltas.key(cx, cz)) ?? 0;
  }

  /** Advance a chunk's drift by one and report the new step. */
  bump(cx: number, cz: number): number {
    const next = this.step(cx, cz) + 1;
    this.steps.set(ChunkDeltas.key(cx, cz), next);
    return next;
  }

  /**
   * Clear every mutation; subsequent rebuilds regenerate canonically.
   * Returns how many chunks were drifted.
   */
  revertAll(): number {
    const n = this.steps.size;
    this.steps.clear();
    this.blackoutOrdinals.clear();
    this.bricks.clear();
    this.cellOv.clear();
    return n;
  }

  /** Persist one bricked-door EdgeCode.SOLID override for a chunk. */
  brickEdge(cx: number, cz: number, doorId: string): void {
    this.bricks.set(ChunkDeltas.key(cx, cz), doorId);
  }

  /** Whether the SOLID override for this door is currently in force. */
  hasBrickEdge(cx: number, cz: number, doorId: string): boolean {
    return this.bricks.get(ChunkDeltas.key(cx, cz)) === doorId;
  }

  /** The door currently bricked in a chunk, or null when none is. */
  brickedDoorIn(cx: number, cz: number): string | null {
    return this.bricks.get(ChunkDeltas.key(cx, cz)) ?? null;
  }

  /** Drop one door's SOLID override (blackout revert removes its own brick). */
  unbrickEdge(cx: number, cz: number, doorId: string): void {
    const key = ChunkDeltas.key(cx, cz);
    if (this.bricks.get(key) === doorId) this.bricks.delete(key);
  }

  /**
   * Drop every bricked-edge override; the director calls this when the NEXT
   * blackout starts so bricks last exactly until then.
   */
  clearBrickEdges(): number {
    const n = this.bricks.size;
    this.bricks.clear();
    return n;
  }

  /** The swap-cell override at a grid coordinate, or null when canonical. */
  cellOverride(x: number, z: number): SwapCell | null {
    const c = this.cellOv.get(x + ',' + z);
    return c ? { marker: c.marker, nav: c.nav, solid: c.solid } : null;
  }

  /**
   * Apply every cell write as one unit - all entries are in the ledger
   * before this returns and before any later getCell observation, so a
   * swap is never observably half-applied.
   */
  putCellOverrides(writes: readonly CellWrite[]): void {
    for (const w of writes) {
      this.cellOv.set(w.x + ',' + w.z, {
        marker: w.cell.marker, nav: w.cell.nav, solid: w.cell.solid,
      });
    }
  }

  /** Whether a blackout shift with this ordinal already hit the chunk. */
  hasBlackout(cx: number, cz: number, ordinal: number): boolean {
    return this.blackoutOrdinals.get(ChunkDeltas.key(cx, cz))?.has(ordinal) ?? false;
  }

  /** Record that a blackout ordinal was applied to a chunk. */
  markBlackout(cx: number, cz: number, ordinal: number): void {
    const key = ChunkDeltas.key(cx, cz);
    let set = this.blackoutOrdinals.get(key);
    if (!set) { set = new Set<number>(); this.blackoutOrdinals.set(key, set); }
    set.add(ordinal);
  }

  /** Drop a blackout-ordinal mark (used by revert so re-apply replays identically). */
  unmarkBlackout(cx: number, cz: number, ordinal: number): void {
    this.blackoutOrdinals.get(ChunkDeltas.key(cx, cz))?.delete(ordinal);
  }

  /** Set a chunk's drift step directly (blackout revert restores its prior step). */
  restore(cx: number, cz: number, step: number): void {
    if (step <= 0) this.steps.delete(ChunkDeltas.key(cx, cz));
    else this.steps.set(ChunkDeltas.key(cx, cz), step);
  }

  get size(): number {
    return this.steps.size;
  }
}

/** Canonical cell lookup for one chunk region, injected from the architect layout. */
export type CanonicalCellAt = (x: number, z: number) => SwapCell | undefined;

/**
 * SwapGrid view over a ChunkDeltas ledger (F23 seam): reads fall through to
 * the injected canonical cells unless an override is in force, and writes go
 * into the ledger so revertAll() restores canonical. Door/wall swaps run
 * through doorswap.swapDoorWall against this adapter, so nav flags, collision
 * solids and mesher markers all swap atomically inside one bulk write and
 * remain swapped across chunk rebuilds until reverted.
 */
export class DeltasSwapGrid implements SwapGrid {
  constructor(
    private deltas: ChunkDeltas,
    private canonicalAt: CanonicalCellAt,
  ) {}

  getCell(x: number, z: number): SwapCell | undefined {
    const ov = this.deltas.cellOverride(x, z);
    if (ov) return ov;
    const c = this.canonicalAt(x, z);
    return c ? { marker: c.marker, nav: c.nav, solid: c.solid } : undefined;
  }

  putCells(writes: readonly CellWrite[]): void {
    this.deltas.putCellOverrides(writes);
  }
}
/**
 * Re-seed a layout's movable decor deterministically for drift step.
 * Pure function of (props, cx, cz, seed, step): rebuilding a chunk with
 * the same drift always produces the same drifted decor. Returns how many
 * props moved; a step of zero is a no-op, so reverting needs no snapshot.
 */
export function applyDecorDrift(
  props: PropInstance[],
  cx: number,
  cz: number,
  seed: number,
  step: number,
): number {
  if (step <= 0) return 0;
  const rr = new RNG(hash2i(cx, cz, (seed ^ DRIFT_SALT) + Math.imul(step, 0x9e37)));
  let moved = 0;
  for (const p of props) {
    if (!MOVABLE.has(p.kind)) continue;
    p.rot = ((p.rot + rr.int(0, 4)) % 4) as PropInstance['rot'];
    p.variant = (p.variant + rr.int(1, 4)) % 4;
    p.x += (rr.next() - 0.5) * 2 * DRIFT_SLIDE_MAX;
    p.z += (rr.next() - 0.5) * 2 * DRIFT_SLIDE_MAX;
    moved++;
  }
  return moved;
}

/** Per-chunk inputs a blackout shift needs. */
export interface BlackoutShiftInput {
  /** Chunk the blackout hit. */
  cx: number;
  cz: number;
  /** Props in the chunk; movable ones are mutated in place, one slot each. */
  props: PropInstance[];
  /** Doors currently open in the chunk, as stable ids. */
  openDoors: readonly string[];
}

/**
 * Everything needed to undo one applied blackout shift. The record indexes
 * into the same props array passed to applyBlackoutShift - pass that array
 * back to revertBlackoutShift.
 */
export interface BlackoutShiftRecord {
  /** Chunk the blackout hit. */
  cx: number;
  cz: number;
  /** Blackout ordinal this shift belongs to. */
  ordinal: number;
  /** Seed the shift was derived from. */
  seed: number;
  /** The single door the blackout bricked (was open before). */
  brickedDoor: string;
  /** Prior rotation of every shifted prop, by index into the input array. */
  priorRots: { index: number; rot: PropInstance['rot'] }[];
  /** Drift step of the chunk before the blackout bumped it. */
  priorStep: number;
}

/**
 * Blackout rearrangement (F16): a blackout rotates every movable prop in the
 * chunk exactly ONE quarter-turn slot and bricks exactly ONE previously-open
 * door. Pure function of (input, seed, ordinal) via rng.ts hashes, so the
 * same (seed, ordinal) replays identically. Applying twice with the same
 * ordinal is rejected (returns null), guarding against double-drift.
 * @param delta Chunk mutation ledger; the chunk's drift step is bumped so
 *   rebuilds fold the blackout in, the bricked door's SOLID edge override is
 *   persisted, and the ordinal mark guards re-application.
 * @param input Chunk coordinates, props, and currently-open doors.
 * @param seed Master run seed.
 * @param ordinal Index of this blackout event within the run.
 * @returns The revert record, or null when this (chunk, ordinal) already applied.
 * @throws When the chunk has no open doors to brick - blackouts fail loud.
 */
export function applyBlackoutShift(
  delta: ChunkDeltas,
  input: BlackoutShiftInput,
  seed: number,
  ordinal: number,
): BlackoutShiftRecord | null {
  if (delta.hasBlackout(input.cx, input.cz, ordinal)) return null;
  if (input.openDoors.length === 0) {
    throw new Error(
      `blackout at chunk ${input.cx},${input.cz}: no open doors to brick`,
    );
  }
  delta.markBlackout(input.cx, input.cz, ordinal);
  const rr = new RNG(hash3i(input.cx, input.cz, ordinal, seed ^ BLACKOUT_SALT));
  const priorRots: { index: number; rot: PropInstance['rot'] }[] = [];
  for (let i = 0; i < input.props.length; i++) {
    const p = input.props[i];
    if (!MOVABLE.has(p.kind)) continue;
    priorRots.push({ index: i, rot: p.rot });
    p.rot = ((p.rot + 1) % 4) as PropInstance['rot'];
  }
  const brickedDoor = input.openDoors[rr.int(0, input.openDoors.length)];
  // persist the SOLID override so rebuilds keep the door bricked until the
  // next blackout clears it (or revertAll restores canonical)
  delta.brickEdge(input.cx, input.cz, brickedDoor);
  const priorStep = delta.step(input.cx, input.cz);
  delta.bump(input.cx, input.cz);
  return {
    cx: input.cx, cz: input.cz,
    ordinal, seed, brickedDoor, priorRots, priorStep,
  };
}

/**
 * Undo one blackout shift: restores every shifted prop to its prior slot,
 * drops the ordinal mark so the same ordinal can replay identically, and
 * returns the door to open state by restoring the prior drift step.
 * @param delta Ledger the shift was applied to.
 * @param record Record returned by applyBlackoutShift.
 * @param props The same props array the shift mutated (record indexes into it).
 * @returns The door the blackout had bricked - caller removes its brick.
 */
export function revertBlackoutShift(
  delta: ChunkDeltas,
  record: BlackoutShiftRecord,
  props: PropInstance[],
): string {
  for (const prior of record.priorRots) {
    props[prior.index].rot = prior.rot;
  }
  delta.unbrickEdge(record.cx, record.cz, record.brickedDoor);
  delta.unmarkBlackout(record.cx, record.cz, record.ordinal);
  delta.restore(record.cx, record.cz, record.priorStep);
  return record.brickedDoor;
}
