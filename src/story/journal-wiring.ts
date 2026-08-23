/**
 * Chunk-build to journal bridge for BACKROOMS: MEMORY BLEED.
 *
 * Gameplay-side adapter between the Architect's chunk pipeline and the
 * JournalFeed (src/story/journal-feed.ts). The world generator calls
 * onLayoutBuilt() once per built chunk; the wiring hands layouts that carry
 * notes to the feed and tracks how many entries were actually filed.
 *
 * Pure logic - no DOM, no Babylon dependencies.
 */

import {
  JournalFeed,
  type FeedLayout,
  type FeedNote,
} from './journal-feed';

/** Minimal layout surface consumed from the chunk builder. */
export interface WiredLayout {
  /** Notes found in the layout; may be missing or empty. */
  notes?: FeedNote[];
}

/**
 * Bridges chunk builds into the journal feed. Accumulates the count of
 * notes newly accepted by the journal across every fed layout.
 */
export class JournalWiring {
  private readonly feed: JournalFeed;
  private totalFed = 0;

  constructor(feed: JournalFeed) {
    this.feed = feed;
  }

  /**
   * Called by the chunk builder when a chunk layout is ready. Feeds the
   * layout's notes into the journal and accumulates how many were newly
   * accepted. Layouts without notes are skipped untouched.
   */
  onLayoutBuilt(layout: WiredLayout | null | undefined, cx: number, cz: number, district: number): void {
    if (!layout || !Array.isArray(layout.notes) || layout.notes.length === 0) return;
    const feedLayout: FeedLayout = { cx, cz, notes: layout.notes };
    this.totalFed += this.feed.feedFromLayout(feedLayout, district);
  }

  /** Total number of notes this wiring has gotten accepted into the journal. */
  getTotalFed(): number {
    return this.totalFed;
  }
}


