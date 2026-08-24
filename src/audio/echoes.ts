/**
 * Relocation echoes for BACKROOMS: MEMORY BLEED.
 *
 * Wherever the player relocates (teleports, phase-shifts), the place remembers.
 * Feed each departure point in via markSite; afterwards, walking back within 15 m
 * of one plays faint audio memories:
 *
 *   FRAGMENTS  bandpass-filtered noise bursts with a REVERSE envelope - the
 *              amplitude swells across the whole burst then cuts dead, like tape
 *              rewound. Two parallel formant bands (vowel table borrowed from
 *              radio.ts) make the noise read as a whisper, not static.
 *   ESCALATION the site counts visits (enter/leave with hysteresis):
 *                1st visit  -> one lone fragment, long gaps
 *                2nd visit  -> two overlapping fragments, shorter gaps
 *                3rd visit+ -> continuous murmuring bed under the bursts
 *   TIE-IN     getIntensity(x, z) exposes 0..1 proximity x escalation so the
 *              renderer can bleed a matching screen effect.
 *
 * Every site hashes its world position to a seed (same trick as radio.ts) so its
 * pan, filter colour and pacing are stable: the same corner always whispers the
 * same way.
 *
 * Fully procedural: white-noise buffers through biquads, no asset files.
 * The AudioContext is optional at construction; without one the class runs
 * logic-only (proximity, visit counting, getIntensity) and stays silent - which
 * is also how the headless test exercises it.
 */

/** Deterministic PRNG so a site always sounds like itself (cf. radio.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Position hash -> 32-bit seed (FNV-1a over both float bit patterns). */


export function positionSeed(x: number, z: number): number {
  const xf = new Float64Array(1); xf[0] = x;
  const zf = new Float64Array(1); zf[0] = z;
  const bytes = new Uint8Array(xf.buffer.byteLength * 2);
  bytes.set(new Uint8Array(xf.buffer), 0);
  bytes.set(new Uint8Array(zf.buffer), 8);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Rough vowel formant targets (Hz), reused for whisper colouring. */
const VOWELS: readonly { f1: number; f2: number }[] = [
  { f1: 800, f2: 1150 },
  { f1: 450, f2: 1750 },
  { f1: 300, f2: 2100 },
  { f1: 420, f2: 800 },
];

const ENTER_RADIUS = 15; // metres: inside this, the site wakes
const EXIT_RADIUS = 22;  // metres: must leave this far before the next visit counts
const MIN_SPACING = 10;  // metres: ignore marks this close to an existing site

/** Escalation weight per visit tier: how insistent the memory is. */
function escalation(visits: number): number {
  if (visits <= 0) return 0;
  if (visits === 1) return 0.35;
  if (visits === 2) return 0.65;
  return 1;
}

interface EchoSite {
  x: number;
  z: number;
  /** Re-entry count: how many times the player came back after leaving. */
  visits: number;
  /** True while far enough away that the next entry counts as a revisit. */
  armed: boolean;
  /** True while currently within ENTER_RADIUS. */
  inside: boolean;
  /** Local-clock time of the next scheduled fragment burst. */
  nextBurstAt: number;
  seed: number;
  rnd: () => number;
  /** Per-site persistent murmur voice, built lazily (tier 3+ only). */
  murmur: MurmurVoice | null;
}

/**
 * Structural minimum of a tier-3 murmur voice: a small formant bed bound
 * to one echo site, eased per frame toward a target level. Implementations
 * degrade silently; the site treats null as "voice not built yet".
 */
interface MurmurVoice {
  /** Per-frame level/position update. */
  update(dt: number, level: number): void;
  /** Release all nodes; the instance never restarts. */
  stop(): void;
}

/** Master level for the tier-3 murmur bed: present, never forward. */
const MURMUR_MASTER = 0.05;

/**
 * Concrete tier-3 murmur voice: one glottal sawtooth through two parallel
 * bandpass formant filters (the crowd.ts technique, borrowed and thinned),
 * panned by its site's bearing. Syllables are scheduled look-ahead style
 * with peaks near the noise floor so nothing resolves into language --
 * just someone talking in a room that was demolished years ago.
 */
class SiteMurmur implements MurmurVoice {
  private readonly ctx: AudioContext;
  private readonly osc: OscillatorNode;
  private readonly env: GainNode;
  private readonly formants: BiquadFilterNode[];
  private readonly panner: StereoPannerNode;
  private readonly rnd: () => number;
  private nextSylAt = 0;
  private stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode, seed: number, pan: number) {
    this.ctx = ctx;
    const rnd = mulberry32(seed ^ 0x6d757252);
    this.rnd = rnd;

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 60 + rnd() * 50; // low glottal source

    // two parallel vowel formants give the source its voiced colour
    this.formants = [];
    for (let f = 0; f < 2; f++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      const vowel = VOWELS[Math.floor(rnd() * VOWELS.length)];
      bp.frequency.value = f === 0 ? vowel.f1 : vowel.f2;
      bp.Q.value = 7 + rnd() * 5;
      this.osc.connect(bp);
      this.formants.push(bp);
    }

    this.env = ctx.createGain();
    this.env.gain.value = 0;
    for (const bp of this.formants) bp.connect(this.env);

    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = Math.max(-1, Math.min(1, pan));
    this.env.connect(this.panner);
    this.panner.connect(destination);
    this.nextSylAt = ctx.currentTime + 0.2;
    this.osc.start();
  }

  /**
   * Ease the bed toward 'level' (0..1 pre-master) and schedule syllables
   * look-ahead style while audible. Never throws.
   */
  update(dt: number, level: number): void {
    if (this.stopped) return;
    void dt;
    try {
      const now = this.ctx.currentTime;
      this.env.gain.setTargetAtTime(level * MURMUR_MASTER, now, 0.6);
      if (level <= 0.002) {
        this.nextSylAt = Math.max(this.nextSylAt, now + 0.2);
        return;
      }
      const horizon = now + 0.35;
      while (this.nextSylAt < horizon) {
        const syl = 0.16 + this.rnd() * 0.14; // slow, slurred cadence
        const peak = 0.25 + this.rnd() * 0.5; // relative within the bed
        this.env.gain.setTargetAtTime(peak * level * MURMUR_MASTER, this.nextSylAt, 0.04);
        this.env.gain.setTargetAtTime(0.02 * level * MURMUR_MASTER, this.nextSylAt + syl, 0.08);
        // drift one formant toward another vowel now and then
        if (this.rnd() < 0.55) {
          const which = Math.floor(this.rnd() * 2);
          const vowel = VOWELS[Math.floor(this.rnd() * VOWELS.length)];
          this.formants[which].frequency.setTargetAtTime(
            which === 0 ? vowel.f1 : vowel.f2, this.nextSylAt, 0.25,
          );
        }
        this.nextSylAt += syl + 0.06 + this.rnd() * 0.15;
      }
    } catch (e) {
      console.warn('[bmb] echo murmur failed', e);
    }
  }

  /** Release every node; the instance never restarts. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.osc.stop(); } catch { /* already stopped */ }
  }
}

/**
 * Relocation echo sites. markSite() records where the player was torn away
 * from; walking back within ENTER_RADIUS wakes the memory, and each revisit
 * escalates it -- one lone fragment, then an overlapping pair, then the
 * continuous murmur bed. getIntensity() exposes proximity x escalation for
 * renderer tie-ins. Without an AudioContext the class runs logic-only
 * (proximity, visit counting, cues) and stays silent.
 */
export class EchoSites {
  /** All registered sites (public for tests/debug overlays). */
  readonly sites: EchoSite[] = [];

  /** Internal-clock time of the most recent fragment burst. */
  lastCueAt = 0;
  /** How many fragments the most recent burst layered (1 or 2). */
  lastCueCount = 0;
  /** True while any tier-3 site is currently inside its ring. */
  murmurActive = false;

  private clock = 0;
  private stopped = false;
  private noiseBuf: AudioBuffer | null = null;

  private readonly ctx: AudioContext | undefined;
  private readonly destination: AudioNode | undefined;

  constructor(ctx?: AudioContext, destination?: AudioNode | null) {
    this.ctx = ctx;
    this.destination = destination ?? undefined;
  }

  /**
   * Register a departure point as an echo site. Marks landing within
   * MIN_SPACING of an existing site are absorbed into it.
   */
  markSite(x: number, z: number): void {
    for (const s of this.sites) {
      if (Math.hypot(s.x - x, s.z - z) < MIN_SPACING) return;
    }
    const seed = positionSeed(x, z);
    this.sites.push({
      x, z,
      visits: 0,
      armed: true,
      inside: false,
      nextBurstAt: Infinity,
      seed,
      rnd: mulberry32(seed),
      murmur: null,
    });
  }

  /**
   * Proximity x escalation for the loudest awake site, clamped to 0..1.
   * Sites never visited report nothing -- no memory, no bleed.
   */
  getIntensity(px: number, pz: number): number {
    let best = 0;
    for (const s of this.sites) {
      if (s.visits <= 0) continue;
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d >= ENTER_RADIUS) continue;
      best = Math.max(best, (1 - d / ENTER_RADIUS) * escalation(s.visits));
    }
    return Math.min(1, best);
  }

  /**
   * Per-frame tick: hysteresis enter/exit, fragment burst scheduling and
   * the tier-3 murmur bed. Ignores non-positive dt; silent after stop().
   */
  update(dt: number, px: number, pz: number): void {
    if (this.stopped || dt <= 0) return;
    this.clock += dt;
    this.murmurActive = false;

    for (const s of this.sites) {
      const d = Math.hypot(s.x - px, s.z - pz);
      if (!s.inside && d <= ENTER_RADIUS) {
        s.inside = true;
        s.armed = false;
        s.visits++;
        s.nextBurstAt = this.clock + 0.1 + s.rnd() * 0.4;
      } else if (d > EXIT_RADIUS) {
        s.inside = false;
        s.armed = true;
      }

      if (!s.inside) continue;

      // scheduled fragment bursts: lone fragment, then overlapping pairs
      if (this.clock >= s.nextBurstAt) {
        this.lastCueAt = this.clock;
        this.lastCueCount = s.visits >= 2 ? 2 : 1;
        s.nextBurstAt = this.clock + (s.visits === 1 ? 1.9 + s.rnd() * 1.3 : 1.2 + s.rnd() * 0.8);
        if (this.ctx && this.destination) this.playFragments(s, px, this.lastCueCount);
      }

      // tier 3+: the place starts murmuring under the bursts
      if (s.visits >= 3) {
        this.murmurActive = true;
        if (!s.murmur && this.ctx && this.destination) {
          const pan = Math.max(-1, Math.min(1, (px - s.x) / ENTER_RADIUS));
          s.murmur = new SiteMurmur(this.ctx, this.destination, s.seed, pan);
        }
        s.murmur?.update(dt, this.getIntensity(px, pz));
      } else if (s.murmur) {
        s.murmur.update(dt, 0);
      }
    }
  }

  /** Halt everything and release all murmur voices; instance is dead. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.murmurActive = false;
    for (const s of this.sites) {
      s.murmur?.stop();
      s.murmur = null;
    }
  }

  /**
   * Render 'count' whisper fragments: bandpassed noise with a REVERSE
   * envelope -- the swell grows across the whole burst then cuts dead.
   * Two parallel vowel formants make the noise read as a whisper.
   */
  private playFragments(s: EchoSite, px: number, count: number): void {
    const ctx = this.ctx!;
    try {
      if (!this.noiseBuf) {
        // shared white-noise source material; DSP fill exempt from sim PRNG law
        const len = Math.floor(ctx.sampleRate * 2);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        this.noiseBuf = buf;
      }
      const basePan = Math.max(-1, Math.min(1, (px - s.x) / ENTER_RADIUS));
      for (let i = 0; i < count; i++) {
        this.fragment(s, ctx.currentTime + 0.01 + i * 0.19, basePan);
      }
    } catch (e) {
      console.warn('[bmb] echo fragments failed', e);
    }
  }

  /** One reverse-envelope whisper burst for site 's'. */
  private fragment(s: EchoSite, at: number, basePan: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf!;
    src.loop = true;
    src.playbackRate.value = 0.8 + s.rnd() * 0.4;

    // two parallel vowel bands colour the noise into a whisper
    const dur = 0.35 + s.rnd() * 0.3;
    const v1 = VOWELS[Math.floor(s.rnd() * VOWELS.length)];
    const v2 = VOWELS[Math.floor(s.rnd() * VOWELS.length)];
    const bands: BiquadFilterNode[] = [];
    const picks = [v1.f1, v2.f2] as const;
    for (const hz of picks) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = hz;
      bp.Q.value = 6 + s.rnd() * 4;
      src.connect(bp);
      bands.push(bp);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    // REVERSE envelope: swell across the whole burst, then cut dead
    g.gain.linearRampToValueAtTime(0.05 + s.rnd() * 0.03, at + dur);
    g.gain.setValueAtTime(0.0001, at + dur + 0.001);

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, basePan + (s.rnd() * 0.4 - 0.2)));

    for (const bp of bands) bp.connect(g);
    g.connect(panner);
    panner.connect(this.destination!);
    src.start(at);
    src.stop(at + dur + 0.05);
  }
}


