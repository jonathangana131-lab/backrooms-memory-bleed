/**
 * Ceiling-stain -> gfx-drip wiring adapter.
 *
 * Thin bridge between chunk layout production (architect layouts carrying
 * ceiling `stains`) and the stain->drip coordinator in src/world/staindrips.ts,
 * which forwards positions to the gfx drip system (src/gfx/drips.ts). This
 * class owns no merging or growth logic of its own - everything delegates to
 * the StainDripSync instance exposed as `sync`:
 *
 *  - onLayoutBuilt(layout) feeds one built chunk layout's stains into the
 *    sync; missing/null layouts and missing/null stain lists are no-ops so
 *    callers can wire it unconditionally onto layout-built events;
 *
 *  - onStageAdvance(chunkKey) relays stain-growth stage advances so bloomed
 *    chunks shed drops faster (see StainDripSync.onStageAdvance).
 *
 * Deterministic and engine-free: safe to unit-test standalone.
 */

import { StainDripSync, type DripRegistrar, type StainPosition } from './staindrips';

/** One stain entry as carried on a built layout (`r` is ignored here). */
export type LayoutStain = StainPosition & { r?: number };

/** The slice of a built chunk layout this wiring consumes. */
export interface LayoutWithStains {
  /** Chunk coords of the layout; informational only (grouping uses world pos). */
  cx?: number;
  cz?: number;
  /** Ceiling stains produced by the layout builder, if any. */
  stains?: LayoutStain[] | null;
  /**
   * Floor puddles on the same layout. CeilingDrips' own contract is
   * "no puddle, no audible splash": chunks without at least one puddle
   * never register drip points, however stained their ceilings are.
   */
  puddles?: unknown[] | null;
}

/**
 * Reconcile the two chunk-key spellings in this repo: game.ts stage
 * bookkeeping (and stains-growth's storage) writes '<cx>:<cz>' while
 * StainDripSync groups points as '<cx>,<cz>'. Without normalization every
 * stage advance would miss its chunk and growth-driven drip doubling would
 * silently never fire. Non-string junk passes through unchanged.
 */
export function normalizeChunkKey(chunkKey: string): string {
  return typeof chunkKey === 'string' ? chunkKey.replace(/:/g, ',') : chunkKey;
}

/**
 * Bridges layout-built and growth-stage events into the gfx drip system.
 * Construction registers nothing; drips appear only through the event hooks.
 */
export class DripWiring {
  /** The underlying stain->drip coordinator (exposed for tests/debug). */
  readonly sync: StainDripSync;

  /**
   * @param dripsApi Registrar receiving registerStain(x, z) per drip point
   *   (the gfx CeilingDrips facade).
   */
  constructor(dripsApi: DripRegistrar) {
    this.sync = new StainDripSync(dripsApi);
  }

  /**
   * Feed one built chunk layout's ceiling stains into the drip system.
   * Null/undefined layouts and missing/null/malformed stain lists are
   * accepted no-ops, as are layouts with no floor puddles (CeilingDrips'
   * own "no puddle, no audible splash" contract — a stained ceiling over
   * dry floor sheds nothing); duplicate/near-overlapping stains merge away
   * inside the sync, so rebuilding a chunk never stacks emitters.
   */
  onLayoutBuilt(layout: LayoutWithStains | null | undefined): void {
    if (!layout || !Array.isArray(layout.stains)) return;
    if (!Array.isArray(layout.puddles) || layout.puddles.length === 0) return;
    this.sync.syncFromLayout(layout.stains);
  }

  /**
   * Relay a stain-growth stage advance for `chunkKey`: every live drip point
   * in that chunk registers once more (frequency doubling, capped by the
   * sync's MAX_DOUBLINGS budget guard). Unknown chunk keys are inert. The
   * key is normalized first, so callers may use either repo spelling.
   */
  onStageAdvance(chunkKey: string): void {
    this.sync.onStageAdvance(normalizeChunkKey(chunkKey));
  }
}
