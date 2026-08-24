/**
 * Context tags and deterministic eligibility for authored content pools.
 *
 * Every entry in the wave/cluster/graffiti pools carries optional tags:
 *   - districts: District enum values (see world/constants.ts)
 *   - memKinds : memory-kind string tags (mapped to MemoryKind below)
 *   - minStage : minimum StorySystem.stage before the entry may surface
 *
 * Selection stays under the determinism law: callers hash-select an index
 * (hash2i/rand2 from core/rng) and this module only filters - it never
 * introduces randomness of its own.
 */
import { MemoryKind } from '../memory/field';

/** Numeric MemoryKind -> the string tag authored pools use. */
const KIND_TO_TAG: Record<number, string> = {
  [MemoryKind.RESIDENCE]: 'residence',
  [MemoryKind.OFFICE]: 'office',
  [MemoryKind.HOSPITAL]: 'hospital',
  [MemoryKind.SCHOOL]: 'school',
  [MemoryKind.MALL]: 'mall',
  [MemoryKind.TRANSIT]: 'transit',
  [MemoryKind.PERSONAL]: 'personal',
};

/** Valid memKinds strings, for tooling and tests. */
export const VALID_MEM_KIND_TAGS: readonly string[] = Object.values(KIND_TO_TAG);

/** Contextual tags narrowing where an authored entry may surface. */
export interface ContentTags {
  /** District enum values this entry can appear in; omit for anywhere. */
  districts?: number[];
  /** Memory-kind string tags; omit for any contamination kind. */
  memKinds?: string[];
  /** Minimum StorySystem.stage (0 intro .. 3 threshold open). */
  minStage?: number;
}

/** One authored text plus its contextual tags. */
export interface TaggedEntry extends ContentTags {
  text: string;
}

/** Plain-data snapshot of where a piece of content would land. */
export interface SelectionContext {
  /** District enum value for the chunk. */
  district: number;
  /** Memory-kind enum value sampled for the chunk (NONE allowed). */
  memKind: number;
  /** Current StorySystem.stage. */
  stage: number;
}

/**
 * True when the entry may surface in ctx. Untagged entries are always
 * eligible; chunks with no contamination kind reject memKind-tagged
 * entries; stage defaults to 0 so unadvanced runs only see early notes.
 */
export function isEligible(entry: ContentTags | undefined, ctx: SelectionContext): boolean {
  if (!entry) return true;
  if (entry.districts && entry.districts.length && !entry.districts.includes(ctx.district)) return false;
  if (entry.memKinds && entry.memKinds.length) {
    const kindTag = KIND_TO_TAG[ctx.memKind];
    if (!kindTag || !entry.memKinds.includes(kindTag)) return false;
  }
  if ((entry.minStage ?? 0) > ctx.stage) return false;
  return true;
}

/**
 * Deterministically pick one eligible entry from the pool given an unsigned
 * hash (e.g. a hash2i result). Filtering first, then a stable walk to the
 * hashed offset, keeps output independent of pool-order changes among
 * ineligible entries. Returns null when nothing is eligible.
 */
export function pickEligible<T extends TaggedEntry>(pool: readonly T[], ctx: SelectionContext, hash: number): T | null {
  let eligibleCount = 0;
  for (const entry of pool) {
    if (isEligible(entry, ctx)) eligibleCount++;
  }
  if (eligibleCount === 0) return null;
  let remaining = (hash >>> 0) % eligibleCount;
  for (const entry of pool) {
    if (!isEligible(entry, ctx)) continue;
    if (remaining === 0) return entry;
    remaining--;
  }
  return null;
}
