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

(Showing lines 1-40 of 238. Use offset=41 to continue.)

}

/** Maximum pitch instability of a fully-aged fixture (+/-0.5%). */
export const MAX_WARBLE = 0.005;

/** Allowed beat window between the two fixture voices, in Hz. */
export const BEAT_MIN = 0.5;
export const BEAT_MAX = 2.0;

/** How loud the twin (beating) voice sits against the lead voice. */
const BEAT_MIX = 0.55;

/** Extra harmonic warmth an end-of-life fixture develops (up to +40%). */
const AGE_HARMONIC_BOOST = 0.4;

/** Smoothing time constant for level moves (seconds). */
const LEVEL_TAU = 0.25;

/** Per-district fixture character. age drives warble + harmonic dirt. */
interface DistrictProfile {
  /** 0 = freshly installed .. 1 = end of life. */
  age: number;
  /** Overall loudness trim for the district's wiring. */
  level: number;
}

const DISTRICT_PROFILES: Record<number, DistrictProfile> = {
  0: { age: 0.12, level: 1.0 },  // pristine entry offices
  1: { age: 0.42, level: 0.94 },
  2: { age: 0.68, level: 0.88 },
  3: { age: 0.93, level: 0.8 },  // deep, dying levels
};

const DEFAULT_PROFILE: DistrictProfile = { age: 0.5, level: 0.95 };

/** One fixture voice: fundamental + odd harmonics summed into a root gain. */
interface Voice {
  root: GainNode;
  /** One oscillator per partial; index 0 is the fundamental. */
  oscs: OscillatorNode[];
  /** Matching per-partial gains (relative weights; root carries level). */
  gains: GainNode[];
}

export class HumHarmonics {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;

  private readonly voiceA: Voice;
  private readonly voiceB: Voice;

  /** Shared slow LFO wobbling both fundamentals (fixture-age warble). */
  private readonly warble: OscillatorNode;
  private readonly warbleDepth: GainNode;

  private fixtureCount = 0;
  private district = -1;

  /** Current beat offset between the voices (Hz difference of fundamentals). */
  private beatDelta = BEAT_MIN + Math.random() * (BEAT_MAX - BEAT_MIN);

  /** Seconds until the beat drifts to a new offset (fixtures never agree). */
  private driftIn = 10 + Math.random() * 10;

  private stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(destination);

    this.voiceA = this.buildVoice(1);
    this.voiceB = this.buildVoice(1 + this.beatDelta / HUM_FUNDAMENTAL);

    // Slow shared warble: one wobble generator feeding both fundamentals,
    // because fixtures on the same circuit sag together.
    this.warble = ctx.createOscillator();
    this.warble.type = 'sine';
    this.warble.frequency.value = 0.07 + Math.random() * 0.06; // 0.07-0.13 Hz

(Showing lines 1-120 of 238. Use offset=121 to continue.)

