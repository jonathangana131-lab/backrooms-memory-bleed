/**
 * Fluorescent hum harmonic enrichment for BACKROOMS: MEMORY BLEED.
 *
 * Sits alongside AudioEngine's raw 120 Hz bed and makes the lights feel
 * like real electrics instead of clean test tones. Fully procedural,
 * no assets:
 *
 *   HARMONICS   subtle odd-harmonic series under the hum: 180 / 300 /
 *               420 Hz (the 3rd/5th/7th of the 60 Hz mains fundamental)
 *               at -12 / -18 / -24 dB relative — the signature "old
 *               ballast" colouration of cheap fluorescent iron.
 *   BEATS       with two or more fixtures audible, a near-identical twin
 *               voice detuned 0.5-2 Hz sums against the first, producing
 *               the slow wah-wah-wah amplitude beat of two fittings that
 *               were never quite the same.
 *   AGE WARBLE  old fixtures drift: a very slow LFO wobbles the
 *               fundamental up to +/-0.5%. How much depends on the
 *               district profile (pristine office wing vs. dying deep
 *               levels).
 *
 * Levels stay deliberately low: this layer colours the existing hum, it
 * never replaces it.
 *
 * F36 MELODY LEAKS: when a caller injects prior-run seeds via
 * enableMotifLeaks(), each seed deterministically derives a short pitch
 * motif (4-7 notes) and the layer occasionally quotes one note by
 * retuning the twin voice's glide target for a moment before handing it
 * back to the plain beat detune. Without that call the layer is exactly
 * its pre-F36 self.
 */
// --- mirrored deterministic helpers (tiledisplace.ts precedent: local copies
// --- of src/core/rng.ts so the module stays dependency-free under direct
// --- node strip-types test imports; algorithms identical to the RNG law) ----

function hash2i(x: number, y: number, salt = 0): number {
  let h = salt | 0;
  const hl = (v: number): number => {
    v |= 0;
    v = Math.imul(v ^ (v >>> 16), 0x85ebca6b);
    v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
    return (v ^ (v >>> 16)) >>> 0;
  };
  h = Math.imul(h ^ hl(x | 0), 0x9e3779b1);
  h = Math.imul(h ^ hl(y | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Sequential draw stream, algorithm-identical to src/core/rng.ts RNG. */
class RngStream {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(minIncl: number, maxExcl: number): number {
    return Math.floor(this.range(minIncl, maxExcl));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}


/** Mains fundamental the harmonic series hangs off. */
export const HUM_FUNDAMENTAL = 60;

/** Absolute linear level of the fundamental partial at full fixture count. */
export const HUM_REF_LEVEL = 0.04;

/** Odd harmonics as multiples of the fundamental, with relative levels in dB. */
export const ODD_HARMONICS = [
  { multiple: 3, db: -12 }, // 180 Hz
  { multiple: 5, db: -18 }, // 300 Hz
  { multiple: 7, db: -24 }, // 420 Hz
] as const;

/** Amplitude ratio for a level given in dB. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Maximum pitch instability of a fully-aged fixture (+/-0.5%). */
export const MAX_WARBLE = 0.005;

/** Allowed beat window between the two fixture voices, in Hz. */
export const BEAT_MIN = 0.5;
export const BEAT_MAX = 2.0;

/** How loud the twin (beating) voice sits against the lead voice. */
const BEAT_MIX = 0.55;

/** Extra harmonic warmth an end-of-life fixture develops (up to +40%). */
const AGE_HARMONIC_BOOST = 0.4;

/** Smoothing time constant for level moves (seconds). */
const LEVEL_TAU = 0.25;

// --- F36 melody leaks --------------------------------------------------------

/** Hash salt separating motif derivation from every other RNG use. */
export const MOTIF_LEAK_SALT = 0x6d17;

/** Seconds between quote opportunities (seeded draw inside this window). */
export const QUOTE_MIN_INTERVAL_S = 4;
export const QUOTE_MAX_INTERVAL_S = 9;

/** How long a quoted note holds before the beat detune resumes (seconds). */
export const QUOTE_HOLD_MIN_S = 1.2;
export const QUOTE_HOLD_MAX_S = 2.8;

/**
 * Prior-run melody-leak configuration. The same prior-seed list always
 * derives the same motif set and the same quote stream.
 */
export interface MotifLeakConfig {
  /** Prior-run world seeds whose motif material may be quoted. */
  priorSeeds: readonly number[];
  /** Probability [0..1] that a quote opportunity actually quotes a note. */
  quoteProbability: number;
}

/** Record of one motif quote, exposed for tests and telemetry. */
export interface QuotedMotif {
  /** Prior-run seed the quoted motif derives from. */
  seed: number;
  /** Full pitch-ratio motif of that seed (relative to HUM_FUNDAMENTAL). */
  notesHz: number[];
  /** Index of the note that sounded. */
  noteIndex: number;
  /** AudioContext time at which the quote was scheduled. */
  atTime: number;
}

/**
 * Deterministically derive one seed's pitch motif: 4-7 semitone-step ratios
 * within an octave of the fundamental, never unison (ratio 1.0 would be
 * indistinguishable from the lead voice). Pure function of the seed.
 */
export function deriveMotifNotes(seed: number): number[] {
  const rng = new RngStream(hash2i(seed | 0, MOTIF_LEAK_SALT));
  const count = rng.int(4, 8);
  const notes: number[] = [];
  for (let i = 0; i < count; i++) {
    let st = rng.int(-12, 12);
    if (st >= 0) st += 1; // skip unison: {-12..-1, 1..12}
    notes.push(Math.pow(2, st / 12));
  }
  return notes;
}

/** Per-district fixture character. age drives warble + harmonic dirt. */
interface DistrictProfile {
  /** 0 = freshly installed .. 1 = end of life. */
  age: number;
  /** Overall loudness trim for the district's wiring. */
  level: number;
}

const DISTRICT_PROFILES: Record<number, DistrictProfile> = {
  0: { age: 0.12, level: 1.0 },  // pristine entry offices
  1: { age: 0.42, level: 0.94 },
  2: { age: 0.68, level: 0.88 },
  3: { age: 0.93, level: 0.8 },  // deep, dying levels
  4: { age: 0.88, level: 0.82 }, // STORAGE canyons: hoarded, half-dead wiring
};

/**
 * District ages align with the visual age ladder (fog density presets,
 * dead-light bias, per-district tint dimming): STORAGE - visually the
 * dustiest, dimmest district - carries an explicit near-end-of-life profile
 * instead of silently falling back to DEFAULT_PROFILE's mid age. The table
 * keys on district alone; contamination-proportional aging (memIntensity
 * biases dead/flickering fixtures in architect.generateLights) has no audio
 * hook yet - HumHarmonics.setDistrict() is the seam where a
 * contamination-adjusted profile would enter.
 */

const DEFAULT_PROFILE: DistrictProfile = { age: 0.5, level: 0.95 };

/** One fixture voice: fundamental + odd harmonics summed into a root gain. */
interface Voice {
  root: GainNode;
  /** One oscillator per partial; index 0 is the fundamental. */
  oscs: OscillatorNode[];
  /** Matching per-partial gains (relative weights; root carries level). */
  gains: GainNode[];
}

export class HumHarmonics {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;

  private readonly voiceA: Voice;
  private readonly voiceB: Voice;

  /** Shared slow LFO wobbling both fundamentals (fixture-age warble). */
  private readonly warble: OscillatorNode;
  private readonly warbleDepth: GainNode;

  private fixtureCount = 0;
  private district = -1;

  /** Current beat offset between the voices (Hz difference of fundamentals). */
  private beatDelta = BEAT_MIN + Math.random() * (BEAT_MAX - BEAT_MIN);

  /** Seconds until the beat drifts to a new offset (fixtures never agree). */
  private driftIn = 10 + Math.random() * 10;

  private stopped = false;

  // --- F36 melody-leak state (fully inert until enableMotifLeaks) ---
  private leakSeeds: number[] = [];
  private readonly leakNotes = new Map<number, number[]>();
  private leakProbability = 0;
  private quoteRng: RngStream | null = null;
  private quoteIn = Number.POSITIVE_INFINITY;
  private quoteHoldLeft = 0;
  private lastQuote: QuotedMotif | null = null;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.voiceA = this.buildVoice(HUM_FUNDAMENTAL);
    this.voiceB = this.buildVoice(HUM_FUNDAMENTAL + this.beatDelta);

    // Slow shared warble: one wobble generator feeding both fundamentals,
    // because fixtures on the same circuit sag together. The LFO runs into
    // a depth gain whose gain parameter IS the warble depth in Hz.
    this.warble = ctx.createOscillator();
    this.warble.type = 'sine';
    this.warble.frequency.value = 0.07 + Math.random() * 0.06; // 0.07-0.13 Hz
    this.warbleDepth = ctx.createGain();
    this.warbleDepth.gain.value = 0;
    this.warble.connect(this.warbleDepth);
    this.warbleDepth.connect(this.voiceA.oscs[0].frequency);
    this.warbleDepth.connect(this.voiceB.oscs[0].frequency);

    // Twin sits a touch quieter than the lead.
    this.voiceB.root.gain.value = 0;
    void BEAT_MIX; // documented mix intent; the sqrt fixture curve carries level

    this.warble.start();

    // Wire the audible chain LAST so the graph reads cleanly end to end:
    // partial -> voice root -> layer bus -> destination.
    this.voiceA.root.connect(this.out);
    this.voiceB.root.connect(this.out);
    this.out.connect(destination);
  }

  /** District profile for the current district id (unknown ids fall back). */
  private profile(): DistrictProfile {
    return DISTRICT_PROFILES[this.district] ?? DEFAULT_PROFILE;
  }

  /** Relative weight of one odd-harmonic partial at the current district age. */
  private harmonicWeight(db: number): number {
    return dbToGain(db) * (1 + AGE_HARMONIC_BOOST * this.profile().age);
  }

  /** Build one fixture voice: fundamental + odd harmonics into a muted root. */
  private buildVoice(fundamentalHz: number): Voice {
    const root = this.ctx.createGain();
    root.gain.value = 0; // silent until setFixtureCount speaks

    const oscs: OscillatorNode[] = [];
    const gains: GainNode[] = [];

    const mk = (freq: number, weight: number): void => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.value = weight;
      osc.connect(g);
      g.connect(root);
      osc.start();
      oscs.push(osc);
      gains.push(g);
    };

    mk(fundamentalHz, 1);
    for (const h of ODD_HARMONICS) mk(fundamentalHz * h.multiple, this.harmonicWeight(h.db));
    return { root, oscs, gains };
  }

  /**
   * Select the district character.
   * @param district district ordinal from world/constants.ts
   */
  setDistrict(district: number): void {
    this.district = district;
    this.scheduleProfileTargets();
  }

  /**
   * Enable prior-run melody leaks (F36). Deterministic: the same seed list
   * always yields the same motif set and the same quote stream.
   * @param config prior-run seeds + quote probability [0..1]
   */
  enableMotifLeaks(config: MotifLeakConfig): void {
    const seeds = [...new Set(config.priorSeeds.map((s) => s | 0))].sort((a, b) => a - b);
    this.leakSeeds = seeds;
    this.leakNotes.clear();
    let acc = (MOTIF_LEAK_SALT ^ seeds.length) >>> 0;
    for (const s of seeds) {
      this.leakNotes.set(s, deriveMotifNotes(s));
      acc = hash2i(acc, s);
    }
    const p = config.quoteProbability;
    this.leakProbability = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
    this.quoteRng = new RngStream(acc);
    this.quoteIn = this.quoteRng.range(QUOTE_MIN_INTERVAL_S, QUOTE_MAX_INTERVAL_S);
    this.quoteHoldLeft = 0;
  }

  /** Record of the most recent motif quote, or null when none has happened. */
  lastQuotedMotif(): QuotedMotif | null {
    return this.lastQuote;
  }

  /**
   * How many fixtures are currently lit nearby (drives loudness + beat twin).
   * @param count lit fluorescent fixtures within earshot
   */
  setFixtureCount(count: number): void {
    this.fixtureCount = Math.max(0, count);
    this.scheduleLevels();
    this.scheduleProfileTargets();
  }

  /** Per-frame tick: beat drift + refreshed smoothed targets. */
  update(dt: number): void {
    if (this.stopped) return;

    this.driftIn -= dt;
    if (this.driftIn <= 0) {
      this.driftIn = 10 + Math.random() * 10;
      this.beatDelta = BEAT_MIN + Math.random() * (BEAT_MAX - BEAT_MIN);
      this.voiceB.oscs[0].frequency.setValueAtTime(HUM_FUNDAMENTAL + this.beatDelta, this.ctx.currentTime);
    }
    this.updateMotifLeaks(dt);
    this.scheduleLevels();
    this.scheduleProfileTargets();
  }

  /** Silence everything and release sources; the instance will not restart. */
  stop(): void {
    this.stopped = true;
    for (const v of [this.voiceA, this.voiceB]) {
      for (const o of v.oscs) { try { o.stop(); } catch { /* already stopped */ } }
    }
    try { this.warble.stop(); } catch { /* already stopped */ }
  }

  // ---------------------------------------------------------------------------

  /**
   * F36 quote scheduler: occasionally retunes the twin voice's glide target
   * to a motif note for a seeded hold, then hands it back to the plain beat
   * detune. Inert unless enableMotifLeaks() ran.
   */
  private updateMotifLeaks(dt: number): void {
    if (!this.quoteRng || this.leakSeeds.length === 0) return;
    if (this.quoteHoldLeft > 0) {
      this.quoteHoldLeft -= dt;
      if (this.quoteHoldLeft <= 0) {
        this.voiceB.oscs[0].frequency.setValueAtTime(
          HUM_FUNDAMENTAL + this.beatDelta,
          this.ctx.currentTime,
        );
      }
      return;
    }
    this.quoteIn -= dt;
    if (this.quoteIn > 0) return;
    this.quoteIn = this.quoteRng.range(QUOTE_MIN_INTERVAL_S, QUOTE_MAX_INTERVAL_S);
    if (!this.quoteRng.chance(this.leakProbability)) return;
    const seed = this.leakSeeds[this.quoteRng.int(0, this.leakSeeds.length)];
    const notes = this.leakNotes.get(seed);
    if (!notes || notes.length === 0) return;
    const noteIndex = this.quoteRng.int(0, notes.length);
    const hz = HUM_FUNDAMENTAL * notes[noteIndex];
    this.voiceB.oscs[0].frequency.setValueAtTime(hz, this.ctx.currentTime);
    this.quoteHoldLeft = this.quoteRng.range(QUOTE_HOLD_MIN_S, QUOTE_HOLD_MAX_S);
    this.lastQuote = {
      seed,
      noteIndex,
      notesHz: notes.slice(),
      atTime: this.ctx.currentTime,
    };
  }

  private scheduleLevels(): void {
    const t = this.ctx.currentTime;
    const lvl = Math.min(HUM_REF_LEVEL, (HUM_REF_LEVEL * Math.sqrt(Math.max(0, this.fixtureCount))) / 2);
    const lead = this.fixtureCount > 0 ? lvl : 0;
    const twin = this.fixtureCount >= 2 ? lvl : 0;
    this.voiceA.root.gain.setTargetAtTime(lead, t, LEVEL_TAU);
    this.voiceB.root.gain.setTargetAtTime(twin, t, LEVEL_TAU);
  }

  private scheduleProfileTargets(): void {
    const t = this.ctx.currentTime;
    const lit = this.fixtureCount > 0 ? 1 : 0;
    const depth = lit ? this.profile().age * MAX_WARBLE * HUM_FUNDAMENTAL : 0;
    for (const v of [this.voiceA, this.voiceB]) {
      for (let i = 0; i < ODD_HARMONICS.length; i++) {
        v.gains[i + 1].gain.setTargetAtTime(this.harmonicWeight(ODD_HARMONICS[i].db), t, LEVEL_TAU);
      }
    }
    this.warbleDepth.gain.setTargetAtTime(depth, t, LEVEL_TAU);
  }
}
