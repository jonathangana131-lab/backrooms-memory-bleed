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


    this.distGain = out.distGain;

    // glottal source
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = this.baseFreq;
    const oscLevel = ctx.createGain();
    oscLevel.gain.value = 0.5;
    osc.connect(oscLevel);

    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.7 + this.rnd() * 1.4;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 7;
    vibrato.connect(vibDepth).connect(osc.detune);

    // parallel formant bank
    const env = ctx.createGain();
    env.gain.value = 0;
    const formantGains = [1, 0.55, 0.28];
    for (let i = 0; i < 3; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = VOWELS[0].f1 * this.formantScale;
      f.Q.value = [9, 11, 13][i];
      const fg = ctx.createGain();
      fg.gain.value = formantGains[i];
      oscLevel.connect(f).connect(fg).connect(env);
      this.formants.push(f);
    }
    // a little raw source bleed so it reads as breath, not pure tone
    const rasp = ctx.createBiquadFilter();
    rasp.type = 'bandpass';
    rasp.frequency.value = 1400;
    rasp.Q.value = 0.9;
    const raspGain = ctx.createGain();
    raspGain.gain.value = 0.05;
    oscLevel.connect(rasp).connect(raspGain).connect(env);

    env.connect(out.distGain);

    osc.start();
    vibrato.start();

    this.osc = osc;
    this.vibrato = vibrato;
    this.voiceEnv = env;
  }

  /**
   * Per-frame pump: ease the distance gate and fire mutter bursts on
   * the 20-40s cadence while the player is inside 10m.
   * @returns true if a new burst was scheduled this frame
   */
  update(dt: number, dist: number): boolean {
    if (this.stopped) return false;
    this.lastDist = dist;
    const t = this.ctx.currentTime;
    const level = distanceScale(dist, BELIEVER_RANGE) * 0.16;
    this.distGain?.gain.setTargetAtTime(level, t, 0.25);

    if (this.busyRemaining > 0) this.busyRemaining -= dt;

    if (dist >= BELIEVER_RANGE) return false; // cadence only runs in range

    this.nextIn -= dt;
    if (this.nextIn <= 0) {
      this.nextIn = MUTTER_MIN_GAP + this.rnd() * (MUTTER_MAX_GAP - MUTTER_MIN_GAP);
      if (this.busyRemaining <= 0) {
        this.busyRemaining = this.scheduleMutter(t);
        return true;
      }
    }
    return false;
  }

  /**
   * Plan a whole burst of prayer-babble on the audio clock: 2-5 words,
   * 1-4 syllables each, formants stepping between vowel targets.
   * Returns the burst length in seconds.
   */
  private scheduleMutter(now: number): number {
    const env = this.voiceEnv!.gain;
    let t = now + 0.12;
    const words = 2 + Math.floor(this.rnd() * 4);
    for (let w = 0; w < words; w++) {
      const syllables = 1 + Math.floor(this.rnd() * 4);
      for (let s = 0; s < syllables; s++) {
        const dur = (0.11 + this.rnd() * 0.09) / this.rate;
        const peak = (0.16 + this.rnd() * 0.14) * 0.7; // quieter than a radio
        const v = VOWELS[Math.floor(this.rnd() * VOWELS.length)];
        for (let i = 0; i < 3; i++) {
          const target = (i === 0 ? v.f1 : i === 1 ? v.f2 : v.f3) * this.formantScale;
          this.formants[i]?.frequency.setTargetAtTime(target, t, dur * 0.35);
        }
        env.setTargetAtTime(peak, t, 0.018);
        env.setTargetAtTime(peak * 0.35, t + dur * 0.55, 0.03);
        env.setTargetAtTime(0.0001, t + dur, 0.022);
        t += dur + (0.012 + this.rnd() * 0.03) / this.rate;
      }
      t += this.rnd() < 0.22
        ? 0.45 + (this.rnd() * 0.55) / this.rate
        : (0.08 + this.rnd() * 0.28) / this.rate;
    }
    return t - now;
  }

  /** Seconds until this voice may next mutter (for tests/debug). */
  get timeToNext(): number {
    return this.lastDist < BELIEVER_RANGE ? this.nextIn : Infinity;
  }

  stop(): void {
    this.stopped = true;
    const t = this.ctx.currentTime;
    try { this.distGain?.gain.setTargetAtTime(0.0001, t, 0.08); } catch { /* detached */ }
    try { this.osc?.stop(t + 0.5); } catch { /* already stopped */ }
    try { this.vibrato?.stop(t + 0.5); } catch { /* already stopped */ }
  }
}

// ---------------------------------------------------------------------
// Wanderer humming - a slow pentatonic fragment on a bare sine.
// ---------------------------------------------------------------------

export class HumVoice {
  // ---- graph (public for tests) ----
  osc: OscillatorNode | null = null;
  vibrato: OscillatorNode | null = null;
  noteEnv: GainNode | null = null;
  distGain: GainNode | null = null;

  private readonly ctx: AudioContext;
  private rnd: () => number;
  private baseFreq: number;

  private busyRemaining = 0;
  private nextIn: number;
  private lastDist = Infinity;
  stopped = false;

  constructor(
    ctx: AudioContext,
    destination: AudioNode,
    seed: number,
  ) {
    this.ctx = ctx;
    this.rnd = mulberry32(seed);
    this.baseFreq = 175 + this.rnd() * 75;         // 175-250 Hz: low, tuneless
    this.nextIn = HUM_MIN_GAP + this.rnd() * (HUM_MAX_GAP - HUM_MIN_GAP);

    const out = makeVoiceOut(ctx, destination, this.rnd);
    this.distGain = out.distGain;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = this.baseFreq;

    // faint pitch wobble so the tone reads as a throat, not a test signal
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.5 + this.rnd() * 1.5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 5;
    vibrato.connect(vibDepth).connect(osc.detune);

    const env = ctx.createGain();
    env.gain.value = 0;
    osc.connect(env).connect(out.distGain);

    osc.start();
    vibrato.start();

    this.osc = osc;
    this.vibrato = vibrato;
    this.noteEnv = env;
  }

  /**
   * Per-frame pump: ease the distance gate and start a hum phrase on
   * the 30-60s cadence while the player is inside 12m.
   * @returns true if a new phrase was scheduled this frame
   */
  update(dt: number, dist: number): boolean {
    if (this.stopped) return false;
    this.lastDist = dist;
    const t = this.ctx.currentTime;
    const level = distanceScale(dist, WANDERER_RANGE) * 0.06; // very quiet
    this.distGain?.gain.setTargetAtTime(level, t, 0.25);

    if (this.busyRemaining > 0) this.busyRemaining -= dt;

    if (dist >= WANDERER_RANGE) return false;

    this.nextIn -= dt;
    if (this.nextIn <= 0) {
      this.nextIn = HUM_MIN_GAP + this.rnd() * (HUM_MAX_GAP - HUM_MIN_GAP);
      if (this.busyRemaining <= 0) {
        this.busyRemaining = this.schedulePhrase(t);
        return true;
      }
    }
    return false;
  }

  /**
   * Plan one 3-5 note phrase: a random walk over the minor pentatonic,
   * gentle portamento between notes, soft swelled envelopes.
   * Returns the phrase length in seconds.
   */
  private schedulePhrase(now: number): number {
    const env = this.noteEnv!.gain;
    const osc = this.osc!;
    const notes = 3 + Math.floor(this.rnd() * 3); // 3-5 notes
    let degree = Math.floor(this.rnd() * PENTATONIC.length);
    let t = now + 0.15;
    for (let i = 0; i < notes; i++) {
      // random walk, mostly neighbouring degrees, occasionally a leap
      const roll = this.rnd();
      const step = roll < 0.35 ? -1 : roll < 0.7 ? 1 : roll < 0.85 ? -2 : 2;
      degree = Math.max(0, Math.min(PENTATONIC.length - 1, degree + step));
      const freq = this.baseFreq * Math.pow(2, PENTATONIC[degree] / 12);
      const dur = 0.5 + this.rnd() * 0.5;
      osc.frequency.setTargetAtTime(freq, Math.max(now, t - 0.06), 0.05); // slide in
      env.setTargetAtTime(0.5, t, 0.09);                                  // swell
      env.setTargetAtTime(0.16, t + dur * 0.65, 0.1);
      env.setTargetAtTime(0.0001, t + dur, 0.07);
      t += dur + 0.04;
    }
    return t - now;
  }

  /** Seconds until this voice may next hum (for tests/debug). */
  get timeToNext(): number {
    return this.lastDist < WANDERER_RANGE ? this.nextIn : Infinity;
  }

  stop(): void {
    this.stopped = true;
    const t = this.ctx.currentTime;
    try { this.distGain?.gain.setTargetAtTime(0.0001, t, 0.08); } catch { /* detached */ }
    try { this.osc?.stop(t + 0.5); } catch { /* already stopped */ }
    try { this.vibrato?.stop(t + 0.5); } catch { /* already stopped */ }
  }
}

// ---------------------------------------------------------------------
// EntityVocals - the front door the game talks to.
// ---------------------------------------------------------------------

/**
 * Owns every figure voice. Feed it the same proximity snapshot the
 * rest of the game layers audio from:
 *
 *   vocals.update(dt, manager.proximity);   // {figure, type, dist}[]
 *
 * Entries carry extra fields; only type and dist are read.
 */
export class EntityVocals {
  private ctx: AudioContext;
  private destination: AudioNode;

  /** Public for tests: one mutter slot per concurrent believer voice. */
  mutters: MutterVoice[] = [];
  /** Public for tests: one hum slot per concurrent wanderer voice. */
  hums: HumVoice[] = [];

  private master: GainNode | null;
  stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(destination);
    this.master = master;
    for (let i = 0; i < VOICES_PER_TYPE; i++) {
      this.mutters.push(new MutterVoice(ctx, master, 0xbe110e + i * 7919));
      this.hums.push(new HumVoice(ctx, master, 0x3e7a11 + i * 104729));
    }
  }

  /**
   * Pump all voices from a proximity snapshot. Watchers are
   * deliberately absent from every branch below: they never vocalize.
   * @returns true if any voice started a new utterance this frame
   */
  update(dt: number, figures: readonly VocalFigure[]): boolean {
    if (this.stopped || !(dt > 0)) return false;
    const step = Math.min(dt, 0.25); // clamp tab-resume spikes

    // nearest-first so the closest figure owns slot 0
    const believers = figures
      .filter((f) => f.type === 'believer')
      .sort((a, b) => a.dist - b.dist);
    let fired = false;
    for (let i = 0; i < this.mutters.length; i++) {
      const fig = believers[i];
      if (this.mutters[i].update(step, fig ? fig.dist : Infinity)) fired = true;
    }

    const wanderers = figures
      .filter((f) => f.type === 'wanderer')
      .sort((a, b) => a.dist - b.dist);
    for (let i = 0; i < this.hums.length; i++) {
      const fig = wanderers[i];
      if (this.hums[i].update(step, fig ? fig.dist : Infinity)) fired = true;
    }

    // 'watcher', 'helper', 'incomplete', 'double': silence, by design.
    return fired;
  }

  /** Fade everything out and release the graph; the instance will not restart. */
  stop(): void {
    this.stopped = true;
    for (const m of this.mutters) m.stop();
    for (const h of this.hums) h.stop();
    const t = this.ctx.currentTime;
    try { this.master?.gain.setTargetAtTime(0.0001, t, 0.1); } catch { /* detached */ }
    setTimeout(() => {
      try { this.master?.disconnect(); } catch { /* not connected */ }
    }, 600);
    this.master = null;
  }
}


