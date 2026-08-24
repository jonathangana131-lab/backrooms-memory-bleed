/**
 * Anomaly photo catalog (F85).
 *
 * Completing gallery tiers unlocks journal pages. Callers inject reveal
 * records of the photoreveal.ts shape {revealed, silhouetteSeed}; the
 * catalog counts revealed records and resolves the tier from fixed
 * thresholds [0, 3, 8, 15] named [empty, contact, sheet, archive].
 * Crossing a tier unlocks the journal page ids an injected page table
 * assigns to that tier; the unlocked set is cumulative over every tier
 * reached so far and monotone - tiers never re-lock, even for
 * adversarial out-of-order or save-restored counts. Progress persists
 * via a JSON round-trip that fails loud on malformed saves.
 *
 * Pure simulation logic: no DOM, no Babylon imports, no randomness -
 * tier resolution is a pure function of the revealed count, so any
 * replay is byte-identical.
 */

/** Gallery tier names in ascending order; index parallels TIER_THRESHOLDS. */
export type TierName = 'empty' | 'contact' | 'sheet' | 'archive';

/** Inclusive revealed-count thresholds for each tier, ascending from 0. */
export const TIER_THRESHOLDS: readonly number[] = [0, 3, 8, 15];

/** Tier display names; index i belongs to TIER_THRESHOLDS[i]. */
export const TIER_NAMES: readonly TierName[] = ['empty', 'contact', 'sheet', 'archive'];

/**
 * Injected journal page table: page ids unlocked by FIRST reaching each
 * tier. The live unlocked set is the cumulative union across all tiers
 * reached so far, in ascending tier order.
 */
export type PageTable = Partial<Record<TierName, readonly string[]>>;

/** One injected photo record, matching src/gfx/photoreveal.ts output. */
export interface CatalogRevealRecord {
  /** True iff developing this capture revealed an entity. */
  revealed: boolean;
  /** Deterministic silhouette seed; present on every developed record. */
  silhouetteSeed: number;
}

/** Durable catalog progress for the save system. */
export interface CatalogSaveState {
  /** Save format version; fail loud on anything else. */
  version: 1;
  /** Lifetime count of records that revealed an entity. */
  revealedCount: number;
  /** High-water mark of the tier index ever reached (never re-locks). */
  maxTierIndex: number;
}

/** Validate one injected reveal record; fails loud on malformed input. */
function assertRecord(record: CatalogRevealRecord): void {
  if (typeof record.revealed !== 'boolean') {
    throw new Error('photocatalog: record.revealed must be a boolean');
  }
  if (!Number.isFinite(record.silhouetteSeed)) {
    throw new Error('photocatalog: record.silhouetteSeed must be a finite number');
  }
}

/**
 * Resolve the tier index earned by a lifetime revealed count.
 * Exact: counts below TIER_THRESHOLDS[1] map to 0, and each later tier
 * promotes exactly at its own threshold. Monotone non-decreasing in the
 * count; counts beyond the last threshold saturate at the highest tier.
 *
 * @param revealedCount Lifetime count of revealing photos (>= 0).
 */
export function tierIndexForCount(revealedCount: number): number {
  const count = Math.max(0, Math.floor(revealedCount) || 0);
  let tier = 0;
  for (let i = 1; i < TIER_THRESHOLDS.length; i++) {
    if (count >= TIER_THRESHOLDS[i]) tier = i;
  }
  return tier;
}

/**
 * Drives the photo catalog across one session: ingests photoreveal-shape
 * records, tracks the lifetime reveal count, raises the monotone tier
 * high-water mark, and exposes the cumulative unlocked journal page set.
 * serialize()/parse() round-trip the progress through the save system.
 */
export class PhotoCatalog {
  private readonly pageTable_: Required<PageTable>;
  private revealedCount_ = 0;
  private maxTierIndex_ = 0;

  /**
   * @param pageTable Journal page ids unlocked per tier; missing tiers
   *   simply unlock nothing.
   * @param saved Prior parse() output to restore from; malformed input
   *   throws.
   */
  constructor(pageTable: PageTable, saved?: string) {
    this.pageTable_ = {
      empty: pageTable.empty ?? [],
      contact: pageTable.contact ?? [],
      sheet: pageTable.sheet ?? [],
      archive: pageTable.archive ?? [],
    };
    if (saved !== undefined) this.load(saved);
  }

  /**
   * Feed one developed photo record. Revealing records advance the
   * lifetime count (and possibly the tier); non-revealing records are
   * accepted and change nothing.
   */
  record(record: CatalogRevealRecord): void {
    assertRecord(record);
    if (!record.revealed) return;
    this.revealedCount_ += 1;
    const tier = tierIndexForCount(this.revealedCount_);
    if (tier > this.maxTierIndex_) this.maxTierIndex_ = tier;
  }

  /** Lifetime count of records that revealed an entity. */
  get revealedCount(): number {
    return this.revealedCount_;
  }

  /** Index into TIER_NAMES/TIER_THRESHOLDS currently earned. */
  get tierIndex(): number {
    return this.maxTierIndex_;
  }

  /** Name of the tier currently earned. */
  get tier(): TierName {
    return TIER_NAMES[this.maxTierIndex_];
  }

  /**
   * Cumulative journal page ids unlocked across every tier reached so
   * far, in ascending tier order, deduplicated preserving first
   * occurrence. Monotone: once emitted, a page id never disappears.
   */
  get unlockedPages(): string[] {
    const pages: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i <= this.maxTierIndex_; i++) {
      const tierPages = this.pageTable_[TIER_NAMES[i]] ?? [];
      for (const page of tierPages) {
        if (!seen.has(page)) {
          seen.add(page);
          pages.push(page);
        }
      }
    }
    return pages;
  }

  /** JSON snapshot of the durable progress for the save system. */
  serialize(): string {
    const state: CatalogSaveState = {
      version: 1,
      revealedCount: this.revealedCount_,
      maxTierIndex: this.maxTierIndex_,
    };
    return JSON.stringify(state);
  }

  /**
   * Restore progress from a serialize() JSON string. Fails loud on
   * malformed saves: bad JSON, wrong version, non-integer/negative
   * counts, or tier indices outside the threshold table.
   *
   * @param json Prior serialize() output.
   */
  load(json: string): void {
    let state: unknown;
    try {
      state = JSON.parse(json);
    } catch (error) {
      throw new Error(`photocatalog: malformed save - invalid JSON (${String(error)})`);
    }
    const s = state as Partial<CatalogSaveState> | null;
    if (
      s === null || typeof s !== 'object' || s.version !== 1 ||
      typeof s.revealedCount !== 'number' || !Number.isInteger(s.revealedCount) ||
      s.revealedCount < 0 ||
      typeof s.maxTierIndex !== 'number' || !Number.isInteger(s.maxTierIndex) ||
      s.maxTierIndex < 0 || s.maxTierIndex >= TIER_NAMES.length
    ) {
      throw new Error('photocatalog: malformed save - rejected CatalogSaveState');
    }
    this.revealedCount_ = s.revealedCount;
    // Monotonicity survives adversarial saves: never lower the mark.
    const impliedTier = tierIndexForCount(s.revealedCount);
    this.maxTierIndex_ = Math.max(this.maxTierIndex_, s.maxTierIndex, impliedTier);
  }
}
