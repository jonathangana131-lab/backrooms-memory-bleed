/**
 * Relocation echoes for BACKROOMS: MEMORY BLEED.
 *
 * Wherever the player relocates (teleports, phase-shifts), the place remembers.
 * Feed each departure point in via markSite; afterwards, walking back within 15 m
 * of one plays faint audio memories:
 *
 *   FRAGMENTS  bandpass-filtered noise bursts with a REVERSE envelope - the
 *              amplitude swells across the whole burst then cuts dead, like tape
 *              rewound. Two parallel formant bands (vowel table borrowed from
 *              radio.ts) make the noise read as a whisper, not static.
 *   ESCALATION the site counts visits (enter/leave with hysteresis):
 *                1st visit  -> one lone fragment, long gaps
 *                2nd visit  -> two overlapping fragments, shorter gaps
 *                3rd visit+ -> continuous murmuring bed under the bursts
 *   TIE-IN     getIntensity(x, z) exposes 0..1 proximity x escalation so the
 *              renderer can bleed a matching screen effect.
 *
 * Every site hashes its world position to a seed (same trick as radio.ts) so its
 * pan, filter colour and pacing are stable: the same corner always whispers the
 * same way.
 *
 * Fully procedural: white-noise buffers through biquads, no asset files.
 * The AudioContext is optional at construction; without one the class runs
 * logic-only (proximity, visit counting, getIntensity) and stays silent - which
 * is also how the headless test exercises it.
 */

/** Deterministic PRNG so a site always sounds like itself (cf. radio.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Position hash -> 32-bit seed (FNV-1a over both float bit patterns). */


export function positionSeed(x: number, z: number): number {
  const xf = new Float64Array(1); xf[0] = x;
  const zf = new Float64Array(1); zf[0] = z;
  const bytes = new Uint8Array(xf.buffer.byteLength * 2);
  bytes.set(new Uint8Array(xf.buffer), 0);
  bytes.set(new Uint8Array(zf.buffer), 8);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Rough vowel formant targets (Hz), reused for whisper colouring. */
const VOWELS: readonly { f1: number; f2: number }[] = [
  { f1: 800, f2: 1150 },
  { f1: 450, f2: 1750 },
  { f1: 300, f2: 2100 },
  { f1: 420, f2: 800 },
];

const ENTER_RADIUS = 15; // metres: inside this, the site wakes
const EXIT_RADIUS = 22;  // metres: must leave this far before the next visit counts
const MIN_SPACING = 10;  // metres: ignore marks this close to an existing site

/** Escalation weight per visit tier: how insistent the memory is. */
function escalation(visits: number): number {
  if (visits <= 0) return 0;
  if (visits === 1) return 0.35;
  if (visits === 2) return 0.65;
  return 1;
}

interface EchoSite {
  x: number;
  z: number;
  /** Re-entry count: how many times the player came back after leaving. */
  visits: number;
  /** True while far enough away that the next entry counts as a revisit. */
  armed: boolean;
  /** True while currently within ENTER_RADIUS. */
  inside: boolean;
  /** Local-clock time of the next scheduled fragment burst. */
  nextBurstAt: number;
  seed: number;
  rnd: () => number;
  /** Per-site persistent murmur voice, built lazily (tier 3+ only). */
  murmur: MurmurVoice | null;
}

/**
 * Structural minimum of a tier-3 murmur voice: a small formant bed bound
 * to one echo site, eased per frame toward a target level. Implementations
 * degrade silently; the site treats null as "voice not built yet".
 */
interface MurmurVoice {
  /** Per-frame level/position update. */
  update(dt: number, level: number): void;
  /** Release all nodes; the instance never restarts. */
  stop(): void;
}


