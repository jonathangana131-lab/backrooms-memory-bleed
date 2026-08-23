/**
 * Vocalization content pools for reconstructed human figures.
 *
 * The procedural voices in vocals.ts and audio/radio.ts produce cadence
 * without words - glottal saws through formant filters, sine-note hums,
 * carrier hiss. This module is the words they would be saying if any
 * of it were still language. It exists so a future pass can drive the
 * existing synthesis from real fragments (subtitles, emphasis on
 * particular syllables, lore cross-checks) without re-authoring tone.
 *
 * Tone contract (matches CLUSTER_STORIES in world/architect.ts):
 *  - quiet dread, never gore; bureaucratic and domestic registers
 *    colliding; denial stated plainly, then repeated; proper nouns
 *    doing the emotional work.
 *
 * Everything here is data plus one pure selection function. No DOM,
 * no audio graph, no imports - safe to pull from anywhere.
 */

// ---------------------------------------------------------------------
// Believer mutterings - prayers and denials aimed at nobody.
// ---------------------------------------------------------------------

/** One short spoken fragment a believer mutters between prayers. */
export interface BelieverMuttering {
  /** What the mouth says, ellipses marking the words that won't come. */
  readonly text: string;
  /** Spoken-syllable count, kept honest so bursts fit the 20-40s cadence. */
  readonly syllables: number;
}

/**
 * Twenty mutterings: prayers that lose their place, denials of the
 * room the speaker is standing in, observations nobody asked for.
 * Each is 3-8 syllables - one burst of babble can carry one of these.
 */
export const BELIEVER_MUTTERINGS: readonly BelieverMuttering[] = [
  { text: "it's not... it isn't... no", syllables: 6 },
  { text: 'hallowed be the... the...', syllables: 5 },
  { text: 'I have a wife. I DO.', syllables: 6 },
  { text: 'our father who... who art...', syllables: 6 },
  { text: 'deliver us... deliver me', syllables: 8 },
  { text: 'the lights know my name', syllables: 5 },
  { text: 'I counted the doors today', syllables: 7 },
  { text: 'not real. none of this is real.', syllables: 7 },
  { text: 'forgive me. forgive me.', syllables: 6 },
  { text: "mom? ... no. No, she's gone.", syllables: 5 },
  { text: 'the hum is just the wiring', syllables: 7 },
  { text: 'I will go home on Thursday', syllables: 7 },
  { text: 'amen... amen... amen', syllables: 6 },
  { text: 'there was a door here yesterday', syllables: 8 },
  { text: 'blessed are the forgotten', syllables: 7 },
  { text: 'my name is... my name is...', syllables: 6 },
  { text: "don't look at the ceiling", syllables: 6 },
  { text: 'she waits where the walls meet', syllables: 6 },
  { text: 'I am still here. I am.', syllables: 6 },
  { text: 'it remembers me wrong', syllables: 6 },
];

// ---------------------------------------------------------------------
// Wanderer hum fragments - half-remembered melodies.
// ---------------------------------------------------------------------

/** One note of a hum phrase: scale degree plus its length in beats. */
export interface HumNote {
  /**
   * Semitone offset inside the minor pentatonic (0, 3, 5, 7, 10),
   * matching the PENTATONIC table the HumVoice synthesizer plays from.
   */
  readonly degree: number;
  /** Note duration in beats at the wanderer's slow internal tempo. */
  readonly beats: number;
}

/** A hummable fragment: 3-5 notes, mostly stepwise, never resolving. */
export interface WandererHum {
  readonly notes: readonly HumNote[];
}

/** The only degrees a wanderer can hum (minor pentatonic, semitones). */
export const HUM_SCALE_DEGREES: readonly number[] = [0, 3, 5, 7, 10];

/**
 * Eight fragments. None ends on the tonic except by accident; a hum
 * that resolves would sound like comfort, and there is none here.
 */
export const WANDERER_HUMS: readonly WandererHum[] = [
  { notes: [{ degree: 0, beats: 1 }, { degree: 3, beats: 0.5 }, { degree: 5, beats: 1.5 }] },
  { notes: [{ degree: 5, beats: 0.75 }, { degree: 3, beats: 0.75 }, { degree: 0, beats: 2 }] },
  { notes: [{ degree: 10, beats: 1 }, { degree: 7, beats: 1 }, { degree: 5, beats: 0.5 }, { degree: 3, beats: 1 }] },
  { notes: [{ degree: 3, beats: 0.5 }, { degree: 5, beats: 0.5 }, { degree: 7, beats: 0.5 }, { degree: 5, beats: 0.5 }, { degree: 3, beats: 1.5 }] },
  { notes: [{ degree: 7, beats: 2 }, { degree: 10, beats: 1 }, { degree: 7, beats: 1 }] },
  { notes: [{ degree: 0, beats: 0.75 }, { degree: 3, beats: 0.75 }, { degree: 0, beats: 0.75 }, { degree: 5, beats: 1.25 }] },
  { notes: [{ degree: 5, beats: 1 }, { degree: 7, beats: 0.5 }, { degree: 10, beats: 0.5 }, { degree: 7, beats: 2 }] },
  { notes: [{ degree: 10, beats: 0.5 }, { degree: 7, beats: 0.5 }, { degree: 5, beats: 1 }, { degree: 3, beats: 0.5 }, { degree: 0, beats: 1.5 }] },
];

// ---------------------------------------------------------------------
// Radio broadcast fragments - extends the radiotune LORE_POOL pattern.
// ---------------------------------------------------------------------

/** What kind of signal debris a broadcast fragment carries. */
export type BroadcastTag =
  | 'coordinates'
  | 'timestamp'
  | 'personal'
  | 'warning';

/** One recoverable broadcast snippet heard through beacon static. */
export interface BroadcastFragment {
  /** The words that survive the carrier hiss. */
  readonly text: string;
  /** Rough classification used by lore tooling and tests. */
  readonly tag: BroadcastTag;
}

/**
 * Fifteen additional expedition-log snippets in the exact register of
 * LORE_POOL (src/ui/radiotune.ts): coordinates caught mid-repeat,
 * timestamps that stop being trustworthy, personal mail, warnings
 * about corridors with names.
 */
export const BROADCAST_FRAGMENTS: readonly BroadcastFragment[] = [
  { tag: 'coordinates', text: '...marking grid 51.207 north, 12.988 west. If the numbers read back differently next pass, believe the second reading.' },
  { tag: 'coordinates', text: 'Survey point Kappa is two hundred paces past survey point Kappa. We are flagging both. Do not remove either flag.' },
  { tag: 'coordinates', text: '...descending by compass only. Compass says north. The corridor says otherwise. Corridor is winning.' },
  { tag: 'coordinates', text: 'Datum correction: everything we mapped today sits four meters further away than yesterday. Instruments fine. Distances are not.' },
  { tag: 'timestamp', text: 'Log stamp reads 03:14. My watch agrees. The coffee in my hand is still warm from noon, which was nine hours ago or none.' },
  { tag: 'timestamp', text: 'Station time 19:00 sharp, same as yesterday, same as the day before. The clock is not broken. The day is.' },
  { tag: 'timestamp', text: 'Day 44. Or day 45. Reyes has stopped numbering them; he says the days here are copies and numbering copies is how they get in.' },
  { tag: 'personal', text: 'Personal for Dara: I found your chalk arrow on sublevel two. It points home. I am following it even though you drew it after you left.' },
  { tag: 'personal', text: 'Mom - the vending machine here takes coins from every year I lived at home. I fed it a quarter from 1997 and it gave me back the smell of your kitchen. Do not worry. I ate.' },
  { tag: 'personal', text: 'If anyone relays this to Okafor: your boots washed up at station 12, dry. I did not touch them. They were facing the way you left.' },
  { tag: 'personal', text: 'To the man humming on the east line: I know that song. My sister knew that song. Please keep humming until one of us remembers the ending.' },
  { tag: 'warning', text: 'Warning: corridor C-4 repeats under fluorescent failure. Count your left turns out loud. If you hear yourself counting twice, sit down and wait for the lights.' },
  { tag: 'warning', text: 'Do not shelter in the break room past pillar nine. The fridge hums in rounds now. It has learned more voices since the last bulletin.' },
  { tag: 'warning', text: 'All teams: the stairwell between levels 3 and 3 is NOT a transcription error. There is no level between 3 and 3. Stop using the stairs that are there anyway.' },
  { tag: 'warning', text: 'Advisory: puddles in transit sectors are showing afternoons from other years. Step around them. If you already stepped, dry your foot before it dries you.' },
];

// ---------------------------------------------------------------------
// Selection logic - seeded, no immediate repetition per figure.
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

/**
 * Pick a fragment from a pool, deterministically from the seed, while
 * skipping anything in recentHistory so one figure never repeats
 * itself back to back.
 *
 * The walk starts at seed % pool.length and steps forward; the first
 * entry not present in recentHistory wins. When the history covers
 * the whole pool, the seeded starting entry is returned anyway -
 * repetition beats silence. Empty pool yields null.
 *
 * History membership uses SameValueZero, so callers may track either
 * object references or plain strings.
 */
export function pickFragment<T>(
  pool: readonly T[],
  seed: number,
  recentHistory: readonly unknown[] = [],
): T | null {
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


