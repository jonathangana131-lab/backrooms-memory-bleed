/**
 * Choice-weighted whisper chorus for BACKROOMS: MEMORY BLEED (F81).
 *
 * The whispers are not ambient filler — they reference the player's moral
 * micro-choices. A choice ledger is injected at construction:
 * {choiceId, kind, weightDelta}. Chorus lines pick which choice to reference
 * with probability proportional to |weightDelta|, so morally heavier
 * choices are whispered proportionally more often, and every line is
 * assembled from seeded fragments of the choice's kind. Kinds absent from
 * the ledger are never referenced; an empty (or all-zero-weight) ledger is
 * silence-safe: whisper() returns null instead of speaking.
 *
 * The output stream keeps a dedup window: the same line text is never
 * emitted twice within DEDUP_WINDOW consecutive outputs. Colliding picks
 * redraw deterministically up to MAX_PICK_ATTEMPTS and otherwise fall
 * silent for that call.
 *
 * All randomness flows from src/core/rng.ts keyed by the chorus seed and
 * the choice ids, so a given seed + ledger replays an identical stream.
 *
 * Pure Node-testable: no DOM, no Babylon audio graph, no Date.now(), no
 * Math.random() (see test/whisperchorus-test.mjs).
 */

import { RNG, hash32, seedFromString } from '../core/rng';

// ---------------------------------------------------------------------------
// Choice kinds + fragment pools
// ---------------------------------------------------------------------------

/** Fixed vocabulary of moral micro-choice kinds. */
export type ChoiceKind = 'mercy' | 'cruelty' | 'theft' | 'honesty' | 'betrayal';

/** All kinds the chorus can ever voice; a subset appears in any one ledger. */
export const CHOICE_KINDS: readonly ChoiceKind[] = [
  'mercy', 'cruelty', 'theft', 'honesty', 'betrayal',
];

/** Opening fragments per kind; each names the player's deed of that kind. */
export const KIND_OPENERS: Readonly<Record<ChoiceKind, readonly string[]>> = {
  mercy: [
    'someone still feels the hand you lent',
    'the bandage you tied is holding',
    'your kindness is being counted',
    'what you gave down here comes back',
  ],
  cruelty: [
    'the bruise you left remembers your name',
    'what you broke is still sharp',
    'someone is counting your cruelty',
    'the harm you did grew roots',
  ],
  theft: [
    'the missing thing knows your fingers',
    'what you took is heavier now',
    'the stolen weight follows you',
    'your pockets are being inventoried',
  ],
  honesty: [
    'the truth you told is growing teeth',
    'your confession echoes ahead of you',
    'what you admitted is listening back',
    'the words you spared no one ring on',
  ],
  betrayal: [
    'the locked door knows who sold it',
    'the trust you spent has been itemized',
    'someone keeps your betrayal warm',
    'what you traded away knocks at night',
  ],
};

/** Closing tails per kind-agnostic texture; combined with an opener. */
export const KIND_CLOSERS: readonly string[] = [
  'down here.', 'tonight.', 'again.', 'where you stand.', 'behind you.', 'in the walls.',
];

/** Minimum distinct lines a single choice can produce (openers × closers). */
export function variantsPerChoice(): number {
  return KIND_OPENERS.mercy.length * KIND_CLOSERS.length;
}

/**
 * Deterministic line text for one choice at one variant index.
 *
 * @param kind Kind selecting the fragment pool.
 * @param openerIdx Index into KIND_OPENERS[kind] (mod length).
 * @param closerIdx Index into KIND_CLOSERS (mod length).
 * @returns The full whisper line.
 */
export function assembleLine(kind: ChoiceKind, openerIdx: number, closerIdx: number): string {
  const openers = KIND_OPENERS[kind];
  return openers[((openerIdx % openers.length) + openers.length) % openers.length]
    + ' '
    + KIND_CLOSERS[((closerIdx % KIND_CLOSERS.length) + KIND_CLOSERS.length) % KIND_CLOSERS.length];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One injected moral micro-choice. */
export interface LedgerEntry {
  /** Stable choice identifier; must be unique within a ledger. */
  choiceId: string;
  /** Moral kind; selects the fragment pool voiced for this choice. */
  kind: ChoiceKind;
  /** Signed moral weight; selection weight is its absolute value. */
  weightDelta: number;
}

/** One emitted chorus line. */
export interface Whisper {
  /** Full line text as spoken. */
  text: string;
  /** Kind of the referenced choice. */
  kind: ChoiceKind;
  /** Id of the referenced choice. */
  choiceId: string;
}

// ---------------------------------------------------------------------------
// Weighted selection core
// ---------------------------------------------------------------------------

/** Absolute weight of a ledger entry; zero-weight choices are never picked. */
export function entryWeight(e: LedgerEntry): number {
  return Math.abs(e.weightDelta);
}

// ---------------------------------------------------------------------------
// Chorus model
// ---------------------------------------------------------------------------

/** Consecutive outputs over which identical line text is suppressed. */
export const DEDUP_WINDOW = 6;

/** Deterministic redraws allowed before a colliding pick falls silent. */
export const MAX_PICK_ATTEMPTS = 24;

/** Internal ledger record with cached weight. */
interface LedgerRecord {
  entry: LedgerEntry;
  weight: number;
}

/**
 * The chorus. Constructed over an injected ledger and a session seed;
 * `whisper` is the only output and never mutates ledger state.
 */
export class WhisperChorus {
  private records: LedgerRecord[] = [];
  private totalWeight = 0;
  private rng: RNG;
  private recent: string[] = [];

  /**
   * @param ledger Injected choice ledger; duplicate choiceIds fail loud.
   * @param seed Session seed driving every draw.
   */
  constructor(ledger: readonly LedgerEntry[], seed: number) {
    const seen = new Set<string>();
    for (const e of ledger) {
      if (seen.has(e.choiceId)) throw new Error(`duplicate choice id: ${e.choiceId}`);
      if (!(CHOICE_KINDS as readonly string[]).includes(e.kind)) {
        throw new Error(`unknown choice kind: ${e.kind}`);
      }
      seen.add(e.choiceId);
      const weight = entryWeight(e);
      this.records.push({ entry: e, weight });
      this.totalWeight += weight;
    }
    this.rng = new RNG(seed >>> 0 || 0x9e3779b9);
  }

  /** Total selection weight; 0 means the chorus stays permanently silent. */
  get totalSelectionWeight(): number {
    return this.totalWeight;
  }

  /**
   * Speak one line: pick a ledger entry weighted by |weightDelta|, then a
   * seeded fragment pair of its kind. Lines repeated inside the dedup
   * window redraw deterministically; exhausted redraws return null.
   *
   * @returns The emitted whisper, or null when silent (empty/zero-weight
   * ledger, or dedup saturation).
   */
  whisper(): Whisper | null {
    if (this.totalWeight <= 0) return null;
    let attempt = 0;
    while (attempt < MAX_PICK_ATTEMPTS) {
      attempt++;
      // Weighted roll over cumulative |weightDelta|.
      const r = this.rng.next() * this.totalWeight;
      let acc = 0;
      let chosen = this.records[this.records.length - 1];
      for (const rec of this.records) {
        acc += rec.weight;
        if (r < acc) { chosen = rec; break; }
      }
      // Fragment pair drawn from the choice-id-keyed salt plus attempt so
      // dedup collisions move to a different variant deterministically.
      const salt = hash32(seedFromString(chosen.entry.choiceId) ^ hash32(attempt));
      const openerIdx = this.rng.int(0, 4096) + (salt % 7);
      const closerIdx = (salt >>> 8) % 97;
      const text = assembleLine(chosen.entry.kind, openerIdx, closerIdx);
      if (this.recent.includes(text)) continue;
      this.recent.push(text);
      if (this.recent.length > DEDUP_WINDOW) this.recent.shift();
      return { text, kind: chosen.entry.kind, choiceId: chosen.entry.choiceId };
    }
    return null;
  }

  /**
   * Snapshot of the current dedup window, oldest first.
   */
  recentWindow(): readonly string[] {
    return this.recent.slice();
  }
}
