/**
 * Second wave of vocalization content pools for reconstructed human
 * figures. Companion data to vocalcontent.ts (same shape, same tone
 * contract): watcher name-bursts, helper comfort fragments, and the
 * corrupted speech of the incompletes.
 *
 * Tone contract (matches CLUSTER_STORIES in world/architect.ts):
 *  - quiet dread, never gore; bureaucratic and domestic registers
 *    colliding; denial stated plainly, then repeated; proper nouns
 *    doing the emotional work. A helper being kind is the scariest
 *    thing in the building precisely because it sounds sincere.
 *
 * Everything here is data plus pure selection functions. No DOM,
 * no audio graph, no imports - safe to pull from anywhere.
 */

// ---------------------------------------------------------------------
// Watcher broadcasts - single-word formant bursts naming the lost.
// ---------------------------------------------------------------------

/** One single-word burst a watcher emits toward the player. */
export interface WatcherBurst {
  /** The word itself - always someone else's name, never the player's. */
  readonly text: string;
  /** Spoken-syllable count, kept honest so one burst fits the window. */
  readonly syllables: number;
}

/**
 * Names of previous researchers, recovered from expedition logs
 * (REYES and MARLOW surface again in BROADCAST_FRAGMENTS lore). A
 * watcher saying your predecessor's name means the roster is not
 * historical.
 */
export const WATCHER_BROADCASTS: readonly WatcherBurst[] = [
  { text: 'REYES', syllables: 2 },
  { text: 'MARLOW', syllables: 2 },
  { text: 'OKAFOR', syllables: 3 },
  { text: 'DARA', syllables: 2 },
  { text: 'VANCE', syllables: 1 },
  { text: 'HALE', syllables: 1 },
  { text: 'IBARRA', syllables: 3 },
  { text: 'QUINN', syllables: 1 },
];

/** Minimum seconds between watcher bursts while the player stays near. */
export const WATCHER_BROADCAST_MIN_INTERVAL_S = 30;

/** Maximum seconds between watcher bursts while the player stays near. */
export const WATCHER_BROADCAST_MAX_INTERVAL_S = 60;

/** Watchers only broadcast when the player is inside this radius, meters. */
export const WATCHER_BROADCAST_RADIUS_M = 12;

// ---------------------------------------------------------------------
// Helper comfort phrases - reassurance as formant patterns.
// ---------------------------------------------------------------------

/** One short reassuring fragment a helper offers when you falter. */
export interface HelperComfort {
  /** What the mouth says. Short enough to sound like habit, not script. */
  readonly text: string;
  /** Spoken-syllable count, kept honest for burst-length fitting. */
  readonly syllables: number;
}

/**
 * Comfort fragments emitted only when the player is close AND their
 * stability is low - the helpers arrive precisely when you are easiest
 * to lead. Each is 2-6 syllables.
 */
export const HELPER_COMFORTS: readonly HelperComfort[] = [
  { text: 'this way', syllables: 2 },
  { text: 'not much farther', syllables: 4 },
  { text: 'keep moving', syllables: 3 },
  { text: "you're doing fine", syllables: 4 },
  { text: 'almost there', syllables: 3 },
  { text: "don't stop now", syllables: 3 },
  { text: 'I know a shortcut', syllables: 5 },
  { text: 'stay close to me', syllables: 4 },
  { text: 'the lights are friendly here', syllables: 6 },
  { text: 'we go together', syllables: 5 },
];

/**
 * Helpers speak only below this player-stability fraction; above it
 * they hum along like everyone else.
 */
export const HELPER_COMFORT_LOW_STABILITY = 0.4;

/** Helpers only offer comfort when the player is inside this radius, meters. */
export const HELPER_COMFORT_RADIUS_M = 8;

// ---------------------------------------------------------------------
// Incomplete garble - normal phrases coming back wrong.
// ---------------------------------------------------------------------

/**
 * Plain sentences an incomplete is trying to say. They were ordinary
 * once. The garble pass below is what the mouth does to them now.
 */
export const INCOMPLETE_BASE_PHRASES: readonly string[] = [
  'excuse me, is this seat taken',
  'I will be right behind you',
  'the meeting moved to room four',
  'have you seen my keys anywhere',
  'dinner is at seven tonight',
  'please hold, connecting you now',
  'mind the gap between doors',
  'we regret to inform you',
  'your call is important to us',
  'everything is going to be fine',
];

/** One garbled utterance plus the plain sentence it failed to be. */
export interface GarbledUtterance {
  /** The corrupted output: doubled syllables, truncations, dropped tails. */
  readonly text: string;
  /** The original plain phrase the garble came from. */
  readonly source: string;
}

/**
 * Corrupt one word deterministically from a per-word roll:
 * low roll doubles the opening syllable, mid roll truncates the
 * word mid-shape, high roll leaves it alone. Punctuation is
 * stripped first - incompletes lose their manners before their words.
 */
function corruptWord(word: string, roll: number): string {
  const clean = word.replace(/[^a-z']/gi, '');
  if (clean.length === 0) return word;
  // First syllable-ish chunk: leading consonants plus first vowel run
  // plus up to one trailing consonant before the next vowel.
  const m = clean.match(/[^aeiouy]*[aeiouy]+[^aeiouy]?/i);
  const syl = m ? m[0] : clean.slice(0, Math.max(1, Math.ceil(clean.length / 2)));
  if (roll < 1 / 3) {
    return syl.toLowerCase() + '-' + clean.toLowerCase();
  }
  if (roll < 2 / 3) {
    const cut = Math.max(syl.length, Math.ceil(clean.length / 2));
    return clean.slice(0, cut).toLowerCase();
  }
  return clean.toLowerCase();
}

/**
 * Turn a plain phrase into an incomplete's version of it, fully
 * determined by the seed. Roughly one word in three doubles or
 * truncates, and about half the time the final word is abandoned
 * entirely, leaving the ellipsis the incompletes are known by.
 */
export function garblePhrase(phrase: string, seed: number): GarbledUtterance {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  const words = phrase.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { text: '...', source: phrase };
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const roll = next();
    const isLast = i === words.length - 1;
    if (isLast && next() < 0.5) continue; // abandon the tail
    out.push(corruptWord(words[i], roll));
  }
  const body = out.length > 0 ? out.join(' ') : corruptWord(words[0], 0.1);
  const trailing = next() < 0.7 ? '...' : '.';
  return { text: body + trailing, source: phrase };
}

// ---------------------------------------------------------------------
// Selection logic - seeded, no immediate repetition per figure.
// Mirrors pickFragment in vocalcontent.ts: walk forward from a mixed
// seed, skip anything in recentHistory, fall back to repetition over
// silence when the history saturates the pool.
// ---------------------------------------------------------------------

/** FNV-1a over the four bytes of a 32-bit key. */
function mixSeed(seed: number): number {
  let h = 0x811c9dc5;
  let s = seed >>> 0;
  for (let i = 0; i < 4; i++) {
    h ^= s & 0xff;
    h = Math.imul(h, 0x01000193);
    s >>>= 8;
  }
  return h >>> 0;
}

/** Shared walk: first entry not in history wins; saturated history repeats. */
function pickWalk<T>(pool: readonly T[], seed: number, recentHistory: readonly unknown[]): T | null {
  const n = pool.length;
  if (n === 0) return null;
  const start = mixSeed(seed) % n;
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    const candidate = pool[idx];
    if (!recentHistory.includes(candidate)) return candidate;
  }
  return pool[start];
}

/**
 * Pick a watcher name-burst, deterministically from the seed, never
 * repeating back to back for the same watcher. Empty pool yields null.
 */
export function pickWatcherBroadcast(
  seed: number,
  recentHistory: readonly unknown[] = [],
): WatcherBurst | null {
  return pickWalk(WATCHER_BROADCASTS, seed, recentHistory);
}

/**
 * Pick a helper comfort fragment. Returns null unless stability is
 * genuinely low - helpers do not waste kindness on the steady.
 */
export function pickHelperComfort(
  seed: number,
  stability: number,
  recentHistory: readonly unknown[] = [],
): HelperComfort | null {
  if (!(stability < HELPER_COMFORT_LOW_STABILITY)) return null;
  return pickWalk(HELPER_COMFORTS, seed, recentHistory);
}

/**
 * Pick a base phrase and hand it to the garbler. History tracks the
 * SOURCE phrases, so the same plain sentence is not mangled twice in
 * a row even though two garbles never render identically anyway.
 */
export function pickIncompleteGarble(
  seed: number,
  recentSources: readonly unknown[] = [],
): GarbledUtterance | null {
  const source = pickWalk(INCOMPLETE_BASE_PHRASES, seed, recentSources);
  if (source === null) return null;
  return garblePhrase(source, seed ^ 0x5bf03635);
}


