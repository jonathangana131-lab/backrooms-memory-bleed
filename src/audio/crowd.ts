/**
 * Distant crowd ambience for BACKROOMS: MEMORY BLEED.
 *
 * Fully procedural, no assets. Where RadioChatter renders ONE speaker,
 * CrowdAmbience stacks MANY of the same formant-babble voices — quieter,
 * slower, detuned from each other and stereo-spread — until individual
 * words dissolve into that indistinct office-murmur wash:
 *
 *   VOICES   9 glottal sawtooth sources, each through three parallel
 *            bandpass formant filters drifting between vowel targets
 *            (same technique as radio.ts, borrowed and blurred).
 *   CADENCE  syllables stretch to ~180-320 ms with long phrase gaps —
 *            nobody enunciates across a room; peaks sit near the noise
 *            floor so nothing ever resolves into language.
 *   SPACE    every voice gets its own pan position; a shared lowpass
 *            (~750 Hz) pushes the whole crowd behind a wall, plus a
 *            faint bandpassed air/shuffle bed underneath.
 *   SWELL    a 20-40 s sine LFO breathes the murmur bus volume, so the
 *            room surges and settles like real background chatter.
 *
 * Audible ONLY in the OPEN_OFFICE district (district 1) while director
 * tension reads calm/build; the crowd fades out as tension climbs and
 * everywhere else stays silent.
 */

/** Deterministic PRNG (same construction as radio.ts). */
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

/** District index that hosts the crowd (src/world/constants.ts). */
export const OPEN_OFFICE_DISTRICT = 1;

const VOICE_COUNT = 9;     // overlapping babblers
const MASTER = 0.55;       // overall ceiling — distant, never forward
const AIR_LEVEL = 0.018;   // room-air/shuffle bed under the voices

// tension gate: full below CALM_FULL, silent from CALM_END up
const CALM_FULL = 0.35;
const CALM_END = 0.6;

/** One babbler in the crowd. */
interface Voice {
  readonly osc: OscillatorNode;
  readonly pan: StereoPannerNode;
  readonly env: GainNode;
  readonly formants: BiquadFilterNode[];
  readonly rnd: () => number;
  /** Speech-rate multiplier; < 1 = slower than radio chatter. */
  readonly rate: number;
  /** Vocal-tract length bias applied to formant targets. */
  readonly scale: number;
  /** Audio-clock cursor for lookahead scheduling. */
  nextAt: number;
}

export class CrowdAmbience {
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;

  // ---- graph (public for tests) ----
  out: GainNode | null = null;        // master gate (fade in/out)
  swell: GainNode | null = null;      // density-wave stage the LFO breathes
  lowpass: BiquadFilterNode | null = null;  // the "behind a wall" tilt
  lfo: OscillatorNode | null = null;  // slow swell source
  private readonly voices: Voice[] = [];
  private noiseSrc: AudioBufferSourceNode | null = null;
  private built = false;

  /** Current eased loudness 0..1 (before MASTER). */
  private level = 0;
  stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /**
   * Per-frame tick.
   * @param dt       seconds since the previous frame
   * @param district current district index; only OPEN_OFFICE (1) is inhabited
   * @param tension  director tension 0..1; the crowd thins out as it rises
   */
  update(dt: number, district: number, tension = 0): void {
    if (this.stopped) return;
    if (!this.built) this.build();
    const t = this.ctx.currentTime;

    const target = district === OPEN_OFFICE_DISTRICT ? this.tensionGate(tension) : 0;
    this.level += (target - this.level) * Math.min(1, dt * 1.6);
    if (Math.abs(target - this.level) < 0.001) this.level = target; // settle fully
    this.out!.gain.setTargetAtTime(this.level * MASTER, t, 0.4);

    if (this.level > 0.002) {
      for (const v of this.voices) this.scheduleVoice(v, t);
    } else {
      // keep cursors pinned just ahead of now while the room is empty
      for (const v of this.voices) v.nextAt = Math.max(v.nextAt, t + 0.1);
    }
  }

  /** Silence everything and release nodes; the instance will not restart. */
  stop(): void {


