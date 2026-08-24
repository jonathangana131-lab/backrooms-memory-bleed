/**
 * Name discovery (F84).
 *
 * The facility's true name is assembled from glyph fragments collected
 * across the world. Callers inject the fragment list {id, glyph}; this
 * module derives the seeded-correct assembly order for the run seed via
 * src/core/rng.ts. Collecting fragments in exactly that order completes
 * the name; any other order never completes. Once assembled, a
 * signage-swap map is produced: every injected sign {id, currentText} gets
 * replacement text embedding the true name, phrased by a seeded per-sign
 * variant pick. The swap map is atomic - it exists only while the name is
 * assembled - and disassembly (or re-collection after a reset) removes it.
 *
 * Pure simulation logic: no DOM, no Babylon imports; all randomness flows
 * from src/core/rng.ts keyed by the run seed, so the same fragments +
 * seed replay identically. serialize()/load() carry the state through the
 * save system unchanged.
 */
import { hash32, hash2i, seedFromString, RNG } from '../core/rng';

/**
 * Salt so name-discovery draws never correlate with any other feature
 * keyed on the same seed.
 */
const FACILITY_NAME_SALT = 0xfac17;

/** One glyph fragment injected by the collector. */
export interface NameFragment {
  /** Unique stable identifier, e.g. "fragment-03". */
  id: string;
  /** Single glyph contributed to the true name when assembled in order. */
  glyph: string;
}

/** One world sign injected for swapping. */
export interface SignDescriptor {
  /** Unique stable identifier of the sign. */
  id: string;
  /** Current displayed text before the true name is known. */
  currentText: string;
}

/** One produced signage swap. */
export interface SignSwap {
  /** Sign identifier mirrored from the injected descriptor. */
  id: string;
  /** Replacement text embedding the true name. */
  newText: string;
}

/**
 * Seeded phrasing variants for replacement signage. The `%N%` token is
 * replaced with the assembled true name; every variant therefore embeds
 * the name's glyphs in order.
 */
export const NAME_PHRASING_VARIANTS: readonly string[] = [
  '%N% MEMORIAL ANNEX',
  'PROPERTY OF %N%',
  '%N% - LEVELS BELOW',
  'ANNEXED UNDER %N%',
  '%N% CIVIC RECORDS',
];

/** Durable name-discovery state for the save system. */
export interface NameSaveState {
  /** Master run seed the assembly order derives from. */
  seed: number;
  /** Injected fragment list, stored verbatim. */
  fragments: NameFragment[];
  /** Collected fragment ids in collection order since last reset. */
  collectedIds: string[];
}

function assertFragmentList(fragments: readonly NameFragment[]): void {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    throw new Error('facilityname: fragment list must be non-empty');
  }
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (typeof fragment.id !== 'string' || fragment.id.length === 0) {
      throw new Error('facilityname: fragment id must be a non-empty string');
    }
    if (typeof fragment.glyph !== 'string' || fragment.glyph.length === 0) {
      throw new Error(`facilityname: fragment ${fragment.id} glyph must be a non-empty string`);
    }
    if (seen.has(fragment.id)) {
      throw new Error(`facilityname: duplicate fragment id ${fragment.id}`);
    }
    seen.add(fragment.id);
  }
}

/**
 * The seeded-correct assembly order of fragment ids for one run seed.
 * Deterministic permutation of the injected list via src/core/rng.ts:
 * the same list + seed always yields the identical order, and different
 * seeds yield independent orders.
 *
 * @param fragments Injected fragment list (order here carries no meaning).
 * @param seed Master run seed.
 */
export function trueNameOrder(fragments: readonly NameFragment[], seed: number): string[] {
  const shuffled = fragments.map((f) => f.id);
  const rng = new RNG(hash2i(seed | 0, fragments.length, FACILITY_NAME_SALT));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1);
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  return shuffled;
}

/**
 * Drives name discovery across one session: collects glyph fragments in
 * injection order, detects exact assembly of the seeded-correct order,
 * produces the atomic signage-swap map on completion, and resets on
 * disassembly. Wrong orders never complete until disassembled and
 * re-collected correctly.
 */
export class FacilityName {
  private readonly fragments_: NameFragment[];
  private readonly seed_: number;
  private readonly order_: string[];
  private collected_: string[] = [];

  /**
   * @param fragments Injected fragment list; ignored (and may be empty)
   *   when `saved` is provided, since the save carries its own copy.
   * @param seed Master run seed; ignored when `saved` is provided.
   * @param saved Prior serialize() output to restore from.
   */
  constructor(fragments: readonly NameFragment[], seed: number, saved?: NameSaveState) {
    if (saved !== undefined) {
      if (typeof saved.seed !== 'number' || !Number.isFinite(saved.seed)) {
        throw new Error('facilityname: malformed save - seed must be a finite number');
      }
      assertFragmentList(saved.fragments ?? []);
      if (!Array.isArray(saved.collectedIds)) {
        throw new Error('facilityname: malformed save - collectedIds must be an array');
      }
      const ids = new Set(saved.fragments.map((f) => f.id));
      for (const collectedId of saved.collectedIds) {
        if (typeof collectedId !== 'string' || !ids.has(collectedId)) {
          throw new Error(`facilityname: malformed save - unknown collected id ${String(collectedId)}`);
        }
      }
      this.fragments_ = saved.fragments.map((f) => ({ ...f }));
      this.seed_ = saved.seed;
      this.collected_ = [...saved.collectedIds];
    } else {
      assertFragmentList(fragments);
      this.fragments_ = fragments.map((f) => ({ ...f }));
      this.seed_ = seed >>> 0;
    }
    this.order_ = trueNameOrder(this.fragments_, this.seed_);
  }

  /**
   * Feed one collected fragment id. Appends to the collection sequence;
   * fails loud on an id not present in the injected fragment list.
   * Completion requires the whole sequence to equal the seeded-correct
   * order, so a wrong pick permanently blocks completion until
   * disassemble().
   */
  collect(fragmentId: string): void {
    if (this.fragments_.every((f) => f.id !== fragmentId)) {
      throw new Error(`facilityname: unknown fragment id ${fragmentId}`);
    }
    this.collected_.push(fragmentId);
  }

  /** Reset the collection sequence; the swap map dissolves atomically. */
  disassemble(): void {
    this.collected_ = [];
  }

  /** True only when the collected sequence equals the seeded-correct order. */
  get assembled(): boolean {
    return (
      this.collected_.length === this.order_.length &&
      this.collected_.every((id, i) => id === this.order_[i])
    );
  }

  /**
   * The true name - glyphs concatenated in the seeded-correct order -
   * or null while the name is not assembled.
   */
  get trueName(): string | null {
    if (!this.assembled) return null;
    const glyphById = new Map(this.fragments_.map((f) => [f.id, f.glyph]));
    return this.order_.map((id) => glyphById.get(id)).join('');
  }

  /**
   * The signage-swap map for the injected signs: every sign receives
   * replacement text embedding the true name, with the phrasing variant
   * picked per sign by a seeded hash. Atomic - returns null unless the
   * name is currently assembled, and re-collection after disassembly
   * reproduces the identical map. Fails loud on duplicate sign ids.
   *
   * @param signs Injected world signs to swap.
   */
  signSwaps(signs: readonly SignDescriptor[]): Map<string, string> | null {
    const name = this.trueName;
    if (name === null) return null;
    const swaps = new Map<string, string>();
    for (const sign of signs) {
      if (swaps.has(sign.id)) {
        throw new Error(`facilityname: duplicate sign id ${sign.id}`);
      }
      const variant =
        NAME_PHRASING_VARIANTS[hash2i(hash32(seedFromString(sign.id)), this.seed_, FACILITY_NAME_SALT + 7) % NAME_PHRASING_VARIANTS.length];
      swaps.set(sign.id, variant.replace('%N%', name));
    }
    return swaps;
  }

  /** Snapshot of the durable state for the save system. */
  serialize(): NameSaveState {
    return {
      seed: this.seed_,
      fragments: this.fragments_.map((f) => ({ ...f })),
      collectedIds: [...this.collected_],
    };
  }
}
