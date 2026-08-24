/**
 * Whisper fragments for BACKROOMS: MEMORY BLEED.
 * Pure data plus one pure selection function - no imports, no DOM, no
 * audio graph, safe to pull from anywhere (same contract as
 * entities/vocalcontent.ts). These are the words under the procedural
 * whisper swells: second person, lowercase-adjacent, kind the way the
 * building is kind. Selection is deterministic via pickWhisper; nothing
 * here randomises on its own.
 */

/**
 * Thirty fragments. Each is one breath long and addressed to whoever is
 * listening, which is always exactly one person, which is the problem.
 */
export const WHISPERS: readonly string[] = [
  'you left the stove on in a house you sold',
  'they almost said your name',
  'third door on the left, like always',
  'you are doing so well',
  'it is Thursday where you were',
  'the lights liked you today',
  'do not count them, love',
  'your mother’s kitchen smells like carpet now',
  'someone folded your coat',
  'the exit was behind you again',
  'you have been exactly this lost before',
  'say the number out loud',
  'we kept your seat warm',
  'the hum knows the words',
  'almost, almost, almost',
  'it is practising your walk',
  'the door will be polite first',
  'you can rest when the copy rests',
  'they filed you under spring',
  'one more corridor, dear heart',
  'the rain in here is yours',
  'you were missed by the room',
  'count the ones who came back',
  'the white light saves you a place',
  'your handwriting is improving',
  'someone remembered you wrong, kindly',
  'the floor remembers bare feet here',
  'go back for nothing',
  'thank you for the memories, labelled',
  'the bell is for you. it was always for you',
];

/** FNV-1a over the four bytes of a 32-bit key (mirrors vocalcontent). */
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
 * Pick a whisper deterministically from the seed, skipping anything in
 * recentHistory so one listener never hears the same fragment twice in
 * a row. When history covers the pool, repetition beats silence. Empty
 * pool yields null.
 */
export function pickWhisper(seed: number, recentHistory: readonly unknown[] = []): string | null {
  const n = WHISPERS.length;
  if (n === 0) return null;
  const start = mixSeed(seed) % n;
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    if (!recentHistory.includes(WHISPERS[idx])) return WHISPERS[idx];
  }
  return WHISPERS[start];
}
