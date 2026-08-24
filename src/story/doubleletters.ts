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

// ---- injected ledger ----------------------------------------------------------

/** The kinds of decisions the Double keeps score of. */
export type ChoiceKind = 'mercy' | 'cruelty' | 'curiosity' | 'avoidance';

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

// ---- phrasing banks -----------------------------------------------------------

/**
 * Critical phrasings per kind and tone level. Level 0 is almost polite,
 * level 2 is the Double at its coldest. `%C` receives a cited choice id,
 * `%D` a detail word seeded from that choice's detailSeed.
 */
const PHRASINGS: Record<ChoiceKind, string[][]> = {
  mercy: [
    [
      'You spared %C. Kindness down here is a debt someone else collects.',
      'You showed mercy at %C — %D. It was noted. It will be repaid wrong.',
      'You let %C walk away past %D. Gentleness is just a slower appetite.',
    ],
    [
      '%C again — %D this time. You keep sparing things that would not spare you.',
      'Twice-kind now: %C. The walls learn your pattern faster than you do.',
      'You softened again at %C, soft as %D. Mercy repeated stops being mercy.',
    ],
    [
      '%C. %D. How many times will you be gentle before something wears your face better?',
      'You cannot stop saving things — last it was %D at %C. Something is counting.',
      'Every mercy — %C above all — is a thread it pulls tighter around you.',
    ],
  ],
  cruelty: [
    [
      'You hurt %C. I felt it from the other side of the wall.',
      '%C bled because of you. %D still remembers the shape of it. The building approved.',
      'You chose cruelty at %C. It suits you more than you admit.',
    ],
    [
      '%C again. Cruelty is becoming a habit, not a survival.',
      'You did it twice — %C. Your hands remembered before you did.',
      'Second cruelty logged: %C beside %D. The hum got warmer afterward.',
    ],
    [
      '%C. %D. You are practicing. On what, I refuse to imagine.',
      'The cruelty repeats — %C, most recently %D — and each time it looks more like enjoyment.',
      'You keep breaking what finds you: %C. Soon nothing will come find you. Except me.',
    ],
  ],
  curiosity: [
    [
      'You opened what you found at %C — %D. Curiosity is how it learns your routes.',
      '%C — you looked closer. Looking is a door that opens from both sides.',
      'You investigated %C. It appreciated the attention.',
    ],
    [
      '%C again. You peer into everything. Everything peeks back.',
      'Second time you could not resist: %C, even %D. The corridors rearrange for watchers.',
      'You keep leaning in — %C. Lean far enough and the room leans out.',
    ],
    [
      '%C. %D. You catalog the dark like it will thank you.',
      'Your curiosity never ran out — %C saw to that, and %D before it. Neither did its appetite.',
      'Every question you asked at %C was answered by something wearing your handwriting.',
    ],
  ],
  avoidance: [
    [
      'You walked past %C. Avoidance leaves a shape where you refused to look.',
      '%C stayed unopened — so did %D. The hallway remembers refusals longer than rooms.',
      'You turned away from %D at %C. Turning away is still turning.',
    ],
    [
      '%C again. You flinch the same direction every time. Something practices the timing.',
      'Second avoidance: %C. You left %D behind. The unexplored side of you is filling up with them.',
      'You skipped %C like the last one. The skips are drawing a map of your fear.',
    ],
    [
      '%C. %D. You have made avoidance into a home. It has made you into a door.',
      'Always away — %C — never once toward %D. What accumulates behind you does not knock.',
      'Your refusals pile up at %C. One day they will answer for you.',
    ],
  ],
};

/** Detail vocabulary per kind; `%D` slots draw from these, seeded per choice. */
const DETAILS: Record<ChoiceKind, readonly string[]> = {
  mercy: ['the wet bandage', 'that limping shadow', 'the borrowed coat', 'a half-eaten ration'],
  cruelty: ['the splintered doorframe', 'a smear that dried wrong', 'the kicked-over lamp', 'something small and quiet'],
  curiosity: ['the humming vent', 'that third light switch', 'the mirrored hallway', 'a page of your own handwriting'],
  avoidance: ['the sealed stairwell', 'the door that breathed', 'that too-long corridor', 'the room with your name on it'],
};

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
