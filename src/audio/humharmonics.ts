/**
 * Fluorescent hum harmonic enrichment for BACKROOMS: MEMORY BLEED.
 *
 * Sits alongside AudioEngine's raw 120 Hz bed and makes the lights feel
 * like real electrics instead of clean test tones. Fully procedural,
 * no assets:
 *
 *   HARMONICS   subtle odd-harmonic series under the hum: 180 / 300 /
 *               420 Hz (the 3rd/5th/7th of the 60 Hz mains fundamental)
 *               at -12 / -18 / -24 dB relative — the signature "old
 *               ballast" colouration of cheap fluorescent iron.
 *   BEATS       with two or more fixtures audible, a near-identical twin
 *               voice detuned 0.5-2 Hz sums against the first, producing
 *               the slow wah-wah-wah amplitude beat of two fittings that
 *               were never quite the same.
 *   AGE WARBLE  old fixtures drift: a very slow LFO wobbles the
 *               fundamental up to +/-0.5%. How much depends on the
 *               district profile (pristine office wing vs. dying deep
 *               levels).
 *
 * Levels stay deliberately low: this layer colours the existing hum, it
 * never replaces it.
 */

/** Mains fundamental the harmonic series hangs off. */
export const HUM_FUNDAMENTAL = 60;

/** Absolute linear level of the fundamental partial at full fixture count. */
export const HUM_REF_LEVEL = 0.04;

/** Odd harmonics as multiples of the fundamental, with relative levels in dB. */
export const ODD_HARMONICS = [
  { multiple: 3, db: -12 }, // 180 Hz
  { multiple: 5, db: -18 }, // 300 Hz
  { multiple: 7, db: -24 }, // 420 Hz
] as const;

/** Amplitude ratio for a level given in dB. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);


