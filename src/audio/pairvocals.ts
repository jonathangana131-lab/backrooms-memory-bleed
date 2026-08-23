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
 */

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

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /**
   * Spawn one A/B exchange at a world position pair.
   * @param ax anchor A x (meters)
   * @param az anchor A z
   * @param bx anchor B x
   * @param bz anchor B z
   * @param seed optional deterministic seed for the voice characters
   */
  spawn(ax: number, az: number, bx: number, bz: number, seed = Math.floor(Math.random() * 0xffffffff)): void {
    if (this.stopped) return;
    const convo: Convo = {
      ax, az, bx, bz,
      a: this.buildSpeaker(seed),
      b: this.buildSpeaker(seed ^ 0x9e3779b9),
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
        c.timeLeft = UTTERANCE_MIN + Math.random() * (UTTERANCE_MAX - UTTERANCE_MIN);
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
