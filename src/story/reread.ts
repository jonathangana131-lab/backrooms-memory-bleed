/**
 * Note rereading with memory distortion for BACKROOMS: MEMORY BLEED.
 *
 * Notes are not inert once read. This module tracks which notes have been
 * opened before and degrades the experience of returning to them:
 *
 *   1. Read tracking   - notes read at least once show a dimmer, changed
 *                        prompt ("E — REREAD" instead of "E — READ").
 *                        Content is identical; only the invitation differs.
 *   2. Memory bleed    - on a second-or-later read, ONE word occasionally
 *                        swaps for an unsettling alternate (SYNONYMS below).
 *                        The altered word arrives subtly highlighted so the
 *                        UI can render it wrong without shouting about it,
 *                        and the swap is counted per note.
 *   3. Persistence     - read-note IDs, read counts, and alteration records
 *                        survive reloads under localStorage 'bmb-reread'.
 *
 * Everything decision-shaped lives in module-level pure functions
 * (deterministic under Node: no Date.now(), no Math.random()) so the bleed is
 * reproducible and unit-testable (see test/reread-test.mjs).
 */

// ---------------------------------------------------------------------------
// Synonym map: horror-text words -> unsettling alternates
// ---------------------------------------------------------------------------

/**
 * The bleed vocabulary. Keys are lowercase words matched as whole words inside
 * note text; values replace them verbatim. Alternates lean uncanny rather
 * than loud — memory should feel untrustworthy, not haunted-house obvious.
 */
export const SYNONYMS: Readonly<Record<string, string>> = {
  walked: 'was walked',
  saw: 'witnessed',
  door: 'the door',
  doors: 'the doors',
  hallway: 'the hallway',
  corridor: 'the corridor',
  room: 'the room',
  light: 'the light',
  dark: 'darker',
  darkness: 'the darkness',
  heard: 'overheard',
  listened: 'listened back',
  found: 'uncovered',
  said: 'said again',
  wrote: 'scrawled',
  read: 'reread',
  remember: 'recalled',
  forget: 'misremember',
  help: 'helped',
  ran: 'was run',
  hide: 'be hidden',
  hid: 'was hidden',
  wait: 'waited',
  waited: 'kept waiting',
  cold: 'colder',
  warm: 'too warm',
  quiet: 'too quiet',
  hum: 'humming',
  buzzing: 'buzzing louder',
  wall: 'the wall',
  walls: 'closer walls',
  ceiling: 'lower ceiling',
  floor: 'soft floor',
  someone: 'something',
  something: 'someone',
  anyone: 'no one',
  everyone: 'every one',
  here: 'still here',
  gone: 'taken',
  lost: 'misplaced',
  alone: 'watched',
  safe: 'temporarily safe',
  home: 'elsewhere',
  yesterday: 'tomorrow',
  morning: 'morning again',
  face: 'a face',
  name: 'my name',
};

// ---------------------------------------------------------------------------
// Distortion presentation + deterministic randomness
// ---------------------------------------------------------------------------

/** Subtle highlight wrappers around an altered word. */
export const DISTORT_OPEN = '\u27e6'; // ⟦
export const DISTORT_CLOSE = '\u27e7'; // ⟧

/** True when the text currently carries at least one highlighted word. */
export function hasHighlight(text: string): boolean {
  return text.includes(DISTORT_OPEN) && text.includes(DISTORT_CLOSE);
}

/** Remove highlight wrappers, keeping the (possibly altered) words. */
export function stripHighlights(text: string): string {
  return text.split(DISTORT_OPEN).join('').split(DISTORT_CLOSE).join('');
}

/** FNV-1a: short, stable, well-mixed string hash. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: tiny, deterministic, good enough for texture. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chance that any given reread bleeds. Roughly half of rereads shift. */
export const BLEED_PROBABILITY = 0.55;

interface SwapCandidate {
  /** Lowercased dictionary key that matched. */
  key: string;
  /** Replacement text for this key. */
  replacement: string;
  /** Index of the first character of the match. */
  start: number;
  /** Index just past the match. */
  end: number;
}

/** Whole-word, case-preserving scan for synonym keys present in the text. */
export function findSwapCandidates(text: string): SwapCandidate[] {
  const out: SwapCandidate[] = [];
  const re = /[A-Za-z']+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[0].toLowerCase();
    const replacement = SYNONYMS[key];
    if (replacement !== undefined) {
      out.push({ key, replacement, start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** Case-shape the replacement to roughly match the original word's shape. */
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) {
    return replacement.toUpperCase();
  }
  if (/^[A-Z]/.test(original)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Pure distortion pass. Given the raw note text and a deterministic seed,
 * returns the (possibly) distorted text plus whether anything changed. At
 * most ONE word swaps per call, and only when the seeded roll passes
 * BLEED_PROBABILITY and at least one synonym key appears in the text.
 */
export function distortOnce(
  text: string,
  seedStr: string,
  roll: number = mulberry32(hashString(seedStr))(),
): { text: string; altered: boolean } {
  if (!text || typeof roll !== 'number' || !Number.isFinite(roll)) {
    return { text, altered: false };
  }
  if (roll >= BLEED_PROBABILITY) return { text, altered: false };
  const candidates = findSwapCandidates(text);
  if (candidates.length === 0) return { text, altered: false };

  const rng = mulberry32(hashString('pick:' + seedStr));
  const choice = candidates[Math.floor(rng() * candidates.length)]!;
  const original = text.slice(choice.start, choice.end);
  const replacement =
    DISTORT_OPEN + matchCase(original, choice.replacement) + DISTORT_CLOSE;
  return {
    text: text.slice(0, choice.start) + replacement + text.slice(choice.end),
    altered: true,
  };
}

// ---------------------------------------------------------------------------
// Prompt copy
// ---------------------------------------------------------------------------

const PROMPT_READ = 'E \u2014 READ';
const PROMPT_REREAD = 'E \u2014 REREAD';

/** Prompt for a note: dimmer "REREAD" wording once it has been opened. */
export function promptForRead(isAlreadyRead: boolean): string {
  return isAlreadyRead ? PROMPT_REREAD : PROMPT_READ;
}

// ---------------------------------------------------------------------------
// State shape + persistence
// ---------------------------------------------------------------------------

export const REREAD_STORAGE_KEY = 'bmb-reread';

export interface AlterationRecord {
  /** Original word, as matched (lowercase dictionary key). */
  from: string;
  /** Replacement text actually written into the note. */
  to: string;
  /** Monotonic per-note sequence number of this alteration. */
  seq: number;
}

export interface RereadState {
  version: 1;
  /** noteId -> number of times opened. */
  reads: Record<string, number>;
  /** noteId -> ordered alteration history (memory bleed ledger). */
  alterations: Record<string, AlterationRecord[]>;
}

function emptyState(): RereadState {
  return { version: 1, reads: {}, alterations: {} };
}

/** Structural clone that survives structuredClone-less environments. */
function cloneState(s: RereadState): RereadState {
  const reads: Record<string, number> = {};
  for (const k of Object.keys(s.reads)) reads[k] = s.reads[k]!;
  const alts: Record<string, AlterationRecord[]> = {};
  for (const k of Object.keys(s.alterations)) {
    alts[k] = (s.alterations[k] ?? []).map((a) => ({ ...a }));
  }
  return { version: 1, reads, alterations: alts };
}

/** Best-effort validation of untrusted persisted/imported payloads. */
export function sanitizeState(raw: unknown): RereadState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (typeof obj.reads !== 'object' || obj.reads === null || Array.isArray(obj.reads)) return null;
  if (typeof obj.alterations !== 'object' || obj.alterations === null || Array.isArray(obj.alterations)) return null;
  const reads: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj.reads as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) reads[k] = Math.floor(v);
  }
  const alterations: Record<string, AlterationRecord[]> = {};
  for (const [k, v] of Object.entries(obj.alterations as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const list: AlterationRecord[] = [];
    for (const item of v) {
      if (typeof item !== 'object' || item === null) continue;
      const a = item as Record<string, unknown>;
      if (typeof a.from !== 'string' || typeof a.to !== 'string') continue;
      if (typeof a.seq !== 'number' || !Number.isFinite(a.seq)) continue;
      list.push({ from: a.from, to: a.to, seq: Math.floor(a.seq) });
    }
    alterations[k] = list;
  }
  return { version: 1, reads, alterations };
}

// ---------------------------------------------------------------------------
// Runtime system
// ---------------------------------------------------------------------------

export interface NoteRereadOptions {
  /**
   * Storage backend override (defaults to window.localStorage when present).
   * Pass null to run entirely in-memory (tests, private contexts).
   */
  storage?: Storage | null;
}

export interface DistortResult {
  /** The note text after this reading — possibly one word worse. */
  text: string;
  /** True when a word was swapped during THIS reading. */
  altered: boolean;
}

/**
 * Owns the read ledger and the distortion pass. Construct one per game
 * session; it loads persisted state eagerly and writes through on change.
 */
export class NoteReread {
  private state: RereadState;
  private readonly store: Storage | null;

  constructor(opts: NoteRereadOptions = {}) {
    this.store = opts.storage !== undefined ? opts.storage : detectStorage();
    this.state = emptyState();
    this.load();
  }

  // -- read tracking ---------------------------------------------------------

  /** Record that the player just opened this note (increments the count). */
  markRead(noteId: string): void {
    if (!noteId) return;
    const cur = this.state.reads[noteId] ?? 0;
    this.state.reads[noteId] = cur + 1;
    this.save();
  }

  /** Has this note been opened at least once before? */
  isRead(noteId: string): boolean {
    return (this.state.reads[noteId] ?? 0) > 0;
  }

  /** How many times this note has been opened (0 if never). */
  readCount(noteId: string): number {
    return this.state.reads[noteId] ?? 0;
  }

  /** Interaction prompt copy for this note's current state. */
  promptFor(noteId: string): string {
    return promptForRead(this.isRead(noteId));
  }

  // -- distortion ------------------------------------------------------------

  /**
   * Run one reading of the note text. On a second-or-later read this may
   * swap ONE word for its SYNONYMS alternate, wrapping the altered word in
   * DISTORT_OPEN/DISTORT_CLOSE for subtle highlighting by the UI. Every
   * successful swap is recorded in the alteration ledger.
   */
  distort(text: string, noteId: string): DistortResult {
    if (!text || !noteId) return { text, altered: false };
    const count = this.readCount(noteId);
    if (count < 2) return { text, altered: false }; // first read stays pristine

    const seedStr = noteId + '#' + count;
    const roll = mulberry32(hashString(seedStr))();
    const result = distortOnce(text, seedStr, roll);
    if (!result.altered) return { text: result.text, altered: false };

    // Identify which dictionary key produced the highlighted replacement so
    // the ledger records a meaningful "from".
    const m = /\u27e6(.+?)\u27e7/.exec(result.text);
    const shownRaw = m ? m[1]! : '';
    let fromKey = '?';
    for (const c of findSwapCandidates(stripHighlights(text))) {
      const shaped = matchCase(text.slice(c.start, c.end), c.replacement);
      if (shaped === shownRaw) {
        fromKey = c.key;
        break;
      }
    }

    const list = this.state.alterations[noteId] ?? [];
    list.push({ from: fromKey, to: stripHighlights(shownRaw), seq: list.length + 1 });
    this.state.alterations[noteId] = list;
    this.save();

    return { text: result.text, altered: true };
  }

  /** Total number of recorded alterations across all notes. */
  totalAlterations(): number {
    let n = 0;
    for (const k of Object.keys(this.state.alterations)) {
      n += (this.state.alterations[k] ?? []).length;
    }
    return n;
  }

  /** Alteration history for one note (oldest first). */
  alterationsFor(noteId: string): AlterationRecord[] {
    return (this.state.alterations[noteId] ?? []).map((a) => ({ ...a }));
  }

  // -- persistence -----------------------------------------------------------

  /** Deep-copy snapshot of the full state, suitable for JSON transport. */
  exportState(): RereadState {
    return cloneState(this.state);
  }

  /**
   * Replace in-memory state with a validated snapshot and persist it.
   * Returns true when the snapshot was accepted.
   */
  importState(raw: unknown): boolean {
    const clean = sanitizeState(raw);
    if (!clean) return false;
    this.state = clean;
    this.save();
    return true;
  }

  private load(): void {
    const store = this.store;
    if (!store) return;
    try {
      const raw = store.getItem(REREAD_STORAGE_KEY);
      if (!raw) return;
      const clean = sanitizeState(JSON.parse(raw));
      if (clean) this.state = clean;
    } catch (err) {
      console.warn('[reread] failed to load state; starting clean', err);
    }
  }

  private save(): void {
    const store = this.store;
    if (!store) return;
    try {
      store.setItem(REREAD_STORAGE_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.warn('[reread] failed to persist state', err);
    }
  }
}

/** localStorage when available and writable-looking, else null. */
function detectStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* denied */ }
  return null;
}


