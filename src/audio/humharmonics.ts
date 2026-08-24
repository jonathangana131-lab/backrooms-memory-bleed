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
 */

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
