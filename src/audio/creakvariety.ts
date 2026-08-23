/**
 * Door creak character variety for BACKROOMS: MEMORY BLEED.
 *
 * The base AudioEngine creak is one voice; real doors are a zoo. This
 * module seeds FOUR door characters from the world seed and renders each
 * as its own tiny procedural graph — no asset files:
 *
 *   wooden  classic hinge squeal: one sawtooth sweeping ~80 -> ~140 Hz
 *           through a mid lowpass, wobbling at hinge rate
 *   metal   strained steel: faster ~200 -> ~350 Hz sweep plus a sine
 *           RING tail that hangs after the body stops
 *   vault   bank-vault mass: ONE deep ~40 Hz grind lasting seconds
 *   screen  wire-screen rattle: a volley of short separate bursts
 *
 * Seeded consistency: the same world seed always produces the same
 * personality tables (frequency bands, durations, burst counts); each
 * individual PLAY adds +-10% micro-variation so no two creaks are
 * byte-identical either. Distance attenuates volume with a squared law
 * beyond 5 m and closes the lowpass with it.
 */

/** Stable string hash (FNV-1a + murmur finalizer), local to this module so
 *  the file stays directly runnable under node's TypeScript stripping. */
function hashStr(s: string, seed: number): number {
  let h = seed ^ 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
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

/** The four door characters. */
export type CreakKind = 'wooden' | 'metal' | 'vault' | 'screen';

/** All CreakKinds, in table order. */
export const CREAK_KINDS: readonly CreakKind[] = ['wooden', 'metal', 'vault', 'screen'];

/** Seeded parameters describing one door character. */
export interface CreakPersonality {
  /** sweep start frequency, Hz */
  fLo: number;
  /** sweep top frequency, Hz */
  fHi: number;
  /** audible duration, s */
  dur: number;
  /** hinge/ballast wobble rate, Hz */
  warbleRate: number;
  /** wobble depth as a fraction of the sweep */
  warbleDepth: number;
  /** envelope peak (linear gain) at unity distance */
  peak: number;
  /** lowpass cutoff at unity distance, Hz */
  cutoff: number;
  /** separate burst count (screen rattle) */
  bursts: number;
  /** seconds between bursts */
  gap: number;
}

/** Default world-seed salt for the personality tables. */
const DEFAULT_SEED = 0x67ea;

/** Distance past which attenuation begins (meters). */
const UNITY_DISTANCE_M = 5;

/** Ring-tail length added to the metal body (seconds). */
const METAL_RING_TAIL = 0.8;

/** Uniform pick from [min,max) through a seeded stream. */
function u(r: () => number, min: number, max: number): number {
  return min + r() * (max - min);
}

/** Build the four personality tables from a world seed. */
function buildPersonalities(seed: number): Record<CreakKind, CreakPersonality> {
  return {
    wooden: seedKind('wooden', seed, (r) => ({
      fLo: u(r, 72, 88),
      fHi: u(r, 128, 152),
      dur: u(r, 0.9, 1.5),
      peak: 0.05,
      cutoff: 1400,
    })),
    metal: seedKind('metal', seed, (r) => ({
      fLo: u(r, 192, 208),          // ~200 Hz
      fHi: u(r, 338, 362),          // ~350 Hz
      dur: u(r, 0.9, 1.25),
      warbleRate: u(r, 9, 13),
      warbleDepth: u(r, 1, 3),
      peak: 0.045,
      cutoff: 2600,
    })),
    vault: seedKind('vault', seed, (r) => ({
      fLo: u(r, 35, 45),
      fHi: u(r, 62, 78),
      dur: u(r, 3.2, 4.3),
      warbleRate: u(r, 1.5, 2.5),
      warbleDepth: u(r, 2, 4),
      peak: 0.06,
      cutoff: 380,
    })),
    screen: seedKind('screen', seed, (r) => ({
      fLo: u(r, 300, 420),
      fHi: u(r, 900, 1300),
      dur: u(r, 0.06, 0.1),
      warbleRate: u(r, 14, 20),
      warbleDepth: u(r, 0.5, 1.5),
      peak: 0.04,
      cutoff: 3400,
      bursts: Math.floor(u(r, 6, 9)),
      gap: u(r, 0.04, 0.12),
    })),
  };
}

function seedKind(
  kind: string,
  seed: number,
  fill: (r: () => number) => Partial<CreakPersonality> & Pick<CreakPersonality, 'fLo' | 'fHi' | 'dur' | 'peak' | 'cutoff'>,
): CreakPersonality {
  const r = mulberry32(hashStr(kind, seed));
  return Object.freeze({
    warbleRate: u(r, 3, 9),
    warbleDepth: u(r, 0.4, 1.4),
    bursts: 1,
    gap: 0,
    ...fill(r),
  } as CreakPersonality);
}

export class CreakVariety {
  private readonly destination: AudioNode | null;
  private readonly table: Record<CreakKind, CreakPersonality>;

  private ctxRef: AudioContext | null = null;
  private readonly live: OscillatorNode[] = [];
  private stopped = false;

  /** Parameters of the most recent play(), post micro-variation + distance. */
  lastVoice: CreakPersonality = Object.freeze({
    fLo: 0, fHi: 0, dur: 0, warbleRate: 0, warbleDepth: 0,
    peak: 0, cutoff: 0, bursts: 0, gap: 0,
  });

  constructor(ctx: AudioContext, destination: AudioNode | null, seed = DEFAULT_SEED) {
    this.ctxRef = ctx; // construction builds no graph; plays render lazily
    this.destination = destination;
    void seed;
    this.table = buildPersonalities(seed >>> 0 || DEFAULT_SEED);
  }

  /**
   * The seeded personality table.
   * @returns frozen record keyed by door character
   */
  personalities(): Record<CreakKind, CreakPersonality> {
    return this.table;
  }

  /**
   * One character's seeded parameters.
   * @param kind door character id
   */
  personalityOf(kind: CreakKind): CreakPersonality {
    return this.table[kind];
  }

  /**
   * Render one creak of the given character at a listener distance.
   * @param kind door character id
   * @param distanceM distance to the listener in meters (unity inside 5 m)
   */
  play(kind: CreakKind, distanceM: number): void {
    if (this.stopped || !this.ctxRef || !this.destination) return;
    const p = this.personalityOf(kind);
    // Per-play micro-variation: stays inside +-10%, never twice alike.
    const j = (v: number): number => v * (1 + (Math.random() * 0.16 - 0.08));
    const fLo = j(p.fLo);
    const fHi = Math.max(j(p.fHi), fLo * 1.15);

    // Distance: squared falloff past unity, lowpass closes alongside.
    const att = distanceM <= UNITY_DISTANCE_M ? 1 : Math.pow(UNITY_DISTANCE_M / distanceM, 2);
    const cAtt = distanceM <= UNITY_DISTANCE_M ? 1 : Math.max(0.22, UNITY_DISTANCE_M / distanceM);
    const peak = p.peak * att;
    const cutoff = p.cutoff * cAtt;

    let reported: number;
    if (kind === 'screen') reported = this.playScreen(p, fLo, fHi, cutoff, peak);
    else if (kind === 'metal') reported = this.playMetal(p, fLo, fHi, cutoff, peak);
    else reported = this.playSweep(kind, p.dur, fLo, fHi, cutoff, peak);

    this.lastVoice = Object.freeze({
      ...p, fLo, fHi, dur: reported, peak, cutoff,
    });
  }

  /** Halt every live source and refuse further plays. */
  stop(): void {
    this.stopped = true;
    for (const o of this.live) { try { o.stop(); } catch { /* already stopped */ } }
    this.live.length = 0;
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /**
   * One sawtooth sweep with hinge-wobble ramps: wooden and vault share this.
   * @returns the audible duration actually scheduled
   */
  private playSweep(
    kind: CreakKind,
    seedDur: number,
    fLo: number,
    fHi: number,
    cutoff: number,
    peak: number,
  ): number {
    const ctx = this.ctxRef!;
    const t = ctx.currentTime;
    const dur = Math.max(0.05, seedDur * (1 + (Math.random() * 0.16 - 0.08)));
    void kind;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const wobbles = dur > 2 ? 2 : 4;
    osc.frequency.setValueAtTime(fLo, t);
    for (let i = 1; i <= wobbles; i++) {
      const target = i % 2 === 1 ? fHi : fLo + (fHi - fLo) * 0.15;
      osc.frequency.linearRampToValueAtTime(target, t + (dur * i) / wobbles);
    }

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(0.08, dur * 0.15));
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.4), t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(lp);
    lp.connect(g);
    g.connect(this.destination!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    this.live.push(osc);
    return dur;
  }

  /** Metal body plus a sine ring tail that outlives the sweep. */
  private playMetal(
    p: CreakPersonality,
    fLo: number,
    fHi: number,
    cutoff: number,
    peak: number,
  ): number {
    const ctx = this.ctxRef!;
    const t = ctx.currentTime;
    const dur = p.dur * (1 + (Math.random() * 0.16 - 0.08));
    const total = dur + METAL_RING_TAIL;

    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(fLo, t);
    for (let i = 1; i <= 4; i++) {
      body.frequency.linearRampToValueAtTime(i % 2 === 1 ? fHi : fLo + (fHi - fLo) * 0.2, t + (dur * i) / 4);
    }

    const ring = ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = fHi * 2.7;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.03);
    g.gain.setValueAtTime(peak, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + total);

    body.connect(lp);
    ring.connect(lp);
    lp.connect(g);
    g.connect(this.destination!);
    body.start(t);
    body.stop(t + dur + 0.02);
    ring.start(t + dur * 0.5);
    ring.stop(t + total + 0.02);
    this.live.push(body, ring);
    return total;
  }

  /** A volley of exactly bursts short rattles — no other oscillators. */
  private playScreen(
    p: CreakPersonality,
    fLo: number,
    fHi: number,
    cutoff: number,
    peak: number,
  ): number {
    const ctx = this.ctxRef!;
    const t = ctx.currentTime;
    const burstDur = p.dur;
    const step = p.gap + burstDur * 0.6;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 1.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    lp.connect(g);
    g.connect(this.destination!);

    for (let i = 0; i < p.bursts; i++) {
      const start = t + i * step;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(fLo, start);
      osc.frequency.linearRampToValueAtTime(fHi, start + burstDur);
      osc.connect(lp);
      osc.start(start);
      osc.stop(start + burstDur + 0.01);
      g.gain.setValueAtTime(peak, start);
      g.gain.exponentialRampToValueAtTime(0.0001, start + burstDur);
      this.live.push(osc);
    }
    return p.bursts * step;
  }
}
