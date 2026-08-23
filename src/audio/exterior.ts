/**
 * Exterior bleed for BACKROOMS: MEMORY BLEED.
 *
 * There is no outside. But sometimes you hear one through the walls:
 * fragments of a world that should not be adjacent to here, arriving
 * pre-muffled as if through half a metre of wet concrete. Fully
 * procedural, no assets:
 *
 *   BIRDSONG   2-4 chirp sweeps (sine 2-4 kHz with a fast vibrato),
 *              lowpassed at 1200 Hz so only their ghost survives.
 *              Every 45-120 s of calm; tension chases the birds away.
 *   TRAFFIC    a whoosh passing on some impossible road: looped noise
 *              through a bandpass that sweeps up and back down while a
 *              pan drifts across stereo - approach, pass, recede.
 *              Rare: every 3-7 min.
 *   CHILDREN   very rare high calls - formant-babble fragments pitched
 *              up like a voice heard from a yard two walls away, then
 *              crushed under an extra lowpass. Once per 10-15 min.
 *   RAIN       during wet weather fronts a continuous patter layer of
 *              dense filtered noise swells in; when the front dries out
 *              it fades away over seconds.
 *
 * Everything routes through per-voice muffle filters at quiet levels -
 * these sounds never belong to this place, they only leak in.
 */

const TWO_PI = Math.PI * 2;

/**
 * How much of the outside each memory zone lets through. Domestic and
 * schoolyard memories remember windows; offices and hospitals remember
 * none. Unknown kinds default to a faint leak.
 */
const BLEED_BY_ZONE: Record<number, number> = {
  0: 0.55, // NONE      - the pure backrooms admit almost nothing
  1: 1.0,  // RESIDENCE - a home remembers its garden
  2: 0.6,  // OFFICE    - sealed plate glass
  3: 0.5,  // HOSPITAL  - hermetic wings
  4: 0.95, // SCHOOL    - a playground over the fence
  5: 0.75, // MALL      - skylights somewhere

(Showing lines 1-40 of 412. Use offset=41 to continue.)

  6: 0.7,  // TRANSIT   - street grates above
  7: 0.65, // PERSONAL  - whatever you personally left outside
};

/** Inverse-square distance attenuation, unity at 5 m and closer. */
function rolloff(dist: number): number {
  const REF = 5;
  if (!(dist >= REF)) return 1;
  const r = REF / dist;
  return r * r;
}

/** Stereo pan for a bearing: forward 0, right +1, behind 0, left -1. */
function panFor(bearing: number): number {
  return Math.max(-1, Math.min(1, Math.sin(bearing)));
}

interface Placement {
  bearing: number;
  dist: number;
}

/** The persistent rain-on-roof patter layer, built while fronts are wet. */
interface RainLayer {
  src: AudioBufferSourceNode;
  g: GainNode;
}

export class ExteriorBleed {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Seconds until the next birdsong sequence. */
  private nextBirdIn = 8 + Math.random() * 20;
  /** Seconds until the next traffic whoosh. */
  private nextTrafficIn = 20 + Math.random() * 50;
  /** Seconds until the next fragment of children playing. */
  private nextChildrenIn = 40 + Math.random() * 80;
  private stopped = false;

  /** Shared white-noise buffer for traffic and rain, built lazily. */
  private noiseBuf: AudioBuffer | null = null;
  /** Active rain patter layer, or null while the weather is dry. */
  private rain: RainLayer | null = null;
  /** Voices still sounding, so stop() can silence them immediately. */
  private readonly live = new Set<AudioScheduledSourceNode>();

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /**
   * Per-frame tick.
   * @param dt       seconds since the previous frame
   * @param zoneKind current MemoryKind (numeric) - scales how much of
   *                 the outside the local memories let through
   * @param tension  director tension 0..1; high tension silences the
   *                 birds and thins every other bleed
   * @param wetness  0..1 strength of any wet weather front overhead;
   *                 above ~0.05 the rain-patter layer fades in
   */
  update(dt: number, zoneKind = 1, tension = 0, wetness = 0): void {
    if (this.stopped) return;
    const bleed = BLEED_BY_ZONE[Math.round(zoneKind)] ?? 0.7;

    // --- scheduled one-shot events -------------------------------------
    // Birds only sing when things are calm; the countdown also dilates
    // with tension so rising dread thins them out before killing them.
    if (tension < 0.45) {
      this.nextBirdIn -= dt / (1 + tension);
      if (this.nextBirdIn <= 0) {
        this.nextBirdIn = 45 + Math.random() * 75; // calm pacing: 45-120 s
        this.birdsong(bleed);
      }
    } else {
      // They stay gone a while once the dread rises.
      this.nextBirdIn = Math.max(this.nextBirdIn, 15);
    }

    // Traffic and children still leak under tension, just further apart.
    this.nextTrafficIn -= dt / (1 + tension);
    if (this.nextTrafficIn <= 0) {
      this.nextTrafficIn = 180 + Math.random() * 240; // rare: 3-7 min
      this.trafficPass(bleed);
    }

    this.nextChildrenIn -= dt / (1 + 2 * tension);
    if (this.nextChildrenIn <= 0) {
      this.nextChildrenIn = 600 + Math.random() * 300; // very rare: 10-15 min
      this.childrenPlaying(bleed);
    }

    // --- continuous rain layer ------------------------------------------
    this.updateRain(tension, wetness);
  }

  /** Silence everything sounding and halt the schedulers. */
  stop(): void {
    this.stopped = true;
    if (this.rain) {
      try { this.rain.src.stop(); } catch { /* already ended */ }
      this.rain = null;
    }
    for (const src of this.live) {
      try { src.stop(); } catch { /* already ended */ }
    }
    this.live.clear();
  }

  /** Random spot for an event: any bearing, 8-30 m beyond the wall. */
  private place(): Placement {
    return { bearing: Math.random() * TWO_PI, dist: 8 + Math.random() * 22 };
  }

  /** Register a voice so stop() can cut it short. */
  private track(src: AudioScheduledSourceNode, until: number): void {
    this.live.add(src);
    src.onended = () => this.live.delete(src);
    src.stop(until);
  }

  // ------------------------------------------------------------------
  // Birdsong
  // ------------------------------------------------------------------

  /**
   * One bird: 2-4 chirps, each a sine sweep across the 2-4 kHz band with
   * a fast shared vibrato, everything squeezed through a 1200 Hz wall
   * lowpass afterwards.
   */
  private birdsong(bleed: number): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const { bearing, dist } = this.place();
    const chirps = 2 + Math.floor(Math.random() * 3); // 2-4

    // The wall between us and the impossible garden.
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 1200;

    const seqGain = ctx.createGain();
    seqGain.gain.value = 1;

    const p = ctx.createStereoPanner();
    p.pan.value = panFor(bearing);

    seqGain.connect(muffle).connect(p).connect(this.out);

    // Vibrato LFO is shared by every chirp of this one bird.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 18 + Math.random() * 22; // fast trill rate
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 120 + Math.random() * 180; // Hz of wobble
    lfo.connect(lfoDepth);
    lfo.start(t0);

    let at = t0 + 0.05;
    for (let i = 0; i < chirps; i++) {
      at = this.chirp(at, lfoDepth, seqGain, rolloff(dist) * bleed);
      at += 0.08 + Math.random() * 0.16; // gap between chirps
    }
    this.track(lfo, at);
  }

  /** One chirp sweep; returns the time it finishes. */
  private chirp(at: number, lfoDepth: GainNode, dest: AudioNode, level: number): number {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f1 = 2000 + Math.random() * 1500;
    const f2 = 2000 + Math.random() * 2000;
    o.frequency.setValueAtTime(f1, at);
    o.frequency.exponentialRampToValueAtTime(f2, at + 0.09);
    lfoDepth.connect(o.frequency); // vibrato rides the sweep

    const g = ctx.createGain();
    const peak = 0.045 * level; // quiet even before the wall eats it
    const dur = 0.07 + Math.random() * 0.06;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    o.connect(g).connect(dest);
    o.start(at);
    this.track(o, at + dur + 0.02);
    return at + dur;
  }

  // ------------------------------------------------------------------
  // Distant traffic
  // ------------------------------------------------------------------

  /**
   * A vehicle passing on a road that cannot exist: looped noise swelling
   * through a bandpass that rises then falls (approach/recede), while a
   * drifting pan carries it across the stereo field over 2-4 s.
   */
  private trafficPass(bleed: number): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const { bearing, dist } = this.place();

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.loop = true;

    // Bandpass sweeps up as it nears and sinks as it recedes.
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.9;
    const fLow = 140 + Math.random() * 80;
    const fHigh = fLow + 260 + Math.random() * 240;
    const dur = 2 + Math.random() * 2; // 2-4 s
    bp.frequency.setValueAtTime(fLow, t0);
    bp.frequency.linearRampToValueAtTime(fHigh, t0 + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(fLow * 0.85, t0 + dur);

    // Muffled by whatever stands between here and the phantom road.
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 900;

    const g = ctx.createGain();
    const peak = 0.06 * rolloff(dist) * bleed;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    // Pass-by drift: starts off one side, exits the other.
    const p = ctx.createStereoPanner();
    const dir = Math.random() < 0.5 ? 1 : -1;
    p.pan.setValueAtTime(-0.8 * dir, t0);
    p.pan.linearRampToValueAtTime(0.8 * dir, t0 + dur);

    src.connect(bp).connect(muffle).connect(g).connect(p).connect(this.out);
    src.start(t0);
    this.track(src, t0 + dur + 0.05);
  }

  // ------------------------------------------------------------------
  // Children playing
  // ------------------------------------------------------------------

  /**
   * Very rare: 2-3 short high calls - sawtooth babble pushed through two
   * resonant formants pitched up past speech range, then crushed under a
   * deep lowpass until it is barely a rumour of a playground.
   */
  private childrenPlaying(bleed: number): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const { bearing } = this.place();

    // Deeply muffled: the extra wall after the formants.
    const deep = ctx.createBiquadFilter();
    deep.type = 'lowpass';
    deep.frequency.value = 480;

    const p = ctx.createStereoPanner();
    p.pan.value = panFor(bearing);

    deep.connect(p).connect(this.out);

    const fragments = 2 + Math.floor(Math.random() * 2); // 2-3 calls
    let at = t0 + 0.1;
    for (let i = 0; i < fragments; i++) {
      at = this.childCall(at, deep, bleed) + 0.25 + Math.random() * 0.5;
    }
  }

  /** One pitched-up call fragment; returns the time it finishes. */
  private childCall(at: number, dest: AudioNode, bleed: number): number {
    const ctx = this.ctx;

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    // Voice fundamentals pitched up ~1.5x: small, quick, not-quite-words.
    const base = 420 + Math.random() * 280;
    o.frequency.setValueAtTime(base, at);
    o.frequency.linearRampToValueAtTime(base * (1.35 + Math.random() * 0.3), at + 0.12);
    o.frequency.linearRampToValueAtTime(base * (0.95 + Math.random() * 0.2), at + 0.24);

    // Two vowel-ish formants above the fundamental, scaled up with it.
    const scale = base / 500;
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 720 * scale;
    f1.Q.value = 9;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1980 * scale;
    f2.Q.value = 11;

    const g = ctx.createGain();
    const peak = 0.03 * bleed; // barely there, even at full bleed
    const dur = 0.22 + Math.random() * 0.12;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    g.connect(dest);
    o.start(at);
    this.track(o, at + dur + 0.02);
    return at + dur;
  }

  // ------------------------------------------------------------------
  // Rain on roof
  // ------------------------------------------------------------------

  /**
   * Continuous patter while a wet front sits overhead: dense filtered
   * noise whose level tracks wetness. Fades out over seconds once dry,
   * then tears itself down.
   */
  private updateRain(tension: number, wetness: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    if (this.rain) {
      const target = wetness > 0.05 ? (wetness * 0.05) / (1 + tension) : 0;
      // tau 1.5 s: fronts arrive and leave without clicks.
      this.rain.g.gain.setTargetAtTime(target, t, 1.5);
      if (wetness <= 0.001) {
        try { this.rain.src.stop(t + 6); } catch { /* already ended */ }
        this.rain = null;
      }
      return;
    }

    if (wetness > 0.05) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      src.loop = true;

      // Patter: bright hiss shaved down by the roof and everything below.
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1600;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.setTargetAtTime((wetness * 0.05) / (1 + tension), t, 1.5);

      src.connect(hp).connect(lp).connect(g).connect(this.out);
      src.start(t);
      // Looping bed: tracked separately from one-shots, cut by stop().
      src.onended = () => this.live.delete(src);
      this.rain = { src, g };
    }
  }

  /** Lazily build (and cache) a quarter-second of white noise. */
  private noiseBuffer(): AudioBuffer {
    if (!this.noiseBuf) {
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * 0.25));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }
}


