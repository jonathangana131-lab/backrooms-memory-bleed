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
 *
 * Determinism: graph-build rolls (swell rate, initial voice cursors) draw
 * from a mulberry32 stream seeded by the optional constructor seed XOR a
 * site salt; per-voice streams are seeded per index. Math.random appears
 * ONLY inside the air-bed noise-buffer fill.
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

/** Default seed for the build stream when none is injected. */
const DEFAULT_SEED = 0x3e06d1;
/** Site salt separating the build stream from other consumers of a seed. */
const BUILD_SALT = 0x25d7;

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
  private lfoDepth: GainNode | null = null; // LFO level into the swell param
  private readonly voices: Voice[] = [];
  private noiseSrc: AudioBufferSourceNode | null = null;
  private built = false;

  /** Current eased loudness 0..1 (before MASTER). */
  private level = 0;
  /** Deterministic stream for graph-build rolls (swell rate, cursors). */
  private readonly buildRng: () => number;
  stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode, seed = DEFAULT_SEED) {
    this.ctx = ctx;
    this.destination = destination;
    this.buildRng = mulberry32(((seed >>> 0 || DEFAULT_SEED) ^ BUILD_SALT) >>> 0);
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
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    if (this.out) this.out.gain.setTargetAtTime(0, t, 0.15);
    for (const v of this.voices) {
      try { v.osc.stop(); } catch { /* already stopped */ }
    }
    if (this.lfo) { try { this.lfo.stop(); } catch { /* already stopped */ } }
    if (this.noiseSrc) { try { this.noiseSrc.stop(); } catch { /* already stopped */ } }
  }

  // ---------------------------------------------------------------------------
  // Lazy graph construction
  // ---------------------------------------------------------------------------

  private build(): void {
    const ctx = this.ctx;
    this.built = true;

    // master gate -> destination
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.destination);

    // "behind a wall" tilt shared by every voice and the air bed
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 750;
    this.lowpass.Q.value = 0.4;
    this.lowpass.connect(this.out);

    // density-wave stage the LFO breathes
    this.swell = ctx.createGain();
    this.swell.gain.value = 0.8;
    this.swell.connect(this.lowpass);

    // slow swell LFO: 20-40 s period, breathing the swell bus through a
    // small depth stage so the wave stays a gentle density modulation
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 1 / (20 + this.buildRng() * 20); // 0.025-0.05 Hz
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0.22;
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.swell.gain);
    this.lfo.start();

    // faint bandpassed air/shuffle bed underneath the voices
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = this.noiseBuffer();
    this.noiseSrc.loop = true;
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.value = 420; // sits inside the vowel band, reads as room
    airFilter.Q.value = 0.6;
    const airGain = ctx.createGain();
    airGain.gain.value = AIR_LEVEL;
    this.noiseSrc.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(this.lowpass);
    this.noiseSrc.start();

    // the babblers themselves
    for (let i = 0; i < VOICE_COUNT; i++) this.voices.push(this.buildVoice(i));
    // park cursors just ahead so the first audible frame speaks immediately
    const t = ctx.currentTime;
    for (const v of this.voices) v.nextAt = t + 0.05 + this.buildRng() * 0.3;
  }

  /** One glottal sawtooth through three parallel formants into a panned env. */
  private buildVoice(index: number): Voice {
    const ctx = this.ctx;
    const rnd = mulberry32(0xc40d ^ (index * 0x9e37 + 1));

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 70 + rnd() * 70; // low glottal source, 70-140 Hz

    // three parallel bandpass formant filters (vowel targets)
    const formants: BiquadFilterNode[] = [];
    for (let f = 0; f < 3; f++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      const vowel = VOWELS[Math.floor(rnd() * VOWELS.length)];
      bp.frequency.value = [vowel.f1, vowel.f2, vowel.f3][f];
      bp.Q.value = 6 + rnd() * 5;
      formants.push(bp);
    }

    const env = ctx.createGain();   // syllable envelope (automated in update)
    env.gain.value = 0;

    const panner = ctx.createStereoPanner();
    panner.pan.value = (rnd() * 1.6 - 0.8); // stereo spread

    for (const bp of formants) { osc.connect(bp); bp.connect(env); }
    env.connect(panner);
    panner.connect(this.swell!);
    osc.start();

    return {
      osc,
      pan: panner,
      env,
      formants,
      rnd,
      rate: 0.55 + rnd() * 0.5,   // slower than radio chatter
      scale: 0.85 + rnd() * 0.3,  // vocal-tract variety
      nextAt: 0,
    };
  }

  /** Shared two-second white-noise buffer for the air bed. */
  private noiseBuffer(): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    // audio DSP buffer fill — sim PRNG law carve-out
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /**
   * Lookahead syllable scheduling for one voice: short quiet envelopes with
   * long phrase gaps, plus occasional formant drift between vowel targets.
   * Called only while the room is audible.
   */
  private scheduleVoice(v: Voice, now: number): void {
    if (v.nextAt < now - 0.5) v.nextAt = now; // resync after long silence
    const horizon = now + 0.35;
    while (v.nextAt < horizon) {
      const syl = (0.18 + v.rnd() * 0.14) / v.rate;   // ~180-320 ms cadence
      const peak = 0.02 + v.rnd() * 0.04;             // peaks near the noise floor
      v.env.gain.setTargetAtTime(peak, v.nextAt, 0.03);
      v.env.gain.setTargetAtTime(0.0001, v.nextAt + syl, 0.07);

      // drift one formant toward a new vowel target now and then
      if (v.rnd() < 0.6) {
        const which = Math.floor(v.rnd() * 3);
        const target = VOWELS[Math.floor(v.rnd() * VOWELS.length)];
        const hz = [target.f1, target.f2, target.f3][which] * v.scale;
        v.formants[which].frequency.setTargetAtTime(hz, v.nextAt, 0.22);
      }

      // phrase gap: nobody enunciates continuously across a room
      if (v.rnd() < 0.18) v.nextAt += syl + 0.8 + v.rnd() * 1.6;
      else v.nextAt += syl + 0.05 + v.rnd() * 0.12;
    }
  }

  /**
   * Tension gate: full below CALM_FULL, silent from CALM_END up, linear
   * between — calm/build keeps the murmur, escalation empties the room.
   */
  private tensionGate(tension: number): number {
    if (tension <= CALM_FULL) return 1;
    if (tension >= CALM_END) return 0;
    return 1 - (tension - CALM_FULL) / (CALM_END - CALM_FULL);
  }
}
