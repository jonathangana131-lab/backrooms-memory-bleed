/**
 * Paired background voices for BACKROOMS: MEMORY BLEED.
 *
 * Somewhere behind the walls, TWO people are talking. Neither ever quite
 * resolves into language: PairVocals spawns little two-speaker knots of
 * formant babble (the radio.ts voice technique, doubled and detuned) at
 * world positions, lets them trade short turn-taking utterances, and
 * fades the whole knot out when the exchange dries up.
 *
 * Fully procedural, no assets. Instances are cheap: a conversation is two
 * glottal sawtooth voices through two bandpass formants each, panned wide.
 *
 * Determinism: speaker voice streams are seeded per exchange (mulberry32,
 * as in crowd.ts); turn durations draw from a per-exchange stream seeded
 * by the instance stream seed XOR a site salt; exchanges spawned without
 * an explicit seed derive one from the spawn sequence via hash2i
 * (src/core/rng.ts). No buffer fills exist in this file.
 */
import { hash2i } from '../core/rng';

/** Stream salt so pair-vocal seeds never correlate with other seeded systems. */
const PAIR_SALT = 0x70a12c05;
/** Default instance stream seed used when no run seed reaches the constructor. */
const DEFAULT_PAIR_SEED = 0x2b7e91d4;
/** Salt separating the per-exchange turn-duration stream from voice streams. */
const TURN_SALT = 0x51d3;

/** Phases of one paired exchange. */
export type ConvoPhase = 'approach' | 'exchange' | 'parting';

/** Diagnostics snapshot for tests and wiring. */
export interface ConvoDebug {
  phase: ConvoPhase;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** 0 = speaker A holds the floor, 1 = speaker B */
  speaker: number;
  /** seconds left in the current utterance */
  timeLeft: number;
  /** seconds left before the next utterance may start */
  coolLeft: number;
  /** completed turns so far */
  turns: number;
}

/** One formant-babble speaker inside an exchange. */
interface Speaker {
  readonly osc: OscillatorNode;
  readonly formants: BiquadFilterNode[];
  readonly env: GainNode;
  readonly pan: StereoPannerNode;
  readonly rnd: () => number;
  nextAt: number;
}

interface Convo {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  a: Speaker;
  b: Speaker;
  /** Turn-duration stream for this exchange (determinism law). */
  rng: () => number;
  phase: ConvoPhase;
  speaker: number;
  timeLeft: number;
  coolLeft: number;
  turns: number;
}

/** Deterministic mulberry32 stream (same construction as crowd.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UTTERANCE_MIN = 0.9;   // shortest turn, s
const UTTERANCE_MAX = 2.6;   // longest turn, s
const TURN_GAP = 0.25;       // beat between speakers, s
const PHRASE_COOL = 3.5;     // pause between phrase groups, s

export class PairVocals {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  private readonly convos: Convo[] = [];
  private stopped = false;
  /** Instance stream seed for deriving per-exchange seeds. */
  private readonly streamSeed: number;
  /** Count of exchanges spawned, mixing determinism into default seeds. */
  private spawnSeq = 0;

  constructor(ctx: AudioContext, destination: AudioNode, seed = DEFAULT_PAIR_SEED) {
    this.ctx = ctx;
    this.out = destination;
    this.streamSeed = (seed ^ PAIR_SALT) >>> 0;
  }

  /**
   * Spawn one A/B exchange at a world position pair.
   * @param ax anchor A x (meters)
   * @param az anchor A z
   * @param bx anchor B x
   * @param bz anchor B z
   * @param seed optional deterministic seed; defaults to a hash of the
   *             instance stream seed and the spawn sequence number
   */
  spawn(ax: number, az: number, bx: number, bz: number, seed?: number): void {
    if (this.stopped) return;
    const s = (seed ?? hash2i(this.spawnSeq++, this.streamSeed)) >>> 0;
    const convo: Convo = {
      ax, az, bx, bz,
      a: this.buildSpeaker(s),
      b: this.buildSpeaker(s ^ 0x9e3779b9),
      rng: mulberry32((s ^ TURN_SALT) >>> 0),
      phase: 'exchange',
      speaker: 0,
      timeLeft: 0,
      coolLeft: 0.15,
      turns: 0,
    };
    this.convos.push(convo);
  }

  /**
   * Per-frame tick: advances turn-taking and schedules quiet syllable
   * envelopes for whoever holds the floor.
   * @param dt seconds since the previous frame
   */
  update(dt: number): void {
    if (this.stopped || this.convos.length === 0) return;
    const now = this.ctx.currentTime;

    for (const c of this.convos) {
      if (c.phase === 'parting') {
        c.coolLeft -= dt;
        if (c.coolLeft <= 0) c.phase = 'approach';
        continue;
      }
      c.timeLeft -= dt;
      c.coolLeft -= dt;
      if (c.timeLeft <= 0 && c.coolLeft <= 0) {
        // hand the floor over
        c.speaker = c.speaker === 0 ? 1 : 0;
        c.turns++;
        c.timeLeft = UTTERANCE_MIN + c.rng() * (UTTERANCE_MAX - UTTERANCE_MIN);
        c.coolLeft = c.turns % 4 === 0 ? PHRASE_COOL : TURN_GAP;
        if (c.turns > 12) { c.phase = 'parting'; c.coolLeft = PHRASE_COOL; }
      }
      const who = c.speaker === 0 ? c.a : c.b;
      if (who.nextAt < now - 0.5) who.nextAt = now;
      while (who.nextAt < now + 0.3) {
        const syl = 0.14 + who.rnd() * 0.16;
        const peak = 0.03 + who.rnd() * 0.03;
        who.env.gain.setTargetAtTime(peak, who.nextAt, 0.03);
        who.env.gain.setTargetAtTime(0.0001, who.nextAt + syl, 0.06);
        who.nextAt += syl + 0.04 + who.rnd() * 0.1;
      }
      // the listening partner stays hushed
      const other = c.speaker === 0 ? c.b : c.a;
      other.env.gain.setTargetAtTime(0.0001, now, 0.05);
    }

    // retire exchanges that wandered into their long cooldown twice over
    for (let i = this.convos.length - 1; i >= 0; i--) {
      const c = this.convos[i];
      if (c.phase === 'approach') {
        this.disposeConvo(c);
        this.convos.splice(i, 1);
      }
    }
  }

  /**
   * Distance-aware master trim applied by the positional bus upstream is
   * expected; this stop halts every voice and forgets all exchanges.
   */
  stop(): void {
    this.stopped = true;
    for (const c of this.convos) {
      c.a.env.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.05);
      c.b.env.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.05);
      this.disposeConvo(c);
    }
    this.convos.length = 0;
  }

  /** Diagnostics snapshot for tests and wiring. */
  debugState(): ConvoDebug[] {
    return this.convos.map((c) => ({
      phase: c.phase,
      ax: c.ax, az: c.az,
      bx: c.bx, bz: c.bz,
      speaker: c.speaker,
      timeLeft: c.timeLeft,
      coolLeft: c.coolLeft,
      turns: c.turns,
    }));
  }

  // ---------------------------------------------------------------------------

  private buildSpeaker(seed: number): Speaker {
    const ctx = this.ctx;
    const rnd = mulberry32(seed);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 90 + rnd() * 70;

    const formants: BiquadFilterNode[] = [];
    for (let f = 0; f < 2; f++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f === 0 ? 500 + rnd() * 400 : 1600 + rnd() * 700;
      bp.Q.value = 7;
      formants.push(bp);
    }
    const env = ctx.createGain();
    env.gain.value = 0;
    const pan = (ctx as AudioContext & { createStereoPanner(): StereoPannerNode }).createStereoPanner();
    pan.pan.value = rnd() * 1.4 - 0.7;

    for (const bp of formants) { osc.connect(bp); bp.connect(env); }
    env.connect(pan);
    pan.connect(this.out);
    osc.start();

    return { osc, formants, env, pan, rnd, nextAt: 0 };
  }

  private disposeConvo(c: Convo): void {
    try { c.a.osc.stop(); } catch { /* already stopped */ }
    try { c.b.osc.stop(); } catch { /* already stopped */ }
  }
}
