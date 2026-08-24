/**
 * F66 Doppelgänger letters — your Double leaves notes criticizing your
 * choices.
 *
 * A choice ledger ({choiceId, kind, detailSeed}) is injected per session.
 * When the player discovers a landmark, this module drafts ONE letter from
 * the Double: it picks a decision kind the ledger actually contains,
 * cites the player's most recent choices of that kind by id, and phrases
 * its criticism with seeded language whose tone escalates as the player
 * repeats the same kind of choice.
 *
 * Guarantees (the AC):
 *   - every letter references at least one real ledger choice id, quoted
 *     verbatim in the note text;
 *   - tone rises monotonically with same-kind repeat counts;
 *   - an empty ledger produces no letters at all;
 *   - everything is deterministic per (session seed, landmark, visit);
 *   - one letter maximum per landmark visit — repeat queries return the
 *     same letter, never a fresh draft.
 *
 * Pure simulation/text module — no DOM, no Babylon. Determinism law holds:
 * all draws flow through src/core/rng.ts hashes and the seeded RNG class.
 */
import { RNG, hash4i, seedFromString } from '../core/rng';
// F66: the handwritten line pools live with the other content banks
import { PHRASINGS, DETAILS, type ChoiceKind } from '../content/doubleletters-pool';

export type { ChoiceKind };

// ---- injected ledger ----------------------------------------------------------

/** All decision kinds, canonical order used for stable iteration. */
export const CHOICE_KINDS: readonly ChoiceKind[] = ['mercy', 'cruelty', 'curiosity', 'avoidance'];

/** One recorded player decision (injected read-only view). */
export interface ChoiceLedgerEntry {
  /** Stable id of the decision; appears verbatim inside letters. */
  readonly choiceId: string;
  /** Which score column this decision lands in. */
  readonly kind: ChoiceKind;
  /** Per-choice salt steering the letter's incidental details. */
  readonly detailSeed: number;
}

/** A discovered landmark the Double may leave a letter at. */
export interface LandmarkVisit {
  /** Stable landmark identifier. */
  readonly landmarkId: string;
  /** 1-based ordinal of this visit to the landmark. */
  readonly visitSeq: number;
}

// ---- tuning -------------------------------------------------------------------

/** Tone starts here once any matching choice exists. */
export const TONE_FLOOR = 1;

/** Loudest tone the Double reaches. */
export const TONE_CEILING = 3;

/** Same-kind repeats needed per step up the tone ladder. */
export const REPEATS_PER_TONE_STEP = 2;

/** Salt separating this system's hash stream from other rng.ts consumers. */
const HASH_SALT = 0x646f7562; // "doub"

// ---- letter -------------------------------------------------------------------

/** One drafted Doppelgänger letter. */
export interface DoppelLetter {
  /** Stable letter id derived from landmark + visit. */
  readonly id: string;
  /** Landmark the letter was left at. */
  readonly landmarkId: string;
  /** Visit ordinal this letter answers. */
  readonly visitSeq: number;
  /** Decision kind the letter criticizes. */
  readonly kind: ChoiceKind;
  /** Real ledger choice ids cited by this letter (non-empty). */
  readonly references: readonly string[];
  /** Tone level in [TONE_FLOOR, TONE_CEILING]. */
  readonly tone: number;
  /** Full letter body; every id in {@link references} appears verbatim. */
  readonly text: string;
}

// ---- helpers ------------------------------------------------------------------

/** Clamp a tone ladder position into the legal band. */
function clampTone(step: number): number {
  return Math.min(TONE_CEILING, Math.max(TONE_FLOOR, TONE_FLOOR + step));
}

/** Tone level for `count` prior choices of one kind; monotone in count. */
export function toneForRepeatCount(count: number): number {
  if (!Number.isFinite(count) || count < 1) return TONE_FLOOR;
  return clampTone(Math.floor((count - 1) / REPEATS_PER_TONE_STEP));
}

/** Replace `%C` (choice id) and `%D` (seeded detail) placeholders. */
function renderTemplate(template: string, choiceId: string, detail: string): string {
  return template.split('%C').join(choiceId).split('%D').join(detail);
}

// ---- drafter --------------------------------------------------------------------

/**
 * Drafts Doppelgänger letters against an injected choice ledger. Create one
 * per session; query it once per landmark discovery.
 */
export class DoubleLetters {
  private readonly ledger: readonly ChoiceLedgerEntry[];
  private readonly seed: number;
  private readonly issued = new Map<string, DoppelLetter | null>();

  constructor(deps: { ledger: readonly ChoiceLedgerEntry[]; seed: number }) {
    this.ledger = deps.ledger ?? [];
    this.seed = deps.seed >>> 0 || 0x9e3779b9;
  }

  /** Number of letters actually drafted this session (dedup excludes repeats). */
  get letterCount(): number {
    let n = 0;
    for (const l of this.issued.values()) if (l !== null) n++;
    return n;
  }

  /**
   * Draft (or recall) the letter left at one landmark visit. Returns `null`
   * when there is nothing to criticize (empty ledger). Calling twice for
   * the same landmark visit returns the identical letter — one per visit.
   *
   * @param visit landmark id and 1-based visit ordinal
   * @returns the letter, or null when no ledger choices exist
   */
  letterFor(visit: LandmarkVisit): DoppelLetter | null {
    const key = `${visit.landmarkId}#${visit.visitSeq}`;
    if (this.issued.has(key)) return this.issued.get(key)!;
    const letter = this.draft(visit);
    this.issued.set(key, letter);
    return letter;
  }

  // -- internals --------------------------------------------------------------

  /** Deterministically draft one letter for a landmark visit. */
  private draft(visit: LandmarkVisit): DoppelLetter | null {
    const usable = this.ledger.filter(
      (e) => e && typeof e.choiceId === 'string' && e.choiceId.length > 0 && CHOICE_KINDS.includes(e.kind),
    );
    if (usable.length === 0) return null;

    const landmarkHash = seedFromString(visit.landmarkId);
    const rng = new RNG(hash4i(this.seed, landmarkHash, visit.visitSeq | 0 || 1, HASH_SALT));

    // Pick which kind to scold about — only among kinds the player has.
    const kindsPresent = CHOICE_KINDS.filter((k) => usable.some((e) => e.kind === k));
    const kind = rng.pick(kindsPresent);

    // Most recent choices of that kind, newest first.
    const matches: ChoiceLedgerEntry[] = [];
    for (let i = usable.length - 1; i >= 0; i--) {
      if (usable[i]!.kind === kind) matches.push(usable[i]!);
    }

    // Tone escalates with how often this kind repeats in the ledger.
    const tone = toneForRepeatCount(matches.length);

    // Cite one or two most recent choices; two only when the roll allows.
    const citeTwo = matches.length >= 2 && rng.chance(0.45);
    const cited = citeTwo ? matches.slice(0, 2) : matches.slice(0, 1);

    const bank = PHRASINGS[kind];
    const levelBank = bank[Math.min(tone, bank.length) - 1]!;
    const primary = cited[0]!;
    const template = levelBank[rng.int(0, levelBank.length)]!;
    let text = renderTemplate(template, primary.choiceId, this.detailWord(primary, landmarkHash, 0));

    if (citeTwo && cited[1]) {
      const second = levelBank[rng.int(0, levelBank.length)]!;
      text += ' ' + renderTemplate(second, cited[1].choiceId, this.detailWord(cited[1], landmarkHash, 1));
    }

    return {
      id: `doppel-${visit.landmarkId}-${visit.visitSeq}`,
      landmarkId: visit.landmarkId,
      visitSeq: visit.visitSeq,
      kind,
      references: cited.map((c) => c.choiceId),
      tone,
      text,
    };
  }

  /**
   * Seeded detail phrase for one ledger choice. Mixes the choice's
   * detailSeed with session seed, landmark, and citation slot so details
   * vary per letter instead of sticking to one phrase per choice.
   */
  private detailWord(entry: ChoiceLedgerEntry, landmarkHash: number, citeIndex: number): string {
    const pool = DETAILS[entry.kind];
    return pool[hash4i(entry.detailSeed | 0, this.seed, landmarkHash ^ citeIndex, HASH_SALT) % pool.length]!;
  }
}
