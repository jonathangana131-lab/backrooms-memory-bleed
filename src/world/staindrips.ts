/**
 * Ceiling stain -> drip system synchronization.
 *
 * Pure coordination layer between the world generator's ceiling stains
 * (layout.stains: { x, z, r } instances from architect.generateStains) and
 * the gfx drip system (CeilingDrips.registerStain in src/gfx/drips.ts).
 * It owns no rendering, no audio and no state of its own beyond bookkeeping:
 *
 *  - Coordinate mapping: every stain position handed to syncFromLayout() is
 *    forwarded to dripsApi.registerStain(x, z), so wet ceilings leak where
 *    they are stained;
 *
 *  - Merge rule: stains within MERGE_DIST (1 m) of each other share ONE
 *    drip point - the first stain seen claims the spot and later near
 *    duplicates are absorbed instead of stacking extra emitters. This holds
 *    across sync calls too, so re-entering a chunk never multiplies drips;
 *
 *  - Growth sync hook: onStageAdvance(chunkKey) fires when a chunk's stains
 *    bloom a growth stage (see stains-growth.noteChunkEntry). A bloomed
 *    stain leaks harder, so every drip point in that chunk is registered
 *    again - two registered points at one spot shed drops twice as often.
 *    Doublings are capped at MAX_DOUBLINGS to respect CeilingDrips' global
 *    96-point budget (2..6 stains/chunk x 4 levels stays far below it).
 *
 * No engine dependencies: safe to unit-test standalone like stains-growth.
 */

import { CHUNK_SIZE } from './constants';

/** The slice of the gfx drip API this coordinator needs. */
export interface DripRegistrar {
  /** Register one ceiling drip source at world position (x, z). */
  registerStain(x: number, z: number): void;
}

/** Minimal stain shape consumed here (subset of CeilingStainInstance). */
export interface StainPosition {
  x: number;
  z: number;
}

/** Stains closer than this share a single drip point. */
export const MERGE_DIST = 1;

/** How many times growth may double a point's frequency (stage cap). */
export const MAX_DOUBLINGS = 3;

/** One coordinated drip point: merged position + how often registered. */
interface DripPoint {
  x: number;
  z: number;
  /** Chunk it belongs to ('<cx>,<cz>'); near-border points keep their own. */
  chunkKey: string;
  /** Registrations so far: 1 at sync, +1 per stage advance (capped). */
  level: number;
}

function chunkKeyOf(x: number, z: number): string {
  return Math.floor(x / CHUNK_SIZE) + ',' + Math.floor(z / CHUNK_SIZE);
}

export class StainDripSync {
  private readonly drips: DripRegistrar;
  /** Every live drip point, in registration order (small arrays: <= dozens). */
  private readonly points: DripPoint[] = [];

  constructor(dripsApi: DripRegistrar) {
    this.drips = dripsApi;
  }

  /** Registered drip points (after merging). */
  get pointCount(): number {
    return this.points.length;
  }

  /** Registration level of every point in one chunk (for tests/debug). */
  levelsIn(chunkKey: string): number[] {
    return this.points.filter((p) => p.chunkKey === chunkKey).map((p) => p.level);
  }

  /**
   * Feed one chunk layout's ceiling stains into the drip system. Idempotent
   * per position: stains already covered by an existing drip point (within
   * MERGE_DIST, from this or an earlier sync) share that point instead of
   * registering a duplicate emitter.
   */
  syncFromLayout(stains: StainPosition[]): void {
    if (!Array.isArray(stains)) return;
    for (const s of stains) {
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z)) continue;
      if (this.findWithin(s.x, s.z) !== undefined) continue; // merged away
      const point: DripPoint = {
        x: s.x,
        z: s.z,
        chunkKey: chunkKeyOf(s.x, s.z),
        level: 1,
      };
      this.points.push(point);
      this.drips.registerStain(point.x, point.z);
    }
  }

  /**
   * Growth hook: the stains in chunkKey advanced a stage, so their drips
   * speed up. Each point in the chunk registers one more time with the gfx
   * system (two timers at one spot = twice the drops). Capped so repeated
   * advances cannot blow past the drip system's point budget.
   */
  onStageAdvance(chunkKey: string): void {
    for (const p of this.points) {
      if (p.chunkKey !== chunkKey) continue;
      if (p.level >= 1 + MAX_DOUBLINGS) continue; // fully bloomed already
      p.level++;
      this.drips.registerStain(p.x, p.z);
    }
  }

  /** Nearest registered point within MERGE_DIST of (x, z), if any. */
  private findWithin(x: number, z: number): DripPoint | undefined {
    const r2 = MERGE_DIST * MERGE_DIST;
    return this.points.find((p) => {
      const dx = p.x - x;
      const dz = p.z - z;
      return dx * dx + dz * dz <= r2;
    });
  }
}


