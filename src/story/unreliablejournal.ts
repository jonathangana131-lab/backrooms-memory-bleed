/**
 * Unreliable journal for BACKROOMS: MEMORY BLEED (F80).
 *
 * Journal entries are not stable records. Each entry is injected with a
 * stable true text; when the player re-reads an entry after at least
 * REWRITE_GAP_VISITS intervening visits (measured by an injected visit
 * counter), the entry rewrites itself: words swap, statements negate,
 * names substitute from a fixed pool. Every rewrite produces a new
 * version; version 0 is always the untouched original, and the original
 * stays byte-recoverable forever through `trueReading` — the debug path
 * that reads what was actually written.
 *
 * All randomness flows from src/core/rng.ts keyed by the entry seed and
 * the rewrite index, so the same entry re-read after the same number of
 * intervening visits produces byte-identical text across instances and
 * processes. Rewrite counts stay bounded by the visit count: each rewrite
 * consumes at least REWRITE_GAP_VISITS of counter movement between reads.
 *
 * Pure Node-testable: no DOM, no Babylon, no Date.now(), no Math.random()
 * (see test/unreliablejournal-test.mjs).
 */

import { RNG, hash32, seedFromString } from '../core/rng';

/** Intervening-visit gap required between a read and its next rewrite. */
export const REWRITE_GAP_VISITS = 5;

/** Version index of the untouched original in every history. */
export const ORIGINAL_VERSION = 0;

/**
 * Corruptions applied on rewrite v (first rewrite is v = 1): one more
 * corruption site per version, capped so late entries stay readable.
 */
export function corruptionsForVersion(version: number): number {
  return Math.min(version, CORRUPTIONS_CAP);
}

/** Maximum corruption sites applied in a single rewrite. */
export const CORRUPTIONS_CAP = 4;

// ---------------------------------------------------------------------------
// Corruption tables
// ---------------------------------------------------------------------------

/**
 * Whole-word swaps: journal words -> wrong-but-plausible alternates.
 * Matched case-insensitively on word boundaries; replacements land verbatim.
 */
export const WORD_SWAPS: Readonly<Record<string, string>> = {
  walked: 'was walked',
  saw: 'had already seen',
  wrote: 'someone wrote',
  remember: 'am told I remember',
  house: 'building',
  night: 'the third night',
  found: 'was handed',
  door: 'a door',
  hallway: 'the hallway again',
  light: 'the light',
  dark: 'darker',
  heard: 'overheard myself hearing',
  cold: 'colder than before',
  quiet: 'too quiet',
  returned: 'was returned',
  keys: 'the spare keys',
};

/** Verbs eligible for negation; "never" is inserted in front of the pick. */
export const NEGATABLE_VERBS: readonly string[] = [
  'went', 'opened', 'closed', 'told', 'left', 'kept', 'took', 'hid', 'waited', 'followed',
];

/**
 * Name pool for substitutions. A name present in the text is replaced by a
 * different name from this pool, offset deterministically per rewrite.
 */
export const NAME_POOL: readonly string[] = [
  'Elias', 'Mara', 'Tobias', 'June', 'Wren', 'the tall man',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An injected journal entry. `trueText` never mutates inside the model. */
export interface JournalEntrySpec {
  /** Stable entry identifier. */
  id: string;
  /** What was actually written — recoverable only via `trueReading`. */
  trueText: string;
  /** Per-entry seed mixed into every rewrite draw. */
  seed: number;
}

/** One stored revision of an entry. Version 0 is the original. */
export interface JournalVersion {
  /** Monotone version index; equals the rewrite ordinal. */
  version: number;
  /** Visit-counter value observed when this version came into being. */
  atVisits: number;
  /** Full text of this revision. */
  text: string;
}

/** Result of a single read. */
export interface JournalReading {
  /** Entry id, echoed. */
  id: string;
  /** Text as it reads right now. */
  text: string;
  /** Version index served by this read. */
  version: number;
  /** True iff this read produced a fresh rewrite. */
  rewrote: boolean;
}

// ---------------------------------------------------------------------------
// Core corruption pass
// ---------------------------------------------------------------------------

/** One candidate corruption site found in a text. */
interface CorruptionSite {
  start: number;
  end: number;
  word: string;
  replacement: string | null;
}

function classifyWord(word: string): 'swap' | 'negate' | 'name' | null {
  const lower = word.toLowerCase().replace(/[^a-z]/g, '');
  if (Object.prototype.hasOwnProperty.call(WORD_SWAPS, lower)) return 'swap';
  if ((NEGATABLE_VERBS as readonly string[]).includes(lower)) return 'negate';
  if ((NAME_POOL as readonly string[]).includes(word)) return 'name';
  return null;
}

function swapReplacement(word: string): string {
  return WORD_SWAPS[word.toLowerCase()] ?? word;
}

function nameReplacement(word: string, rand: RNG): string {
  const idx = (NAME_POOL as readonly string[]).indexOf(word);
  const step = 1 + rand.int(1, NAME_POOL.length - 1);
  return NAME_POOL[(idx + step) % NAME_POOL.length];
}

/**
 * Collect all corruption-eligible sites in `text`, then apply exactly
 * `count` of them chosen by `rand`. Replacements are spliced from the end
 * so earlier offsets stay valid.
 */
function corrupt(text: string, rand: RNG, count: number): string {
  const sites: CorruptionSite[] = [];
  const tokenRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const kind = classifyWord(m[0]);
    if (kind === null) continue;
    let replacement: string | null = null;
    if (kind === 'swap') replacement = swapReplacement(m[0]);
    else if (kind === 'name') replacement = nameReplacement(m[0], rand);
    else replacement = null; // negation decided at splice time
    sites.push({ start: m.index, end: m.index + m[0].length, word: m[0], replacement });
  }
  if (sites.length === 0) return text;

  // Deterministic partial Fisher-Yates over site indices: pick `count`
  // distinct sites without replacement.
  const n = Math.min(count, sites.length);
  for (let i = 0; i < n; i++) {
    const j = i + rand.int(0, sites.length - i);
    const tmp = sites[i]; sites[i] = sites[j]; sites[j] = tmp;
  }
  const chosen = sites.slice(0, n).sort((a, b) => b.start - a.start);
  let out = text;
  for (const site of chosen) {
    const repl = site.replacement !== null
      ? site.replacement
      : 'never ' + site.word.toLowerCase();
    out = out.slice(0, site.start) + repl + out.slice(site.end);
  }
  return out;
}

/**
 * Produce the rewritten text for an entry moving to `version`, given the
 * text of the previous version. Deterministic in (id, seed, version).
 *
 * @param id Entry id, hashed into the stream salt.
 * @param seed Entry seed from the spec.
 * @param prevText Text being corrupted.
 * @param version New (>=1) version index; sets both salt and intensity.
 * @returns The corrupted next-version text.
 */
export function rewriteForVersion(id: string, seed: number, prevText: string, version: number): string {
  const rng = new RNG((seed ^ hash32(seedFromString(id) ^ hash32(version))) >>> 0);
  return corrupt(prevText, rng, corruptionsForVersion(version));
}

// ---------------------------------------------------------------------------
// Journal model
// ---------------------------------------------------------------------------

/** Per-entry mutable state. */
interface EntryState {
  spec: JournalEntrySpec;
  versions: JournalVersion[];
  lastReadVisits: number | null;
}

/**
 * The unreliable journal. Entries are injected at construction together
 * with the session's visit counter; reading is the only mutating act.
 */
export class UnreliableJournal {
  private states = new Map<string, EntryState>();
  private getVisits: () => number;

  /**
   * @param entries Injected entry specs; ids must be unique.
   * @param getVisitCount Injected session visit counter, non-decreasing.
   */
  constructor(entries: readonly JournalEntrySpec[], getVisitCount: () => number) {
    for (const e of entries) {
      if (this.states.has(e.id)) throw new Error(`duplicate journal entry id: ${e.id}`);
      this.states.set(e.id, {
        spec: e,
        versions: [{ version: ORIGINAL_VERSION, atVisits: getVisitCount(), text: e.trueText }],
        lastReadVisits: null,
      });
    }
    this.getVisits = getVisitCount;
  }

  /**
   * Read an entry. If at least REWRITE_GAP_VISITS intervened since the
   * previous read, the entry rewrites once into the next version.
   *
   * @param id Entry id; unknown ids fail loud.
   * @returns The reading actually served, including the new version on rewrite.
   */
  read(id: string): JournalReading {
    const st = this.require(id);
    const now = this.getVisits();
    const last = st.lastReadVisits;
    st.lastReadVisits = now;
    if (last !== null && now - last >= REWRITE_GAP_VISITS) {
      const nextVersion = st.versions[st.versions.length - 1].version + 1;
      const prev = st.versions[st.versions.length - 1].text;
      const nextText = rewriteForVersion(st.spec.id, st.spec.seed, prev, nextVersion);
      st.versions.push({
        version: nextVersion,
        atVisits: now,
        text: nextText,
      });
      return { id, text: nextText, version: nextVersion, rewrote: true };
    }
    const cur = st.versions[st.versions.length - 1];
    return { id, text: cur.text, version: cur.version, rewrote: false };
  }

  /**
   * Full version history, oldest (original) first. Callers must treat the
   * array as read-only.
   */
  history(id: string): readonly JournalVersion[] {
    return this.require(id).versions.slice();
  }

  /** Number of rewrites this entry has undergone. */
  rewriteCount(id: string): number {
    return this.require(id).versions.length - 1;
  }

  /**
   * Debug path: the TRUE text, unaffected by any rewrite. This is the only
   * sanctioned way to recover what was originally written.
   */
  trueReading(id: string): string {
    return this.require(id).spec.trueText;
  }

  private require(id: string): EntryState {
    const st = this.states.get(id);
    if (!st) throw new Error(`unknown journal entry: ${id}`);
    return st;
  }
}
