/**
 * Structure groans for BACKROOMS: MEMORY BLEED.
 *
 * The Backrooms itself groans and settles. Fully procedural, no assets:
 *
 *   SETTLEMENT  a deep 40-80 Hz sawtooth through a heavy lowpass with a
 *               slow 0.5 s attack and a 2-4 s decay — a massive building
 *               shifting its weight somewhere in the dark.
 *   PIPE KNOCKS a metallic bang (resonant bandpassed noise burst) that
 *   TRAVEL      echoes down the plumbing: knock, ~0.5 s gap, then a
 *               fainter, duller knock further away, as if the pressure
 *               wave is moving off through the pipes.
 *   SCHEDULER   an event every 90-180 s of calm, stretched further as
 *               director tension rises — loud groans would be lost under
 *               tense soundscapes anyway, so they thin out instead.
 *   PLACEMENT   each event gets a seeded compass bearing and distance;
 *               stereo pan follows the bearing, an inverse-square
 *               falloff keeps distant structures barely breathing.
 *
 * All pacing and per-event rolls come from one seeded RNG stream
 * (`(seed ^ GROANS_SALT) >>> 0`, src/core/rng.ts); only the sample-data
 * buffer fill keeps Math.random under the DSP carve-out.
 */

import { RNG } from '../core/rng';

const TWO_PI = Math.PI * 2;

/** Stream salt so groan pacing never correlates with other seeded systems. */
const GROANS_SALT = 0x67726f31;
/** Default stream seed used when no run seed reaches the constructor. */
const DEFAULT_GROANS_SEED = 0x1c40a417;

/** Inverse-square distance attenuation, unity at 5 m and closer. */
function rolloff(dist: number): number {
  const REF = 5;
  if (!(dist >= REF)) return 1;
  const r = REF / dist;
  return r * r;
}

/** Stereo pan for a bearing: forward 0, right +1, behind 0, left -1. */
function panFor(bearing: number): number {
  return Math.max(-1, Math.min(1, Math.sin(bearing)));
}

interface Placement {
  bearing: number;
  dist: number;
}

export class StructureGroans {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  /** Seeded stream driving every pacing/jitter roll (determinism law). */
  private readonly rng: RNG;

  /** Seconds until the next structural event. */
  private nextIn = 0;
  private stopped = false;

  /** Shared white-noise buffer for pipe knocks, built lazily. */
  private noiseBuf: AudioBuffer | null = null;
  /** Voices still sounding, so stop() can silence them immediately. */
  private readonly live = new Set<AudioScheduledSourceNode>();

  constructor(ctx: AudioContext, destination: AudioNode, seed = DEFAULT_GROANS_SEED) {
    this.ctx = ctx;
    this.out = destination;
    this.rng = new RNG((seed ^ GROANS_SALT) >>> 0);
    this.nextIn = this.rng.range(30, 70);
  }

  /**
   * Per-frame tick.
   * @param dt      seconds since the previous frame
   * @param tension director tension 0..1; higher tension stretches the
   *                gap between ambient groans (they'd be lost anyway)
   */
  update(dt: number, tension = 0): void {
    if (this.stopped) return;
    // The countdown runs on "calm time": tension dilates it, so tense
    // stretches produce proportionally fewer ambient groans.
    this.nextIn -= dt / (1 + 2 * tension);
    if (this.nextIn > 0) return;
    this.nextIn = this.rng.range(90, 180); // calm pacing: 90-180 s
    if (this.rng.chance(0.5)) this.settlementGroan();
    else this.pipeKnocks();
  }

  /** Silence everything scheduled/sounding and halt the scheduler. */
  stop(): void {
    this.stopped = true;
    for (const src of this.live) {
      try { src.stop(); } catch { /* already ended */ }
    }
    this.live.clear();
  }

  /** Seeded spot for an event: any bearing, 12-48 m out. */
  private place(): Placement {
    return { bearing: this.rng.range(0, TWO_PI), dist: this.rng.range(12, 48) };
  }

  /** Register a voice so stop() can cut it short. */
  private track(src: AudioScheduledSourceNode, until: number): void {
    this.live.add(src);
    src.onended = () => this.live.delete(src);
    src.stop(until);
  }

  /**
   * One settlement: the building shifts its weight.
   * Sawtooth 40-80 Hz, lowpass, 0.5 s attack into a 2-4 s decay.
   */
  private settlementGroan(): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const { bearing, dist } = this.place();

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = this.rng.range(40, 80);
    // A slight downward slump reads as mass settling rather than humming.
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f0 * (0.82 + this.rng.range(0, 0.1)), t0 + 4.5);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = this.rng.range(90, 250);
    lp.Q.value = 0.7;

    const g = ctx.createGain();
    const peak = 0.11 * rolloff(dist);
    const decay = this.rng.range(2, 4); // 2-4 s
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.5); // slow attack
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5 + decay);

    const p = ctx.createStereoPanner();
    p.pan.value = panFor(bearing);

    o.connect(lp).connect(g).connect(p).connect(this.out);
    o.start(t0);
    this.track(o, t0 + 0.55 + decay);
  }

  /** A bang travelling through the pipes: knock now, fainter one ~0.5 s later. */
  private pipeKnocks(): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const first = this.place();
    // One shared resonance: it is the same wave moving down the pipe.
    const baseFreq = this.rng.range(700, 2200);
    this.knock(t0, first.bearing, first.dist, baseFreq);

    // The pressure wave moves off: further away, duller, drifting pan.
    const dist2 = first.dist + this.rng.range(10, 30);
    const bearing2 = first.bearing + this.rng.range(-0.25, 0.25);
    this.knock(t0 + this.rng.range(0.5, 0.65), bearing2, dist2, baseFreq);
  }

  /** One metallic bang: resonant bandpassed noise burst, fast decay. */
  private knock(at: number, bearing: number, dist: number, baseFreq: number): void {
    const ctx = this.ctx;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();

    // High-Q bandpass rings like sheet metal; further knocks ring lower.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = baseFreq * (0.6 + 0.4 * rolloff(dist));
    bp.Q.value = 9;

    const g = ctx.createGain();
    const peak = 0.09 * rolloff(dist);
    const dur = this.rng.range(0.09, 0.18);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    const p = ctx.createStereoPanner();
    p.pan.value = panFor(bearing);

    src.connect(bp).connect(g).connect(p).connect(this.out);
    src.start(at);
    this.track(src, at + dur + 0.05);
  }

  /** Lazily build (and cache) a quarter-second of white noise. */
  private noiseBuffer(): AudioBuffer {
    if (!this.noiseBuf) {
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * 0.25));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      // audio DSP buffer fill (white noise source) — sim PRNG law carve-out
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }
}


