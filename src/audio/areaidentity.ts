/**
 * Area identity beds for BACKROOMS: MEMORY BLEED.
 *
 * One signature wrongness per district, mounted through the same
 * update(dt, district, tension) signal path CrowdAmbience rides:
 *
 *   MAZE (0)           odd-order hum beat swells — the HumHarmonics
 *                      vocabulary pushed further: 3rd/5th/7th mains
 *                      harmonics in near-unison pairs whose slow swells
 *                      beat against their twin like something feeding wrong.
 *   OPEN_OFFICE (1)    distant telephones in unreachable rooms, via
 *                      phoner.ts; the murmur itself stays owned by
 *                      crowd.ts and is deliberately not duplicated.
 *   HONEYCOMB (2)      hollow hex-cell resonances: short pitched impulses
 *                      dropped through tuned comb delays.
 *   CORRIDOR_GRID (3)  long duct-whistle winds: one noise bed split into
 *                      a slowly beating narrow bandpass pair.
 *   STORAGE (4)        metal-settle groans chained off the groans.ts
 *                      vocabulary — a slumping fundamental under ringing
 *                      high-Q metal partials.
 *
 * Every island is lazy-gated: its graph is built on the first frame its
 * district is active, it crossfades out over ~2 s when the player leaves,
 * and stop() releases everything. The whole system sits behind an instant
 * kill-switch (setEnabled(false)).
 *
 * Determinism: all scheduling math runs on mulberry32 streams; Math.random
 * is used only inside the corridor island's noise-buffer fill (DSP
 * sample-fill exception).
 */

import { PhoneRinger } from './phoner';

/** Deterministic PRNG (same construction as crowd.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** District ordinals mirroring District in world/constants.ts. */
export const DISTRICT_MAZE = 0;
export const DISTRICT_OPEN_OFFICE = 1;
export const DISTRICT_HONEYCOMB = 2;
export const DISTRICT_CORRIDOR_GRID = 3;
export const DISTRICT_STORAGE = 4;

/** Crossfade time constant for island gates (seconds). */
const GATE_TAU = 1.6;

/** Contract every district island implements. */
interface Island {
  /** District ordinal this bed belongs to. */
  readonly district: number;
  /** Master gate gain for crossfading (starts at 0). */
  readonly gate: GainNode;
  /** Build the graph now (called once, lazily). */
  build(): void;
  /** Per-frame tick while audible; schedules events. */
  update(dt: number, tension: number): void;
  /** Stop all sources; the island will not restart. */
  stop(): void;
}

/** Stop an AudioScheduledSourceNode without throwing when already ended. */
function halt(src: AudioScheduledSourceNode): void {
  try { src.stop(); } catch { /* already stopped */ }
}

// ---------------------------------------------------------------------------
// MAZE: odd-order hum beat swells
// ---------------------------------------------------------------------------

/** Odd mains harmonics used by the maze bed (3rd/5th/7th of 60 Hz). */
const MAZE_HARMONICS = [180, 300, 420] as const;

class MazeIsland implements Island {
  readonly district = DISTRICT_MAZE;
  readonly gate: GainNode;
  private readonly rnd = mulberry32(0x0da2e);
  private readonly srcs: AudioScheduledSourceNode[] = [];

  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.gate.connect(destination);
  }

  build(): void {
    // Each harmonic gets a twin detuned inside the classic 0.5-1.5 Hz beat
    // window; a very slow LFO breathes each pair's bus -> beat swells.
    for (let i = 0; i < MAZE_HARMONICS.length; i++) {
      const f = MAZE_HARMONICS[i];
      const swell = this.ctx.createGain();
      swell.gain.value = 1;
      swell.connect(this.gate);

      const pairBus = this.ctx.createGain();
      pairBus.gain.value = 0.016 / (i + 1);
      pairBus.connect(swell);

      for (const detune of [0, 0.5 + this.rnd()]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f + detune;
        const g = this.ctx.createGain();
        g.gain.value = 0.5;
        osc.connect(g);
        g.connect(pairBus);
        osc.start();
        this.srcs.push(osc);
      }

      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.03 + this.rnd() * 0.04;
      const depth = this.ctx.createGain();
      depth.gain.value = 0.45;
      lfo.connect(depth);
      depth.connect(swell.gain);
      lfo.start();
      this.srcs.push(lfo);
    }
  }

  update(_dt: number, _tension: number): void {
    // Swells run as free LFOs; nothing to schedule per frame.
  }

  stop(): void {
    for (const s of this.srcs) halt(s);
  }
}

// ---------------------------------------------------------------------------
// OPEN_OFFICE: distant telephones in unreachable rooms
// ---------------------------------------------------------------------------

class OfficeIsland implements Island {
  readonly district = DISTRICT_OPEN_OFFICE;
  readonly gate: GainNode;
  readonly phones: PhoneRinger; // built against the island gate

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.gate.connect(destination);
    // Phone voices ride the island gate so the district crossfade owns them.
    this.phones = new PhoneRinger(ctx, this.gate);
  }

  /** Route the session seed into the deterministic placement hash. */
  seed(seed: number): void { this.phones.seed(seed); }

  build(): void { /* PhoneRinger builds its voices per ring */ }

  update(dt: number, _tension: number): void {
    // Player position rides in via setListener(); see AreaIdentityBeds.
    if (this.listener) {
      const [px, pz] = this.listener;
      this.phones.update(dt, px, pz);
    }
  }

  /** Latest listener position, or null before the first frame feeds it. */
  listener: readonly [number, number] | null = null;

  stop(): void { this.phones.stop(); }
}

// ---------------------------------------------------------------------------
// HONEYCOMB: hollow hex-cell resonances
// ---------------------------------------------------------------------------

class HoneycombIsland implements Island {
  readonly district = DISTRICT_HONEYCOMB;
  readonly gate: GainNode;
  private readonly rnd = mulberry32(0xe6c11);
  private readonly ctx: AudioContext;
  private nextImpulseIn = 2;
  private combs: DelayNode[] = [];
  private built = false;
  private stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.gate.connect(destination);
  }

  build(): void {
    // Two tuned comb delays: short pitched impulses ring in them like a
    // hollow cell; modest feedback keeps tails hollow, not howling.
    for (const f of [96, 154]) {
      const comb = this.ctx.createDelay(0.05);
      comb.delayTime.value = 1 / f;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.55;
      comb.connect(fb);
      fb.connect(comb);
      comb.connect(this.gate);
      this.combs.push(comb);
    }
    this.built = true;
  }

  update(dt: number, _tension: number): void {
    if (this.stopped || !this.built) return;
    this.nextImpulseIn -= dt;
    if (this.nextImpulseIn > 0) return;
    this.nextImpulseIn = 4 + this.rnd() * 5;
    const t0 = this.ctx.currentTime + 0.05;

    // Short pitched impulse: a quick sine ping at a cell pitch.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 240 + this.rnd() * 480;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(0.06, t0 + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = this.rnd() * 1.4 - 0.7;
    osc.connect(env);
    env.connect(pan);
    for (const comb of this.combs) pan.connect(comb);
    pan.connect(this.gate);
    osc.start(t0);
    osc.stop(t0 + 0.15); // schedule-only voice: dies with its envelope
  }

  stop(): void { this.stopped = true; }
}

// ---------------------------------------------------------------------------
// CORRIDOR_GRID: duct-whistle wind pair
// ---------------------------------------------------------------------------

class CorridorIsland implements Island {
  readonly district = DISTRICT_CORRIDOR_GRID;
  readonly gate: GainNode;
  private readonly rnd = mulberry32(0x0dc7);
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private built = false;
  private stopped = false;

  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.gate.connect(destination);
  }

  build(): void {
    this.built = true;
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer();
    noise.loop = true;

    // Narrow beating pair: two whistles a few Hz apart share one air source,
    // each breathing on its own slow swell LFO.
    const base = 520 + this.rnd() * 220;
    for (const detune of [0, 3 + this.rnd() * 3]) {
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = base + detune;
      bp.Q.value = 18;
      const wg = this.ctx.createGain();
      wg.gain.value = 0.012;
      const swellLfo = this.ctx.createOscillator();
      swellLfo.type = 'sine';
      swellLfo.frequency.value = 0.02 + this.rnd() * 0.03;
      const swellDepth = this.ctx.createGain();
      swellDepth.gain.value = 0.006;
      swellLfo.connect(swellDepth);
      swellDepth.connect(wg.gain);
      swellLfo.start();
      this.srcs.push(swellLfo);
      noise.connect(bp);
      bp.connect(wg);
      wg.connect(this.gate);
    }
    noise.start();
    this.srcs.push(noise);
  }

  update(_dt: number, _tension: number): void {
    // Beating and swell run as free LFOs; nothing to schedule per frame.
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.srcs) halt(s);
  }

  /** Shared four-second white-noise buffer for the duct air. */
  private noiseBuffer(): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * 4);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Math.random is allowed here and ONLY here: raw DSP sample fill.
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }
}

// ---------------------------------------------------------------------------
// STORAGE: metal-settle groans
// ---------------------------------------------------------------------------

class StorageIsland implements Island {
  readonly district = DISTRICT_STORAGE;
  readonly gate: GainNode;
  private readonly rnd = mulberry32(0x57073 >> 3);
  private nextGroanIn = 12;
  private stopped = false;
  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.gate.connect(destination);
  }

  build(): void { /* built per event */ }

  update(dt: number, tension: number): void {
    if (this.stopped) return;
    // Tension dilates the countdown exactly like StructureGroans' calm-time.
    this.nextGroanIn -= dt / (1 + 2 * tension);
    if (this.nextGroanIn > 0) return;
    this.nextGroanIn = 25 + this.rnd() * 35;
    this.settleGroan();
  }

  stop(): void { this.stopped = true; }

  /**
   * Metal settle, chained off groans.ts vocabulary: the same slumping
   * sawtooth weight-shift, re-voiced through high-Q metallic partials so
   * hoarded shelving reads as the settling mass.
   */
  private settleGroan(): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const slumpFrom = 52 + this.rnd() * 26;
    const decay = 2.2 + this.rnd() * 1.8;

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(slumpFrom, t0);
    o.frequency.exponentialRampToValueAtTime(slumpFrom * 0.78, t0 + decay);

    // Ringing metal partials over the slump.
    const partials = ctx.createGain();
    partials.gain.value = 0.5;
    for (const mult of [2.76, 5.4, 8.9]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = slumpFrom * mult;
      bp.Q.value = 9;
      o.connect(bp);
      bp.connect(partials);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.07, t0 + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6 + decay);

    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rnd() * 1.2 - 0.6;

    partials.connect(g);
    g.connect(pan);
    pan.connect(this.gate);
    o.start(t0);
    o.stop(t0 + 0.65 + decay);
  }
}

// ---------------------------------------------------------------------------

/**
 * Per-district identity beds. Mount beside CrowdAmbience and drive it with
 * the same update(dt, district, tension) feed; call seed() once per run so
 * the office phone placements hash deterministically, and feed listener
 * position so phones can detect earshot.
 *
 * Construction is fully lazy: nothing touches the AudioContext until the
 * first update() frame, and the five islands are then built together in
 * fixed district order so island i always belongs to district i.
 */
export class AreaIdentityBeds {
  private islands: Island[] | null;
  private office: OfficeIsland | null;
  private readonly destination: AudioNode;
  private enabled = true;
  private stopped = false;
  private builtFlags: boolean[];
  /** seed()/setListener() values arriving before the first update() frame. */
  private pendingSeed: number | null = null;
  private pendingListener: readonly [number, number] | null = null;

  private readonly ctx: AudioContext;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
    this.islands = null;
    this.office = null;
    this.builtFlags = [];
  }

  /**
   * Build every island exactly once, in district order, on first use.
   * Islands live here rather than in the constructor so a mounted-but-not-
   * yet-ticking beds instance never allocates audio nodes.
   */
  private ensureIslands(): Island[] {
    if (this.islands) return this.islands;
    // Construct strictly in district order — callers index gates by district.
    const maze = new MazeIsland(this.ctx, this.destination);
    const office = new OfficeIsland(this.ctx, this.destination);
    this.islands = [
      maze,
      office,
      new HoneycombIsland(this.ctx, this.destination),
      new CorridorIsland(this.ctx, this.destination),
      new StorageIsland(this.ctx, this.destination),
    ];
    this.office = office;
    if (this.pendingSeed !== null) office.seed(this.pendingSeed);
    if (this.pendingListener) office.listener = this.pendingListener;
    this.builtFlags = this.islands.map(() => false);
    return this.islands;
  }

  /**
   * Bind the office phone placements to the session seed.
   * @param seed session/world seed
   */
  seed(seed: number): void {
    if (this.office) this.office.seed(seed);
    else this.pendingSeed = seed;
  }

  /**
   * Feed the listener position used for earshot checks (office phones).
   * @param x player world x
   * @param z player world z
   */
  setListener(x: number, z: number): void {
    const pos: readonly [number, number] = [x, z];
    if (this.office) this.office.listener = pos;
    else this.pendingListener = pos;
  }

  /** Kill-switch: false fades every open gate out immediately. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.islands) {
      const t = this.ctx.currentTime;
      for (const island of this.islands) island.gate.gain.setTargetAtTime(0, t, 0.02);
    }
  }

  /**
   * Per-frame tick.
   * @param dt       seconds since the previous frame
   * @param district current district ordinal (-1 = unknown/none)
   * @param tension  director tension 0..1
   */
  update(dt: number, district: number, tension = 0): void {
    if (this.stopped || !this.enabled) return;
    const islands = this.ensureIslands();
    const t = this.ctx.currentTime;
    for (let i = 0; i < islands.length; i++) {
      const island = islands[i];
      const active = island.district === district;
      island.gate.gain.setTargetAtTime(active ? 1 : 0, t, GATE_TAU);
      if (!active) continue;
      if (!this.builtFlags[i]) {
        this.builtFlags[i] = true;
        island.build();
      }
      island.update(dt, tension);
    }
  }

  /** Silence everything and release sources; the instance will not restart. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.islands) for (const island of this.islands) island.stop();
  }
}
