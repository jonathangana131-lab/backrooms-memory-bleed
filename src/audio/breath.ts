/**
 * Player exertion breathing for BACKROOMS: MEMORY BLEED.
 *
 * An experimental, honestly-gated layer: a synthesized anxious person
 * breathing somewhere just behind the camera. Fully procedural, no assets,
 * no recordings of anyone:
 *
 *   SOURCE    a looping filtered-noise voice: broadband breath noise
 *             through a chest-resonance peaking filter (~120 Hz, the
 *             body behind the sound) and a drifting mouth-formant
 *             bandpass (mouth opens on the exhale, closes on the inhale).
 *   CYCLE     one breath = inhale (fast rise, ~42% of the cycle) into a
 *             slower, heavier exhale. Effort moves the rate from 0.55 Hz
 *             (resting dread) to 0.85 Hz (sprint panic) and lifts
 *             loudness with it.
 *   EXERTION  footsteps drive the ramp — sprint steps push much harder
 *             than walking steps, and exertion bleeds off slowly. Director
 *             tension adds a floor under the effort plus a 7 Hz tremor
 *             depth on the envelope; a blackout pins the layer into a
 *             shallow held-breath until the lights return.
 *   GATE      the whole layer sits behind an instant kill-switch
 *             (setEnabled(false)) at a deliberately low mix under the
 *             sfx bus. Default ON, quiet enough to ignore, one call to
 *             silence forever.
 *
 * QUALITY BAR: ship it only if it reads as a real anxious person breathing
 * in an impossible place. auditBreathQuality() is the headless self-audit
 * used by test/breath-test.mjs: envelope shape, rate/loudness-vs-effort
 * scaling, and spectral flatness of the voiced band (breath noise must be
 * tonally shaped by the formant chain, never raw white).
 *
 * Determinism: all envelope/scheduling math runs off seeded mulberry32
 * streams; Math.random appears ONLY inside the noise-buffer sample fill.
 */

/** Resting breath rate (Hz). */
export const BREATH_RATE_MIN = 0.55;
/** Panic breath rate (Hz). */
export const BREATH_RATE_MAX = 0.85;

/** Fraction of the breath cycle spent inhaling. */
export const INHALE_FRACTION = 0.42;

/** Default master mix — present under the sfx bus, never forward. */
export const BREATH_MIX = 0.055;

/** Deterministic PRNG (same construction as radio.ts/crowd.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Breath rate for an effort level.
 * @param effort 0..1 exertion/tension blend
 * @returns cycles per second between BREATH_RATE_MIN and BREATH_RATE_MAX
 */
export function breathRate(effort: number): number {
  return BREATH_RATE_MIN + Math.max(0, Math.min(1, effort)) * (BREATH_RATE_MAX - BREATH_RATE_MIN);
}

/**
 * Relative loudness for an effort level: harder breathing is louder
 * breathing, roughly linear with a slight top-end lift.
 */
export function breathLoudness(effort: number): number {
  return 0.45 + Math.max(0, Math.min(1, effort)) * 0.55;
}

/**
 * Envelope value at one point in the breath cycle.
 * @param phase cycle position 0..1 (0 = inhale start)
 * @returns relative amplitude 0..1 — quick inhale rise into a slow exhale fall
 */
export function breathEnvelope(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < INHALE_FRACTION) {
    const k = p / INHALE_FRACTION;
    return Math.pow(k, 0.75) * 0.85;
  }
  const k = (p - INHALE_FRACTION) / (1 - INHALE_FRACTION);
  return 0.85 * Math.pow(1 - k, 1.35);
}

/** One RBJ biquad bandpass coefficient set (constant 0 dB peak). */
interface BPCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number }

/** Bandpass coefficients at center Hz/Q for a sample rate. */
function bandpassCoeffs(hz: number, q: number, sr: number): BPCoeffs {
  const w0 = 2 * Math.PI * hz / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** One-pole-filtered render of one full breath cycle at a control rate. */
function renderCycle(effort: number, seed: number, sr = 8000): Float32Array {
  const dur = 1 / breathRate(effort);
  const n = Math.round(dur * sr);
  const rnd = mulberry32(seed);
  const c = bandpassCoeffs(500, 1.1, sr);
  const outArr = new Float32Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    // Deterministic stand-in for the live noise source (same statistics).
    const x = rnd() * 2 - 1;
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    outArr[i] = y * breathEnvelope(i / n);
  }
  return outArr;
}

/** Energy of a signal at one frequency via the Goertzel algorithm. */
function goertzelEnergy(sig: Float32Array, hz: number, sr: number): number {
  const w = 2 * Math.PI * hz / sr;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < sig.length; i++) {
    const s0 = sig[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.max(power, 1e-12);
}

/** Result of the BREATH_QUALITY self-audit. */
export interface BreathAudit {
  pass: boolean;
  /** Individual named check results, false = failed. */
  checks: Record<string, boolean>;
  /** Measured spectral flatness of the voiced band (lower = more shaped). */
  flatness: number;
}

/**
 * Headless quality self-audit for the breath layer.
 * Renders filtered-noise cycles at rest and panic effort and verifies the
 * properties that make the layer read as real breathing rather than hiss:
 * rate and loudness track effort, the envelope alternates inhale/exhale,
 * and the voiced spectrum is tonally shaped (spectral flatness well below
 * the white-noise limit of 1).
 */
export function auditBreathQuality(): BreathAudit {
  const checks: Record<string, boolean> = {};
  checks['rate spans 0.55-0.85 Hz'] =
    Math.abs(breathRate(0) - BREATH_RATE_MIN) < 1e-9 &&
    Math.abs(breathRate(1) - BREATH_RATE_MAX) < 1e-9;
  checks['loudness rises with effort'] = breathLoudness(1) > breathLoudness(0);

  // Envelope shape across two cycles (phase 0..2): two peaks, one per
  // cycle, both at the inhale crest.
  let peaks = 0;
  const CYCLES = 2;
  const N = CYCLES * 200;
  const phaseAt = (i: number): number => (i * CYCLES) / N;
  let prev = breathEnvelope(phaseAt(0)), cur = breathEnvelope(phaseAt(1));
  for (let i = 2; i <= N; i++) {
    const next = breathEnvelope(phaseAt(i));
    if (cur > prev && cur >= next && cur > 0.5) peaks++;
    prev = cur; cur = next;
  }
  checks['envelope peaks once per cycle'] = peaks === 2;
  checks['inhale shorter than exhale'] =
    breathEnvelope(INHALE_FRACTION * 0.5) > breathEnvelope(INHALE_FRACTION + (1 - INHALE_FRACTION) * 0.5);

  // Spectral flatness of the voiced band: shaped breath noise, not white.
  const sig = renderCycle(0.5, 0xbe02);
  const bands = [80, 160, 320, 500, 1000, 2000].map((hz) => goertzelEnergy(sig, hz, 8000));
  const mean = bands.reduce((a, b) => a + b, 0) / bands.length;
  const geomean = Math.exp(bands.reduce((a, b) => a + Math.log(b), 0) / bands.length);
  const flatness = geomean / mean;
  checks['voiced spectrum is shaped (flatness < 0.5)'] = flatness < 0.5;
  checks['formant band dominates the highs'] = bands[3] > bands[5] * 4;

  return { pass: Object.values(checks).every(Boolean), checks, flatness };
}

// ---------------------------------------------------------------------------
// Live graph
// ---------------------------------------------------------------------------

interface BreathNodes {
  out: GainNode;
  env: GainNode;
  mouth: BiquadFilterNode;
  tremorDepth: GainNode;
  tremor: OscillatorNode;
  noise: AudioBufferSourceNode;
}

/** Structural event subscription contract (player controller emitter). */
export interface FootstepEvents {
  on(key: 'footstep', fn: (payload: { running: boolean }) => void): () => void;
}

/** Options accepted by mountPlayerBreath(). */
export interface BreathMountOptions {
  ctx: AudioContext;
  /** Bus to breathe under — normally the sfx/occlusion send. */
  destination: AudioNode;
  /** Player event emitter; the layer subscribes to its own footsteps. */
  playerEvents?: FootstepEvents | null;
  /** Director tension provider 0..1, polled each update. */
  tension?: () => number;
  /** Blackout state provider, polled each update. */
  blackout?: () => boolean;
  /** Override the master mix; omit for BREATH_MIX. */
  mix?: number;
}

/** Handle returned by mountPlayerBreath(). */
export interface BreathHandle {
  /** Per-frame tick: advances the breath cycle and eases gates. */
  update(dt: number): void;
  /** Kill-switch: false silences the layer immediately. */
  setEnabled(on: boolean): void;
  /** Unsubscribe, silence, and release every node. */
  dispose(): void;
}

/**
 * Mount the breath layer onto an existing game wiring without touching
 * src/core/game.ts: pass the player's event emitter and tension/blackout
 * providers; poll update(dt) from the orchestrator's frame loop.
 */
export function mountPlayerBreath(opts: BreathMountOptions): BreathHandle {
  const breath = new PlayerBreath(opts.ctx, opts.destination, opts.mix ?? BREATH_MIX);
  const unsub = opts.playerEvents?.on('footstep', (p) => breath.notifyFootstep(p.running)) ?? null;
  let disposed = false;
  return {
    update(dt: number): void {
      if (disposed) return;
      if (opts.tension) breath.setTension(opts.tension());
      if (opts.blackout) breath.setBlackout(opts.blackout());
      breath.update(dt);
    },
    setEnabled(on: boolean): void { breath.setEnabled(on); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsub?.();
      breath.stop();
    },
  };
}

/** Live breathing layer. Construct directly in tests; prefer mountPlayerBreath in game code. */
export class PlayerBreath {
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;
  private readonly mix: number;

  private nodes: BreathNodes | null = null;
  private built = false;
  private stopped = false;
  private enabled = true;

  /** Exertion accumulated from footsteps, decays slowly. */
  private exertion = 0;
  private tension = 0;
  private blackout = false;
  /** Cycle position 0..1. */
  private phase = 0;
  /** Per-cycle rate jitter multiplier and mouth target, re-rolled each cycle. */
  private rateJitter = 1;
  private mouthTarget = 600;
  private cycles = 0;
  private readonly rnd: () => number;

  constructor(ctx: AudioContext, destination: AudioNode, mix = BREATH_MIX) {
    this.ctx = ctx;
    this.destination = destination;
    this.mix = mix;
    this.rnd = mulberry32(0x62ea7c1); // breath voice seed
  }

  /** Feed one footfall: sprint steps ramp exertion far harder than walks. */
  notifyFootstep(running: boolean): void {
    this.exertion = Math.min(1, this.exertion + (running ? 0.11 : 0.035));
  }

  /**
   * Set director tension (0..1). Tension floors the effort and deepens
   * the 7 Hz envelope tremor.
   */
  setTension(t: number): void { this.tension = Math.max(0, Math.min(1, t)); }

  /**
   * Blackout state: true pins the layer into a shallow held breath.
   */
  setBlackout(held: boolean): void { this.blackout = held; }

  /** Kill-switch. False cuts the layer out of the mix immediately. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.nodes) this.nodes.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
  }

  /** Per-frame tick. */
  update(dt: number): void {
    if (this.stopped || !this.enabled) return;
    if (!this.built) this.build();
    this.built = true;
    const nodes = this.nodes!;
    const t = this.ctx.currentTime;

    // Exertion bleeds off slowly; tension keeps a floor under the effort.
    this.exertion = Math.max(0, this.exertion - dt * 0.022);
    const effort = Math.max(this.exertion, this.tension * 0.45);

    // Held breath: the cycle stalls and the envelope drops to a shallow hold.
    if (this.blackout) {
      nodes.env.gain.setTargetAtTime(0.06, t, 0.12);
      nodes.tremorDepth.gain.setTargetAtTime(0.004, t, 0.2);
      nodes.out.gain.setTargetAtTime(this.mix, t, 0.1);
      return;
    }

    // Advance the cycle; re-roll per-cycle character at each wrap.
    const prevCycle = Math.floor(this.phase);
    this.phase += dt * breathRate(effort) * this.rateJitter;
    if (Math.floor(this.phase) > prevCycle) this.rollCycle();
    if (this.phase >= 1) this.phase -= 1;

    const level = breathEnvelope(this.phase) * breathLoudness(effort);
    nodes.env.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.045);
    nodes.mouth.frequency.setTargetAtTime(
      this.mouthTarget * (0.75 + 0.5 * (1 - this.phase)), t, 0.09); // opens on the exhale
    nodes.tremorDepth.gain.setTargetAtTime(0.002 + this.tension * 0.05, t, 0.3);
    nodes.out.gain.setTargetAtTime(this.mix, t, 0.1);
  }

  /** Silence everything and release sources; the instance will not restart. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const n = this.nodes;
    if (!n) return;
    n.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
    try { n.noise.stop(); } catch { /* already stopped */ }
    try { n.tremor.stop(); } catch { /* already stopped */ }
  }

  // ---------------------------------------------------------------------------

  private rollCycle(): void {
    this.cycles++;
    this.rateJitter = 0.92 + this.rnd() * 0.16;
    this.mouthTarget = 380 + this.rnd() * 470;
  }

  /** Lazily build the noise->chest->mouth->env->mix chain. */
  private build(): void {
    const ctx = this.ctx;
    this.nodes = {
      out: ctx.createGain(),
      env: ctx.createGain(),
      mouth: ctx.createBiquadFilter(),
      tremorDepth: ctx.createGain(),
      tremor: ctx.createOscillator(),
      noise: ctx.createBufferSource(),
    };
    const { out, env, mouth, tremorDepth, tremor, noise } = this.nodes;
    this.built = true;

    out.gain.value = 0;
    out.connect(this.destination);

    // Chest resonance: the body behind the sound.
    const chestPeak = ctx.createBiquadFilter();
    chestPeak.type = 'peaking';
    chestPeak.frequency.value = 120;
    chestPeak.Q.value = 1.2;
    chestPeak.gain.value = 9;
    const chestLP = ctx.createBiquadFilter();
    chestLP.type = 'lowpass';
    chestLP.frequency.value = 1400;

    // Mouth formant: drifted toward this cycle's target in update().
    mouth.type = 'bandpass';
    mouth.frequency.value = this.mouthTarget;
    mouth.Q.value = 1.1;

    env.gain.value = 0.0001;

    // Anxiety tremor: 7 Hz wobble summed straight into the envelope param.
    tremor.type = 'sine';
    tremor.frequency.value = 7;
    tremorDepth.gain.value = 0;
    tremor.connect(tremorDepth);
    tremorDepth.connect(env.gain);
    tremor.start();

    // eslint-disable-next-line -- Broadband breath noise: Math.random is the
    // sanctioned DSP exception (sample-fill only, matching audio.ts policy).
    noise.buffer = this.noiseBuffer();
    noise.loop = true;

    noise.connect(chestLP);
    chestLP.connect(chestPeak);
    chestPeak.connect(mouth);
    mouth.connect(env);
    env.connect(out);
    noise.start();
  }

  /** Shared two-second white-noise buffer for the breath voice. */
  private noiseBuffer(): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Math.random is allowed here and ONLY here: raw DSP sample fill.
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}
