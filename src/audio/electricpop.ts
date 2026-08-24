/**
 * Electric pops for BACKROOMS: MEMORY BLEED.
 *
 * The fluorescent grid is old. Every so often a tube or ballast lets go
 * somewhere nearby: a single sharp snap, or -- worse -- a stuttering
 * flicker cluster of several rapid ticks with a faint buzz tail, like the
 * whole fixture deciding whether to keep living.
 *
 *   POP      one highpassed noise click, ~40 ms, band energy around
 *            2-6 kHz so it reads as arcing metal, not a footstep.
 *   FLICKER  3-7 ticks at ~70-110 ms spacing plus a low sputter buzz;
 *            the cluster always ends on its loudest tick, then dies.
 *   TIMING   Poisson-ish cadence (4-14 s) drawn from the deterministic
 *            core RNG stream; tension has no input here -- the wiring
 *            fails whether or not anything is hunting you.
 *
 * Fully procedural Web Audio following doors.ts conventions: lazy graph
 * build, per-voice try/catch islands logging '[bmb] ...', update() never
 * throws.
 */

import { RNG } from '../core/rng';

/** Seconds between electrical events (RNG-drawn). */
const EVENT_MIN_S = 4;
const EVENT_MAX_S = 14;

/** Peak click gain: present but never startle-loud. */
const POP_PEAK = 0.09;

export class ElectricPops {
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;

  private built = false;
  private stopped = false;

  /** Shared two-second white-noise source material. */
  private noiseBuf: AudioBuffer | null = null;
  /** Countdown to the next event, seconds. */
  private nextEventIn = 3;
  /** Deterministic stream for event timing and flicker shape. */
  private readonly rng = new RNG(0xe13c701);

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /**
   * Per-frame tick.
   * @param dt seconds since the previous frame
   */
  update(dt: number): void {
    if (this.stopped || dt <= 0) return;
    try {
      if (!this.built) this.build();

      this.nextEventIn -= dt;
      if (this.nextEventIn > 0) return;
      this.nextEventIn = this.rng.range(EVENT_MIN_S, EVENT_MAX_S);

      if (this.rng.chance(0.35)) this.pop(this.ctx.currentTime + 0.02);
      else this.flicker(this.ctx.currentTime + 0.02);
    } catch (e) {
      console.warn('[bmb] electric pops failed', e);
    }
  }

  /** Silence everything; the instance will not restart. */
  stop(): void {
    this.stopped = true;
  }

  // ---------------------------------------------------------------------------

  private build(): void {
    this.built = true;
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1; // DSP fill exempt from sim PRNG law
    this.noiseBuf = buf;
  }

  /** One sharp snap: noise click through a 2-6 kHz bandpass. */
  private pop(at: number): void {
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400 + this.rng.next() * 3200;
      bp.Q.value = 1.4;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(POP_PEAK, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);

      src.connect(bp).connect(g).connect(this.destination);
      src.start(at);
      src.stop(at + 0.06);
    } catch (e) {
      console.warn('[bmb] electric pop failed', e);
    }
  }

  /**
   * One flicker cluster: 3-7 quick ticks building to the loudest last,
   * then a faint sputter buzz dying under the floor noise.
   */
  private flicker(at: number): void {
    try {
      const count = 3 + this.rng.int(0, 5);
      let t = at;
      for (let i = 0; i < count; i++) {
        const last = i === count - 1;
        const peak = (last ? 1 : 0.25 + this.rng.next() * 0.45) * POP_PEAK;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        src.loop = true;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2600 + this.rng.next() * 2800;
        bp.Q.value = 2;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(peak, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
        src.connect(bp).connect(g).connect(this.destination);
        src.start(t);
        src.stop(t + 0.05);
        t += 0.07 + this.rng.next() * 0.04;
      }

      // sputter tail: quiet buzz that gives up almost immediately
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 3;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.012, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      src.connect(bp).connect(g).connect(this.destination);
      src.start(t);
      src.stop(t + 0.55);
    } catch (e) {
      console.warn('[bmb] electric flicker failed', e);
    }
  }
}
