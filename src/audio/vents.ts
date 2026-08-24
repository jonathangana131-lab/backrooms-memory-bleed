/**
 * Vent rumble for BACKROOMS: MEMORY BLEED.
 *
 * The ceiling vents breathe. A deterministic vent field (18 m grid, each
 * cell active or dead by hash) drives a low bandpassed air bed whose level
 * tracks the nearest live vent, plus occasional pressure-groan swells --
 * slow filtered-noise surges that rise and fall like something shifting in
 * the ductwork overhead.
 *
 *   BED      looping noise through a low-band resonant filter parked near
 *            70 Hz; proximity to the closest active vent opens the gain.
 *   GROANS   every 9-22 s while a vent is in earshot, one pressure swell
 *            (bandpass sweep 60 -> 130 Hz -> 55 Hz over ~4 s).
 *   DETERMINISM vent placement and swell timing come from src/core/rng.ts
 *            hashes only -- the same corridor always breathes the same way.
 *
 * Fully procedural Web Audio following doors.ts conventions: lazy graph
 * build on first audible update, per-voice try/catch islands logging
 * '[bmb] ...', update() never throws.
 */

import { rand2, RNG } from '../core/rng';

/** Vent field grid pitch, meters (independent of the chunk grid). */
const VENT_CELL_M = 18;
/** Fraction of grid cells that host a live vent. */
const VENT_DENSITY = 0.4;
/** Vent salt: independent of every other feature's lottery. */
const VENT_SALT = 0x7e17;

/** Audibility range of one vent, meters. */
const HEAR_RADIUS = 14;

/** Bed level when standing directly under a vent. */
const BED_PEAK = 0.05;

/** Pressure-swell cadence range, seconds (RNG-drawn). */
const GROAN_MIN_S = 9;
const GROAN_MAX_S = 22;

export class VentAudio {
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;

  // ---- graph ----
  private noiseSrc: AudioBufferSourceNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  private bedGain: GainNode | null = null;
  private built = false;
  private stopped = false;

  /** Eased bed loudness 0..1. */
  private level = 0;
  /** Countdown to the next pressure swell, seconds. */
  private nextGroanIn = 6;
  /** Deterministic stream for swell timing (never Math.random). */
  private readonly rng = new RNG(0x7e170001);

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /**
   * Per-frame tick.
   * @param dt       seconds since the previous frame
   * @param district current district index (reserved for future keying)
   * @param px       listener world X
   * @param pz       listener world Z
   */
  update(dt: number, district: number, px: number, pz: number): void {
    if (this.stopped || dt <= 0) return;
    try {
      if (!this.built) this.build();
      void district;

      // nearest live vent on the deterministic field
      const cx = Math.floor(px / VENT_CELL_M);
      const cz = Math.floor(pz / VENT_CELL_M);
      let best = Infinity;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const gx = cx + dx;
          const gz = cz + dz;
          if (rand2(gx, gz, VENT_SALT) >= VENT_DENSITY) continue;
          const vx = gx * VENT_CELL_M + VENT_CELL_M / 2;
          const vz = gz * VENT_CELL_M + VENT_CELL_M / 2;
          const d = Math.hypot(vx - px, vz - pz);
          if (d < best) best = d;
        }
      }

      const target = best < HEAR_RADIUS ? 1 - best / HEAR_RADIUS : 0;
      this.level += (target - this.level) * Math.min(1, dt * 1.2);
      const t = this.ctx.currentTime;
      this.bedGain!.gain.setTargetAtTime(this.level * BED_PEAK, t, 0.5);

      // pressure swells only while a vent is in earshot
      if (target > 0) {
        this.nextGroanIn -= dt;
        if (this.nextGroanIn <= 0) {
          this.nextGroanIn = this.rng.range(GROAN_MIN_S, GROAN_MAX_S);
          this.groan(t, target);
        }
      }
    } catch (e) {
      console.warn('[bmb] vent audio failed', e);
    }
  }

  /** Silence everything and release nodes; the instance will not restart. */
  stop(): void {
    this.stopped = true;
    if (this.noiseSrc) { try { this.noiseSrc.stop(); } catch { /* already stopped */ } this.noiseSrc = null; }
    if (this.bedGain) this.bedGain.gain.value = 0;
  }

  // ---------------------------------------------------------------------------
  // Lazy graph construction
  // ---------------------------------------------------------------------------

  private build(): void {
    this.built = true;
    const ctx = this.ctx;

    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    this.bedGain.connect(this.destination);

    // low-band resonant filter: duct rumble sits under ~100 Hz
    this.bedFilter = ctx.createBiquadFilter();
    this.bedFilter.type = 'bandpass';
    this.bedFilter.frequency.value = 70;
    this.bedFilter.Q.value = 1.1;
    this.bedFilter.connect(this.bedGain);

    // looping air bed; buffer fill is audio DSP, exempt from the sim PRNG law
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = this.noiseBuffer();
    this.noiseSrc.loop = true;
    this.noiseSrc.connect(this.bedFilter);
    this.noiseSrc.start();
  }

  /**
   * One pressure swell: bandpass sweeps up then sags below its start over
   * roughly four seconds, like the ducts equalizing.
   */
  private groan(at: number, proximity: number): void {
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      src.loop = true;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(60, at);
      bp.frequency.linearRampToValueAtTime(130, at + 1.6);
      bp.frequency.linearRampToValueAtTime(55, at + 3.8);
      bp.Q.value = 5;

      const g = this.ctx.createGain();
      const peak = 0.06 * proximity;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + 1.8);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 4);

      src.connect(bp).connect(g).connect(this.destination);
      src.start(at);
      src.stop(at + 4.1);
    } catch (e) {
      console.warn('[bmb] vent groan failed', e);
    }
  }

  /** Shared one-second white-noise buffer. */
  private noiseBuffer(): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1; // DSP fill exempt from sim PRNG law
    return buf;
  }
}
