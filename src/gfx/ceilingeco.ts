/**
 * Ceiling tile ecosystem (F43): missing tiles accumulate, and something
 * nests beneath them.
 *
 * Every removed ceiling tile stays removed. A per-chunk ledger accumulates
 * removal counts monotonically across sessions through a plain JSON
 * round-trip, matching the AgingLedger persistence idiom - so a corridor's
 * ceiling can only ever get worse. Skitter cues from the nesting colony are
 * a pure function of the chunk's tile state: as the missing fraction crosses
 * fixed bands, cue intensity steps up in exact discrete jumps (never a
 * gradient), so audio design can key one shot per band.
 *
 * Pure module - no DOM, no Babylon imports.
 */

/** Injected per-chunk tile state, read straight off the tile mesher's counts. */
export interface ChunkTileState {
  /** Cumulative tiles missing from this chunk's ceiling (>= 0). */
  missingCount: number;
  /** Total ceiling tiles the chunk was built with (> 0). */
  maxTiles: number;
}

/** One skitter intensity band keyed by the missing-tile fraction. */
export interface SkitterBand {
  /** Inclusive minimum missing fraction (missingCount / maxTiles) for this band. */
  minFraction: number;
  /** Cue intensity the audio layer plays while the fraction sits in this band. */
  intensity: number;
}

/**
 * Skitter bands, ascending by threshold. Order matters: skitterBandIndex
 * picks the LAST band whose threshold the missing fraction meets. Intensity
 * is exactly the band value inside each band - no interpolation.
 */
export const SKITTER_BANDS: readonly SkitterBand[] = [
  { minFraction: 0, intensity: 0 },
  { minFraction: 0.1, intensity: 0.25 },
  { minFraction: 0.25, intensity: 0.55 },
  { minFraction: 0.5, intensity: 0.9 },
];

/**
 * Resolve the skitter band index for a chunk's tile state.
 * Pure and exact: the fraction missingCount/maxTiles (clamped to [0,1])
 * promotes to band i exactly when it reaches SKITTER_BANDS[i].minFraction,
 * and saturates at the last band beyond it.
 * @param state Per-chunk tile state injected by the caller.
 * @returns Index into SKITTER_BANDS.
 * @throws When maxTiles is not a positive finite number - callers feeding a
 *   degenerate mesher count fail loud rather than reading an infinite band.
 */
export function skitterBandIndex(state: ChunkTileState): number {
  if (!(state.maxTiles > 0) || !Number.isFinite(state.maxTiles)) {
    throw new Error('ceilingeco: maxTiles must be a positive finite number');
  }
  const missing = Math.max(0, Math.floor(state.missingCount) || 0);
  const fraction = Math.min(1, missing / state.maxTiles);
  let band = 0;
  for (let i = 1; i < SKITTER_BANDS.length; i++) {
    if (fraction >= SKITTER_BANDS[i].minFraction) band = i;
  }
  return band;
}

/**
 * Resolve the skitter cue intensity for a chunk's tile state.
 * Pure function of its input: same state always returns the identical
 * number. Monotone non-decreasing in missingCount; values are exactly the
 * band intensities of SKITTER_BANDS.
 * @param state Per-chunk tile state injected by the caller.
 */
export function skitterIntensity(state: ChunkTileState): number {
  return SKITTER_BANDS[skitterBandIndex(state)].intensity;
}

/** Serialization envelope version; bump only on structural format changes. */
const LEDGER_FORMAT_VERSION = 1;

/**
 * Per-chunk cumulative removal ledger with JSON persistence.
 * Keys follow the ChunkDeltas.key idiom ("cx,cz"). Counts only ever grow:
 * recordRemoval never decreases a chunk's total, whatever it is fed, so
 * re-recording or negative inputs cannot un-remove a tile.
 */
export class CeilingTileLedger {
  private removals = new Map<string, number>();

  /** Cumulative removed-tile count recorded for a chunk (0 when none). */
  removalCount(chunkKey: string): number {
    return this.removals.get(chunkKey) ?? 0;
  }

  /**
   * Record tile removals for a chunk and return its new cumulative total.
   * Non-positive counts are no-ops that return the unchanged total, keeping
   * every total monotone non-decreasing across any call sequence.
   * @param chunkKey Stable chunk identity ("cx,cz").
   * @param count Tiles removed in this event (defaults to 1).
   */
  recordRemoval(chunkKey: string, count = 1): number {
    const next = this.removalCount(chunkKey) + Math.max(0, Math.floor(count) || 0);
    this.removals.set(chunkKey, next);
    return next;
  }

  /** Convenience: current skitter intensity for a chunk's ledgered removals. */
  skitterOf(chunkKey: string, maxTiles: number): number {
    return skitterIntensity({ missingCount: this.removalCount(chunkKey), maxTiles });
  }

  /** Number of chunks with at least one recorded removal. */
  get size(): number {
    return this.removals.size;
  }

  /**
   * Serialize to a plain JSON string. Round-trips exactly through
   * CeilingTileLedger.fromJSON: identical keys, totals, and derived bands.
   */
  toJSON(): string {
    const entries = [...this.removals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return JSON.stringify({ formatVersion: LEDGER_FORMAT_VERSION, removals: entries });
  }

  /**
   * Rebuild a ledger from toJSON output.
   * @throws When the payload lacks the expected envelope or entry shape -
   *   saves fail loud rather than silently resetting removal history.
   */
  static fromJSON(json: string): CeilingTileLedger {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== 'object' || parsed === null ||
      (parsed as { formatVersion?: unknown }).formatVersion !== LEDGER_FORMAT_VERSION ||
      !Array.isArray((parsed as { removals?: unknown }).removals)
    ) {
      throw new Error('ceilingeco: malformed ledger JSON');
    }
    const ledger = new CeilingTileLedger();
    for (const entry of (parsed as { removals: unknown[] }).removals) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'number') {
        throw new Error('ceilingeco: malformed ledger entry');
      }
      ledger.removals.set(entry[0], Math.max(0, Math.floor(entry[1])));
    }
    return ledger;
  }
}
