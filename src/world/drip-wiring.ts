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
   * accepted no-ops; duplicate/near-overlapping stains merge away inside the
   * sync, so rebuilding a chunk never stacks emitters.
   */
  onLayoutBuilt(layout: LayoutWithStains | null | undefined): void {
    if (!layout || !Array.isArray(layout.stains)) return;
    this.sync.syncFromLayout(layout.stains);
  }

  /**
   * Relay a stain-growth stage advance for `chunkKey`: every live drip point
   * in that chunk registers once more (frequency doubling, capped by the
   * sync's MAX_DOUBLINGS budget guard). Unknown chunk keys are inert.
   */
  onStageAdvance(chunkKey: string): void {
    this.sync.onStageAdvance(chunkKey);
  }
}
