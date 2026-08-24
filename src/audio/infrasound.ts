/**
 * Infrasound beds for BACKROOMS: MEMORY BLEED.
 *
 * True dread lives below hearing. Each district carries its own bed: an
 * infrasonic pressure oscillation too low to hear directly (sub-20 Hz),
 * expressed through audible harmonic proxies — steady low carriers whose
 * amplitude envelope breathes at exactly the infrasonic rate. The listener
 * never hears the tone, only the wrongness of air that swells and drains
 * in a slow, mechanical pulse.
 *
 * Per-district modulation rates rise with the district ordinal
 * (7/9/11/13/17 Hz), each jittered per seed so no two runs pulse alike,
 * yet both stay within ±2% of their descriptor. Modulation depth stays
 * inside [0.15, 0.45]: always perceptible, never a tremolo effect.
 *
 * Graph wiring mirrors src/audio/exterior.ts idioms: carrier oscillators
 * at harmonics of a sub-audible fundamental feed one AM gain node whose
 * gain parameter is driven by an LFO oscillator at modHz through a depth
 * gain. `descriptor()` exposes {modHz, depth} for consumers that need to
 * wire or analyse the bed; `env(t)` is the pure envelope the graph
 * implements (raised-cosine around 1 - depth/2).
 *
 * All pacing/jitter rolls come from one seeded stream per district
 * (`hash2i` keyed off `(seed ^ INFRASOUND_SALT)`, src/core/rng.ts);
 * no Math.random anywhere — this module fills no DSP buffers.
 */

import { RNG, hash2i } from '../core/rng';

const TWO_PI = Math.PI * 2;

/** Stream salt so bed jitter never correlates with other seeded systems. */
const INFRASOUND_SALT = 0x1344a70;

/** Default stream seed used when no run seed reaches the constructor. */
export const DEFAULT_INFRASOUND_SEED = 0x1a7f00d5;

/**
 * Base modulation rate per district ordinal 0..4 (Hz). All sub-20 Hz by
 * law: the bed must stay beneath conscious pitch perception.
 */
export const DISTRICT_MOD_HZ = [7, 9, 11, 13, 17] as const;

/** Seeded jitter half-width applied to each district's base rate (Hz). */
export const MOD_JITTER_HZ = 0.6;

/** Modulation depth floor/ceiling — felt, but never a tremolo. */
export const DEPTH_MIN = 0.15;
export const DEPTH_MAX = 0.45;

/** Sub-audible fundamental band the harmonic carriers are built from (Hz). */
const FUNDAMENTAL_MIN = 12;
const FUNDAMENTAL_MAX = 18;

/** Harmonic multiples of the fundamental that stay audible as rumble. */
const CARRIER_MULTIPLES = [3, 4, 5] as const;

/** Seconds for kill() to reach full silence without a click. */
export const KILL_RAMP_S = 2.5;

/**
 * The exposed modulation contract: the true sub-20 Hz rate and how far
 * the carrier envelope swings around it.
 */
export interface ModDescriptor {
  /** True modulation rate in Hz (always < 20). */
  modHz: number;
  /** Peak-to-mean swing fraction of the envelope, bounded [DEPTH_MIN, DEPTH_MAX]. */
  depth: number;
}

/**
 * Pure amplitude envelope the audio graph implements.
 *
 * A raised cosine around `1 - depth/2`, so the carrier level swings
 * between `1 - depth` and `1`. Its alternating component crosses its own
 * mean twice per cycle, giving a zero-crossing period of exactly
 * `1 / modHz`.
 *
 * @param d modulation descriptor (rate + depth)
 * @param t time in seconds from any fixed origin
 * @returns carrier gain multiplier at time t
 */
export function env(d: ModDescriptor, t: number): number {
  return 1 - (d.depth / 2) * (1 - Math.cos(TWO_PI * d.modHz * t));
}

/** Clamp helper keeping descriptors inside their lawful bands. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

interface Voice {
  carrier: OscillatorNode;
}

/**
 * One district's infrasonic bed: audible harmonic carriers whose shared
 * AM gain pulses at the district's true sub-20 Hz rate. Construct once
 * per session; retune across districts with setDistrict().
 */
export class InfrasoundBed {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private readonly master: GainNode;
  /** LFO -> depthGain -> amGain.gain; amGain carries every harmonic. */
  private readonly lfo: OscillatorNode;
  private readonly depthGain: GainNode;
  private readonly amGain: GainNode;
  private readonly voices: Voice[] = [];
  private current: ModDescriptor;
  private stopped = false;

  /**
   * Build the bed for one district and start it immediately.
   * @param ctx         live AudioContext
   * @param destination mix point for the bed (quiet by design)
   * @param seed        run seed; drives per-district jitter deterministically
   * @param district    ordinal 0..4 (values outside clamp to the nearest end)
   */
  constructor(ctx: AudioContext, destination: AudioNode, seed: number, district = 0) {
    this.ctx = ctx;
    this.out = destination;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.out);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    const depthGain = ctx.createGain();
    const amGain = ctx.createGain();
    lfo.connect(depthGain).connect(amGain.gain);
    amGain.connect(this.master);
    lfo.start();
    this.lfo = lfo;
    this.depthGain = depthGain;
    this.amGain = amGain;

    // Sub-audible fundamental: seeded once, all carriers are its harmonics.
    const root = new RNG((seed ^ INFRASOUND_SALT) >>> 0);
    const f0 = root.range(FUNDAMENTAL_MIN, FUNDAMENTAL_MAX);
    for (const k of CARRIER_MULTIPLES) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f0 * k;
      o.connect(amGain);
      o.start();
      this.voices.push({ carrier: o });
    }

    this.current = { modHz: 7, depth: (DEPTH_MIN + DEPTH_MAX) / 2 };
    this.setDistrict(seed, district);
  }

  /**
   * Retune the bed to another district's rate and reseeded jitter. The
   * new descriptor comes from the same hash-keyed stream as construction,
   * so identical seeds replay identical beds per district forever.
   */
  setDistrict(seed: number, district: number): void {
    const d = Math.max(0, Math.min(4, Math.round(district)));
    const rng = new RNG(hash2i((seed ^ INFRASOUND_SALT) >>> 0, d, INFRASOUND_SALT));
    const modHz = clamp(DISTRICT_MOD_HZ[d] + rng.range(-MOD_JITTER_HZ, MOD_JITTER_HZ), 0.5, 19.9);
    const depth = clamp(rng.range(DEPTH_MIN, DEPTH_MAX), DEPTH_MIN, DEPTH_MAX);
    const t = this.ctx.currentTime;
    this.lfo.frequency.setTargetAtTime(modHz, t, 0.05);
    this.amGain.gain.setValueAtTime(1 - depth / 2, t); // envelope midpoint
    this.depthGain.gain.setValueAtTime(depth / 2, t); // swing around midpoint
    this.current = { modHz, depth };
  }

  /** The live modulation contract, safe for graph wiring or analysis. */
  descriptor(): ModDescriptor {
    return { ...this.current };
  }

  /**
   * Kill-switch: ramp the whole bed to silence over KILL_RAMP_S and stop
   * scheduling. Idempotent; after it returns the bed contributes nothing.
   */
  kill(): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0, t + KILL_RAMP_S);
    const stopAt = t + KILL_RAMP_S + 0.1;
    try { this.lfo.stop(stopAt); } catch { /* already ended */ }
    for (const v of this.voices) {
      try { v.carrier.stop(stopAt); } catch { /* already ended */ }
    }
  }
}
