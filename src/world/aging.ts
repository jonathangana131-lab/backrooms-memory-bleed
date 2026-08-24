/**
 * Aging corridors (F24): revisits accumulate decay.
 *
 * Every chunk keeps a visit count; the stage a chunk shows is a pure
 * function of (chunkKey, visitsSinceFirstSeen, seed), so two sessions that
 * saw the same chunk the same number of times see identical decay. Stage
 * thresholds are drawn once per (key, seed) as a strictly ascending
 * sequence, which makes the stage monotone non-decreasing in visits and
 * bounded by AGING_MAX_STAGE by construction. The per-stage decor deltas
 * are plain numbers a mesher consumes directly (crack density multipliers,
 * stain spread factors). The ledger persists through a plain JSON
 * round-trip, matching the ChunkDeltas persistence idiom.
 */
import { RNG, hash2i, seedFromString } from '../core/rng';

/** Salt so aging draws never correlate with any other per-chunk feature. */
const AGING_SALT = 0xa9e5;

/** Highest decay stage any chunk can reach. */
export const AGING_MAX_STAGE = 5;

/**
 * Decor deltas for one decay stage - pure numbers a mesher folds into its
 * build. All fields are deterministic per (chunkKey, visits, seed).
 */
export interface AgingStageParams {
  /** Decay stage 0..AGING_MAX_STAGE (0 = pristine). */
  stage: number;
  /** Crack density multiplier applied to the mesher's crack pass (>= 1). */
  crackDensityMul: number;
  /** Stain spread factor in [0,1]: fraction of full stain growth. */
  stainSpreadFactor: number;
}

/** Strictly ascending visit thresholds for stages 1..AGING_MAX_STAGE. */
function thresholds(chunkKey: string, seed: number): number[] {
  const rr = new RNG(hash2i(seedFromString(chunkKey), seed, AGING_SALT));
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i < AGING_MAX_STAGE; i++) {
    t += 1 + rr.int(1, 4); // gap 1..3 keeps early stages reachable, later ones earned
    out.push(t);
  }
  return out;
}

/**
 * Resolve the decay stage and decor deltas for a chunk.
 * Pure function of its inputs: same (chunkKey, visits, seed) always returns
 * deep-equal params, across instances and processes. Monotone: larger
 * `visits` never lowers the stage. Bounded: stage never exceeds
 * AGING_MAX_STAGE, even for adversarially large visit counts.
 * @param chunkKey Stable chunk identity (ChunkDeltas.key idiom, "cx,cz").
 * @param visitsSinceFirstSeen Visit count since the chunk was first seen (>= 0).
 * @param seed Master run seed.
 */
export function decayStage(
  chunkKey: string,
  visitsSinceFirstSeen: number,
  seed: number,
): AgingStageParams {
  const visits = Math.max(0, Math.floor(visitsSinceFirstSeen) || 0);
  const th = thresholds(chunkKey, seed);
  let stage = 0;
  while (stage < th.length && visits >= th[stage]) stage++;
  const rr = new RNG(hash2i(seedFromString(chunkKey) ^ stage, seed, AGING_SALT + 7));
  // Per-key jitter keeps corridors from aging on identical curves while the
  // stage term stays dominant, so multipliers remain monotone per corridor.
  const crackBase = 1 + stage * 0.35;
  const crackDensityMul = Math.round((crackBase + rr.next() * 0.2) * 1000) / 1000;
  const stainSpreadFactor = Math.round(Math.min(1, stage / AGING_MAX_STAGE) * 1000) / 1000;
  return { stage, crackDensityMul, stainSpreadFactor };
}

/**
 * Per-chunk visit ledger with JSON persistence. Keys follow the
 * ChunkDeltas.key idiom ("cx,cz"); values are cumulative visits since the
 * chunk was first seen. Serialization is a plain versioned object so save
 * files stay diffable and hand-inspectable like the rest of the delta set.
 */
export class AgingLedger {
  private visits = new Map<string, number>();

  /** Visits recorded for a chunk (0 when never seen). */
  visitCount(chunkKey: string): number {
    return this.visits.get(chunkKey) ?? 0;
  }

  /**
   * Record one more visit of a chunk and return its total visits since
   * first seen. First recording establishes first sight at count 1.
   */
  recordVisit(chunkKey: string): number {
    const next = this.visitCount(chunkKey) + 1;
    this.visits.set(chunkKey, next);
    return next;
  }

  /** Convenience: decayStage for this ledger's current visit count. */
  stageOf(chunkKey: string, seed: number): AgingStageParams {
    return decayStage(chunkKey, this.visitCount(chunkKey), seed);
  }

  /** Number of chunks with at least one recorded visit. */
  get size(): number {
    return this.visits.size;
  }

  /**
   * Serialize to a plain JSON string. Round-trips exactly through
   * AgingLedger.fromJSON: identical keys, counts, and derived stages.
   */
  toJSON(): string {
    const entries = [...this.visits.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return JSON.stringify({ formatVersion: 1, visits: entries });
  }

  /**
   * Rebuild a ledger from toJSON output.
   * @throws When the payload lacks the expected envelope or shape - saves
   *   fail loud rather than silently resetting decay history.
   */
  static fromJSON(json: string): AgingLedger {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== 'object' || parsed === null ||
      (parsed as { formatVersion?: unknown }).formatVersion !== 1 ||
      !Array.isArray((parsed as { visits?: unknown }).visits)
    ) {
      throw new Error('aging: malformed ledger JSON');
    }
    const ledger = new AgingLedger();
    for (const entry of (parsed as { visits: unknown[] }).visits) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'number') {
        throw new Error('aging: malformed ledger entry');
      }
      ledger.visits.set(entry[0], Math.max(0, Math.floor(entry[1])));
    }
    return ledger;
  }
}
