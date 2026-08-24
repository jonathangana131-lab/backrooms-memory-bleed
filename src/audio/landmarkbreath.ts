/**
 * Landmark room breathing for BACKROOMS: MEMORY BLEED.
 *
 * Some landmark rooms are ALIVE in the way a house is alive in stories:
 * a slow air-swell that rises and falls like a sleeping chest, plus one
 * ornament per room kind:
 *
 *   ARCHIVE  dry paper rustle riding the breath
 *   MEDICAL  faint monitor beeps on a slow irregular schedule
 *   PLAYROOM  toy chimes, farther apart than they should be
 *
 * hold() makes the room catch its breath — pinned near silence until the
 * pause elapses, then a loud resumed exhale. Fully procedural, no assets.
 *
 * Determinism: the breath phase, cycle period, ornament schedules and the
 * ARCHIVE flutter roll draw from one seeded RNG stream
 * (`(seed ^ BREATH_SALT) >>> 0`, src/core/rng.ts); only the sample-data
 * air-bed buffer fill keeps Math.random under the DSP carve-out.
 */
import { RNG } from '../core/rng';

/** Stream salt so breath rolls never correlate with other seeded systems. */
const BREATH_SALT = 0x0f2b3a17;
/** Default stream seed used when no run seed reaches the constructor. */
const DEFAULT_BREATH_SEED = 0x77b3ea7d;

/** Room kinds that breathe, from the landmark table. */
export type BreathKind = 'ARCHIVE' | 'MEDICAL' | 'PLAYROOM';

export class LandmarkBreath {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Room character driving ornaments. */
  readonly kind: BreathKind;

  /** Resting loudness of the swell. */
  readonly vol: number;

  /** Breath cycle length, seconds (~5-9 s). */
  readonly period: number;

  // ---- graph ----
  private readonly breathGain: GainNode;   // the chest: noise -> lowpass -> gain
  private readonly rustleGain: GainNode;   // ARCHIVE paper layer
  private readonly sources: AudioScheduledSourceNode[] = [];

  // ---- motion state ----
  private phase = 0;
  private boost = 1;              // entrance/resume exhale multiplier
  private holdTimer = -1;         // >=0 while holding its breath
  private nextBeepIn = 0;
  private nextChimeIn = 0;

  stopped = false;

  /** Seeded stream driving phase/period/ornament rolls (determinism law). */
  private readonly rng: RNG;

  constructor(ctx: AudioContext, destination: AudioNode, kind: BreathKind, vol = 0.5, seed = DEFAULT_BREATH_SEED) {
    this.ctx = ctx;
    this.out = destination;
    this.kind = kind;
    this.vol = vol;
    this.rng = new RNG((seed ^ BREATH_SALT) >>> 0);
    this.phase = this.rng.next();
    this.nextBeepIn = 2 + this.rng.next() * 2;
    this.nextChimeIn = 4 + this.rng.next() * 3;
    this.period = 5 + this.rng.next() * 4;

    // chest: filtered noise swelling through breathGain
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // audio DSP buffer fill (air-bed noise source) — sim PRNG law carve-out
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    src.connect(lp);
    lp.connect(this.breathGain);
    this.breathGain.connect(destination);
    src.start();
    this.sources.push(src);

    // ARCHIVE paper layer: bandpassed hiss riding the same swell
    const rsrc = ctx.createBufferSource();
    rsrc.buffer = buf;
    rsrc.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.8;
    this.rustleGain = ctx.createGain();
    this.rustleGain.gain.value = 0;
    rsrc.connect(bp);
    bp.connect(this.rustleGain);
    this.rustleGain.connect(destination);
    rsrc.start();
    this.sources.push(rsrc);
  }

  /**
   * The room catches its breath.
   * @param seconds how long to stay pinned near silence
   */
  hold(seconds = 3): void {
    if (this.stopped) return;
    this.holdTimer = seconds;
  }

  /**
   * Per-frame tick.
   * @param dt seconds since the previous frame
   */
  update(dt: number): void {
    if (this.stopped) return;
    dt = Math.min(dt, 0.1); // tab-back spikes shouldn't skip a breath
    const t = this.ctx.currentTime;

    if (this.holdTimer >= 0) {
      // holding its breath: pinned near silence until the pause elapses
      this.holdTimer -= dt;
      this.swell.gain.setTargetAtTime(0.0001, t, 0.08);
      this.rustleGain.gain.setTargetAtTime(0.0001, t, 0.08);
      if (this.holdTimer < 0) this.boost = 2.2; // the resumed exhale is loud
      return;
    }

    // ease the entrance boost back toward resting loudness
    this.boost = Math.max(1, this.boost * Math.exp(-dt / 4));

    // advance the cycle and shape one swell per half (inhale, exhale)
    this.phase = (this.phase + dt / this.period) % 1;
    const half = this.phase < 0.5 ? this.phase * 2 : (1 - this.phase) * 2;
    const env = Math.pow(Math.sin(Math.PI * half), 1.3);
    this.swell.gain.setTargetAtTime(this.vol * this.boost * env, t, 0.16);

    // ARCHIVE rooms get paper rustle riding the breath with a dry flutter
    if (this.kind === 'ARCHIVE') {
      const flutter = 0.5 + this.rng.next();
      this.rustleGain.gain.setTargetAtTime(env * 0.02 * flutter, t, 0.22);
    } else {
      this.rustleGain.gain.setTargetAtTime(0, t, 0.3);
    }

    // ornaments: faint monitor beeps / toy chimes on slow schedules
    if (this.kind === 'MEDICAL') {
      this.nextBeepIn -= dt;
      if (this.nextBeepIn <= 0) {
        this.nextBeepIn = 1.6 + this.rng.next() * 0.8;
        this.beep(t);
      }
    } else if (this.kind === 'PLAYROOM') {
      this.nextChimeIn -= dt;
      if (this.nextChimeIn <= 0) {
        this.nextChimeIn = 4 + this.rng.next() * 5;
        this.chime(t);
      }
    }
  }

  /** Silence everything and release sources; double-stop is safe. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /** Alias of the chest stage referenced by the tick (kept for clarity). */
  private get swell(): { gain: AudioParam } {
    return { gain: this.breathGain.gain };
  }

  /** MEDICAL ornament: one soft monitor blip. */
  private beep(t: number): void {
    try {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1180;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.02, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(g);
      g.connect(this.breathGain); // ride the room bus
      osc.start(t);
      osc.stop(t + 0.1);
    } catch { /* ornament failures are non-fatal */ }
  }

  /** PLAYROOM ornament: two-note toy chime. */
  private chime(t: number): void {
    try {
      const notes = [1046.5, 1318.5];
      notes.forEach((f, i) => {
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = f;
        const g = this.ctx.createGain();
        const at = t + i * 0.18;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.015, at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
        osc.connect(g);
        g.connect(this.breathGain);
        osc.start(at);
        osc.stop(at + 0.4);
      });
    } catch { /* ornament failures are non-fatal */ }
  }
}
