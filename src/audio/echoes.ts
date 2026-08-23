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


