/**
 * Ambient vocalizations for reconstructed human figures.
 *
 * Procedural Web Audio only, no asset files. The Backrooms' people were
 * rebuilt from stolen information and some of that information still
 * leaks out of them:
 *
 *  - Believers mutter. Quiet formant-babble (the same glottal-saw
 *    through parallel bandpass formants trick the beacon radios use)
 *    as if praying to someone who is not there. One burst every
 *    20-40s while the player is within 10m.
 *  - Wanderers hum. A slow fragment of a half-remembered melody:
 *    3-5 sine notes from a minor pentatonic scale, barely a breath.
 *    One phrase every 30-60s while the player is within 12m.
 *  - Watchers say nothing. They have never said anything. Their
 *    silence is the point; do not give them a voice.
 *
 * All voices are gated by distance: gain follows (1 - d/range)^2.5,
 * so each figure is exactly inaudible beyond its own range.
 */

/** Deterministic PRNG so a given voice slot always sounds like itself. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Vowel { readonly f1: number; readonly f2: number; readonly f3: number }
// rough vowel formant targets (Hz): a, e, i, o, u
const VOWELS: readonly Vowel[] = [
  { f1: 800, f2: 1150, f3: 2800 },
  { f1: 450, f2: 1750, f3: 2550 },
  { f1: 300, f2: 2100, f3: 2900 },
  { f1: 420, f2: 800, f3: 2600 },
  { f1: 330, f2: 700, f3: 2400 },
];

/** Minor-pentatonic degrees (semitones) the wanderers hum from. */
const PENTATONIC: readonly number[] = [0, 3, 5, 7, 10];

export const BELIEVER_RANGE = 10;   // audible radius for muttering (m)
export const MUTTER_MIN_GAP = 20;   // s between mutter bursts (in-range time)
export const MUTTER_MAX_GAP = 40;
export const WANDERER_RANGE = 12;   // audible radius for humming (m)
export const HUM_MIN_GAP = 30;      // s between hum phrases (in-range time)
export const HUM_MAX_GAP = 60;

/** How many simultaneous voices we budget per archetype. */
const VOICES_PER_TYPE = 2;

/** One live figure as reported by HumanManager.proximity each frame. */
export interface VocalFigure {
  type: string;
  /** straight-line distance to the player in metres */
  dist: number;
}

/** Shared distance-gated output strip for one voice slot. */
function makeVoiceOut(ctx: AudioContext, destination: AudioNode, rnd: () => number): { distGain: GainNode; pan: StereoPannerNode } {
  const distGain = ctx.createGain();
  distGain.gain.value = 0;
  const pan = ctx.createStereoPanner();
  pan.pan.value = rnd() * 1.0 - 0.5;
  distGain.connect(pan).connect(destination);
  return { distGain, pan };
}

/**
 * Distance loudness curve: full at the figure's feet, zero at (and
 * beyond) its range, falling off so voices melt away rather than cut.
 */
function distanceScale(dist: number, range: number): number {
  if (dist >= range) return 0;
  const prox = 1 - dist / range;
  return prox * prox * Math.sqrt(prox); // prox^2.5
}

// ---------------------------------------------------------------------
// Believer muttering - formant babble, as if praying to nobody.
// ---------------------------------------------------------------------

export class MutterVoice {
  // ---- graph (public for tests) ----
  osc: OscillatorNode | null = null;
  vibrato: OscillatorNode | null = null;
  voiceEnv: GainNode | null = null;
  formants: BiquadFilterNode[] = [];
  distGain: GainNode | null = null;

  // ---- identity ----
  private readonly ctx: AudioContext;
  private rnd: () => number;
  private baseFreq: number;
  private formantScale: number;
  private rate: number;

  // ---- runtime state ----
  private busyRemaining = 0;   // seconds left in the current burst (dt domain)
  private nextIn: number;      // seconds until the next burst may fire
  private lastDist = Infinity;
  stopped = false;

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    seed: number,
  ) {
    this.ctx = ctx;
    this.rnd = mulberry32(seed);
    this.baseFreq = 82 + this.rnd() * 58;          // 82-140 Hz: different mouths
    this.formantScale = 0.88 + this.rnd() * 0.26;  // vocal tract length
    this.rate = 0.85 + this.rnd() * 0.45;          // hurried .. drawling
    this.nextIn = MUTTER_MIN_GAP + this.rnd() * (MUTTER_MAX_GAP - MUTTER_MIN_GAP);

    const out = makeVoiceOut(ctx, destination, this.rnd);


