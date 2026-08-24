/**
 * Elevator ambience for BACKROOMS: MEMORY BLEED.
 *
 * Somewhere out of sight, cars still run. Every 25-60 s a distant car call
 * drifts through the walls: a muffled two-note chime motif followed by a
 * cable whine as the car leaves. Nothing is ever close; the lowpass wall
 * tilt and near-noise-floor levels keep every call a rumour.
 *
 *   CALL     two sine notes (a falling minor third) through a heavy
 *            lowpass (~500 Hz) -- a chime heard from another floor.
 *   CABLE    a soft bandpassed noise glide rising away after the chime,
 *            like the counterweight taking the shaft.
 *   DISTRICT office towers (district 1) hear full calls; honeycomb (2)
 *            hears fainter service cars; elsewhere only a rare far echo.
 *
 * Fully procedural Web Audio following doors.ts conventions: lazy graph
 * build, per-voice try/catch islands logging '[bmb] ...', update() never
 * throws. Call timing draws from the deterministic core RNG stream.
 */

import { RNG } from '../core/rng';

/** District ids mirrored locally (src/world/constants.ts). */
const DISTRICT_OPEN_OFFICE = 1;
const DISTRICT_HONEYCOMB = 2;

/** Loudness per district: office > honeycomb > everywhere else. */
function districtLevel(district: number): number {
  if (district === DISTRICT_OPEN_OFFICE) return 1;
  if (district === DISTRICT_HONEYCOMB) return 0.6;
  return 0.25;
}

/** Seconds between car calls (RNG-drawn). */
const CALL_MIN_S = 25;
const CALL_MAX_S = 60;

/** Chime notes, Hz -- a falling minor third heard through concrete. */
const CHIME_A = 523;
const CHIME_B = 415;

export class ElevatorAmbience {
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;

  private built = false;
  private stopped = false;

  /** Shared "behind the walls" tilt for every call. */
  private tilt: BiquadFilterNode | null = null;
  /** Countdown to the next car call, seconds. */
  private nextCallIn = 8;
  /** Deterministic stream for call timing and voice character. */
  private readonly rng = new RNG(0xe1e7a701);

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /**
   * Per-frame tick.
   * @param dt       seconds since the previous frame
   * @param district current district index, gates call loudness
   */
  update(dt: number, district: number): void {
    if (this.stopped || dt <= 0) return;
    try {
      if (!this.built) this.build();
      const lvl = districtLevel(district);
      if (lvl <= 0) return;

      this.nextCallIn -= dt * lvl; // quieter districts hear fewer calls
      if (this.nextCallIn > 0) return;
      this.nextCallIn = this.rng.range(CALL_MIN_S, CALL_MAX_S);
      this.carCall(this.ctx.currentTime + 0.05, lvl);
    } catch (e) {
      console.warn('[bmb] elevator ambience failed', e);
    }
  }

  /** Silence everything; the instance will not restart. */
  stop(): void {
    this.stopped = true;
    if (this.tilt) { try { this.tilt.disconnect(); } catch { /* already gone */ } this.tilt = null; }
  }

  // ---------------------------------------------------------------------------

  private build(): void {
    this.built = true;
    this.tilt = this.ctx.createBiquadFilter();
    this.tilt.type = 'lowpass';
    this.tilt.frequency.value = 500; // the chime is always behind concrete
    this.tilt.Q.value = 0.4;
    this.tilt.connect(this.destination);
  }

  /**
   * One distant car call: muffled chime pair, then the cable whine gliding
   * up and away. Everything lands on the shared wall-tilt filter.
   */
  private carCall(at: number, lvl: number): void {
    try {
      const master = this.ctx.createGain();
      master.gain.value = 0.14 * lvl;
      master.connect(this.tilt!);

      // chime pair, slightly detuned per call so no two cars ring alike
      const detune = this.rng.range(-0.97, 1.03);
      this.note(CHIME_A * detune, at, 0.5, master);
      this.note(CHIME_B * detune, at + 0.42, 0.7, master);

      // cable whine: narrow noise band glides upward and fades
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(180, at + 0.8);
      bp.frequency.exponentialRampToValueAtTime(420, at + 3.4);
      bp.Q.value = 9;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, at + 0.8);
      g.gain.linearRampToValueAtTime(0.35, at + 1.4);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 3.6);
      src.connect(bp).connect(g).connect(master);
      src.start(at + 0.8);
      src.stop(at + 3.7);
    } catch (e) {
      console.warn('[bmb] elevator call failed', e);
    }
  }

  /** One soft damped sine note into the given bus. */
  private note(freq: number, at: number, dur: number, bus: AudioNode): void {
    try {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.9, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(g).connect(bus);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    } catch (e) {
      console.warn('[bmb] elevator chime failed', e);
    }
  }

  /** Shared two-second white-noise buffer. */
  private noiseBuffer(): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1; // DSP fill exempt from sim PRNG law
    return buf;
  }
}
