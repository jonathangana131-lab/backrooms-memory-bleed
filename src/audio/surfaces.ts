/**
 * District-specific procedural footsteps for BACKROOMS: MEMORY BLEED.
 *
 * Every surface is a filtered white-noise burst with its own envelope
 * and EQ character — no asset files:
 *   carpet : soft thud      -> 200 Hz lowpass, ~80 ms
 *   tile   : click + tail   -> 3 ms click + 1 kHz bandpass, ~50 ms
 *   metal  : resonant ring  -> 800 Hz high-Q bandpass, ~200 ms decay
 *   splash : puddle zone    -> broadband ~120 ms, highpass sweeping up
 *
 * Each step gets ±10 % random pitch/volume so repeated steps never sound
 * identical, and sprinting makes steps faster, louder and slightly higher.
 *
 * Determinism: per-step jitter rolls and buffer start offsets draw from
 * one seeded RNG stream (`(seed ^ SURFACE_SALT) >>> 0`, src/core/rng.ts);
 * only the shared sample-data buffer fill keeps Math.random under the
 * DSP carve-out.
 */
import { RNG } from '../core/rng';

/** Stream salt so footstep rolls never correlate with other seeded systems. */
const SURFACE_SALT = 0x53223f01;
/** Default stream seed used when no run seed reaches the constructor. */
const DEFAULT_SURFACE_SEED = 0x1a9d4e77;

export type SurfaceKind = 'carpet' | 'tile' | 'metal' | 'splash';

const SURFACES: readonly SurfaceKind[] = ['carpet', 'tile', 'metal', 'splash'];

/** Base per-surface voice: loudness and how long the burst rings. */
interface SurfaceProfile {
  /** peak gain before jitter */
  vol: number;
  /** nominal burst length in seconds (before sprint compression) */
  dur: number;
}

const PROFILES: Record<SurfaceKind, SurfaceProfile> = {
  carpet: { vol: 0.14, dur: 0.08 },
  tile:   { vol: 0.11, dur: 0.05 },
  metal:  { vol: 0.09, dur: 0.20 },
  splash: { vol: 0.16, dur: 0.12 },
};

export class SurfaceFootsteps {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private readonly noise: AudioBuffer;
  /** Seeded stream driving per-step jitter and start offsets (determinism law). */
  private readonly rng: RNG;

  constructor(ctx: AudioContext, destination: AudioNode, seed = DEFAULT_SURFACE_SEED) {
    this.ctx = ctx;
    this.out = destination;
    this.rng = new RNG((seed ^ SURFACE_SALT) >>> 0);
    // 1 s mono white-noise buffer, shared by every step voice
    const len = Math.max(1, Math.floor(ctx.sampleRate));
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    // audio DSP buffer fill (white noise source) — sim PRNG law carve-out
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  /**
   * Play one footstep on the given surface.
   * @param surface district floor material
   * @param sprint  true while the player is sprinting: faster, louder,
   *                slightly higher-pitched step
   */
  play(surface: SurfaceKind, sprint = false): void {
    if (!SURFACES.includes(surface)) return;
    const profile = PROFILES[surface];

    // ±10 % variation so consecutive steps differ
    const jit = () => this.rng.range(0.9, 1.1);
    const pitchMul = jit() * (sprint ? 1.06 : 1); // sprint sits a touch higher
    const vol = profile.vol * jit() * (sprint ? 1.45 : 1);
    // sprint: snappier burst
    const dur = profile.dur * (sprint ? 0.78 : 1);

    switch (surface) {
      case 'carpet': this.carpet(pitchMul, vol, dur); break;
      case 'tile':   this.tile(pitchMul, vol, dur); break;
      case 'metal':  this.metal(pitchMul, vol, dur); break;
      case 'splash': this.splash(pitchMul, vol, dur); break;
    }
  }

  /** Shared noise-source setup: detuned playback offset into the buffer. */
  private burst(rate: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    return src;
  }

  /** Standard percussive envelope: fast attack, exponential release. */
  private env(peak: number, dur: number, t0: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    return g;
  }

  /** Soft thud: 200 Hz lowpass smears everything above a dull knock. */
  private carpet(pitch: number, vol: number, dur: number): void {
    const t = this.ctx.currentTime;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 200 * pitch;
    f.Q.value = 0.7;
    const g = this.env(vol, dur, t);
    const src = this.burst(pitch);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, this.rng.range(0, 0.5), dur + 0.05);
  }

  /** Click + tail: 3 ms wideband transient into a 1 kHz bandpass body. */
  private tile(pitch: number, vol: number, dur: number): void {
    const t = this.ctx.currentTime;
    const src = this.burst(pitch);

    // 3 ms click — almost dry, gives the heel-strike
    const clickHp = this.ctx.createBiquadFilter();
    clickHp.type = 'highpass';
    clickHp.frequency.value = 1800 * pitch;
    const clickG = this.env(vol * 0.8, 0.003, t);

    // short bandpass tail at 1 kHz — the ceramic ring
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1000 * pitch;
    bp.Q.value = 2.2;
    const tailG = this.env(vol * 0.55, dur, t + 0.002);

    src.connect(clickHp).connect(clickG).connect(this.out);
    src.connect(bp).connect(tailG).connect(this.out);
    src.start(t, this.rng.range(0, 0.5), dur + 0.02);
  }

  /** Resonant ring: narrow 800 Hz band with a long metallic decay. */
  private metal(pitch: number, vol: number, dur: number): void {
    const t = this.ctx.currentTime;
    const src = this.burst(pitch);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 800 * pitch;
    bp.Q.value = 14; // ringing resonance
    const g = this.env(vol, dur, t);
    // faint upper partial sells the sheet-metal clang
    const partial = this.ctx.createBiquadFilter();
    partial.type = 'bandpass';
    partial.frequency.value = 800 * 2.76 * pitch;
    partial.Q.value = 18;
    const pg = this.env(vol * 0.35, dur * 0.7, t);
    src.connect(bp).connect(g).connect(this.out);
    src.connect(partial).connect(pg).connect(this.out);
    src.start(t, this.rng.range(0, 0.5), dur + 0.05);
  }

  /** Puddle: broadband slosh, highpass sweeping upward across the burst. */
  private splash(pitch: number, vol: number, dur: number): void {
    const t = this.ctx.currentTime;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(320 * pitch, t);
    hp.frequency.exponentialRampToValueAtTime(3400 * pitch, t + dur);
    hp.Q.value = 0.9;
    const g = this.env(vol, dur, t);
    const src = this.burst(pitch);
    src.connect(hp).connect(g).connect(this.out);
    src.start(t, this.rng.range(0, 0.5), dur + 0.05);
  }
}


