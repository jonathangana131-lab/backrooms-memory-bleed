/**
 * Watcher approach footsteps for BACKROOMS: MEMORY BLEED.
 *
 * The watchers walk when you walk. Their footsteps are synced to your own
 * step cadence but offset by half a stride - mirror-steps - so what you
 * hear interleaves with your own feet and reads as an echo that shouldn't
 * be there. Everything about them is designed to be denied, then dreaded:
 *
 *   SYNC      they step at your rate, offset half a stride (you stop,
             they are mid-stride)
 *   SURFACE   each step uses the floor THEY stand on - a metallic ring
 *             means they are in the storage corridor, whatever you're on
 *   REALIZE   when you stop they take exactly two more steps, then
 *             silence. That gap is where the horror lives
 *   ENVELOPE  imperceptible far away, swelling as they close, and cut to
 *             dead silence inside 3 m - the hush right before contact
 *
 * Fully procedural Web Audio: filtered white-noise bursts following the
 * surfaces.ts conventions (carpet thud / tile click / metal ring /
 * splash slosh), pitched down and darkened so they never quite sound
 * like YOUR footsteps. No asset files.
 *
 * The AudioContext is optional at construction; without one the class
 * runs logic-only (step clock, trailing count, distance envelope) and
 * records what it would have played in 'fired' - which is how the
 * headless test exercises it.
 *
 * Determinism: every scheduling roll (buffer offset, pitch/volume jitter)
 * draws from a per-instance deterministic stream seeded by the optional
 * constructor seed XOR a site salt (same construction as crowd.ts); the
 * stream is local so the file stays directly runnable under node's
 * TypeScript stripping. Math.random appears ONLY inside the noise-buffer fill.
 */

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

export type SurfaceKind = 'carpet' | 'tile' | 'metal' | 'splash';

const SURFACES: readonly string[] = ['carpet', 'tile', 'metal', 'splash'];

/** Walking cadence in seconds per step (the player's nominal stride). */
export const STEP_INTERVAL = 0.52;

/** Mirror-steps land halfway between the player's steps. */
export const MIRROR_OFFSET = STEP_INTERVAL / 2;

/** Steps the watcher takes after the player stops before going quiet. */
export const TRAIL_STEPS = 2;



/** Distance envelope landmarks, in metres. */
export const CUT_DIST = 3;       // at/inside this: dead silence
const PLATEAU_NEAR = 4;          // fade-to-silence zone ends here
const PLATEAU_FAR = 10;          // full volume plateau starts here
const FAR_DIST = 26;             // at/beyond this: imperceptible

/** Default seed for the voice-jitter stream when none is injected. */
const DEFAULT_SEED = 0xa30ac6e5;
/** Site salt separating this file's stream from other consumers of a seed. */
const SEED_SALT = 0x51c7;

/**
 * Loudness of the watcher's steps at a given distance, 0..1.
 * Squared curves keep the far range genuinely imperceptible and make the
 * close-in fade feel like a cut rather than a slide.
 */
export function approachGain(dist: number): number {
  if (!(dist > CUT_DIST) || dist >= FAR_DIST) return 0;
  if (dist >= PLATEAU_FAR) {
    const t = (FAR_DIST - dist) / (FAR_DIST - PLATEAU_FAR);
    return t * t;
  }
  if (dist <= PLATEAU_NEAR) {
    const t = (dist - CUT_DIST) / (PLATEAU_NEAR - CUT_DIST);
    return t * t * 0.6;
  }
  return 1;
}

/** Lowpass corner for distance muffling: far steps arrive dark. */
function muffleHz(dist: number): number {
  const d = Math.min(Math.max(dist, CUT_DIST), FAR_DIST);
  const t = 1 - (d - CUT_DIST) / (FAR_DIST - CUT_DIST); // 0 far .. 1 near
  return 500 + t * t * 11500;
}

interface FiredStep {
  surface: SurfaceKind;
  /** Envelope loudness 0..1 at the moment of the step. */
  gain: number;
}

/**
 * Mirror-steps for one watcher. Feed update() once per frame; it keeps
 * its own step clock aligned to the player's movement state.
 */
export class WatcherSteps {
  private readonly ctx: AudioContext | null;
  private readonly out: AudioNode | null;
  /** Master loudness of everything the watcher contributes. */
  private readonly master: GainNode | null;
  /** Distance darkening ahead of the voices. */
  private readonly muffle: BiquadFilterNode | null;
  private readonly noise: AudioBuffer | null;
  /** Persistent voice stream: buffer offsets and per-step jitter. */
  private readonly rng: () => number;

  /** Step clock: seconds until the next watcher step fires. */
  private timer = STEP_INTERVAL;
  /** True while the player is walking (and so is the watcher). */
  private moving = false;
  /** Remaining post-stop steps in the realization window. */
  private trailing = 0;

  /**
   * What has been stepped (most recent last, capped) - the logic-only
   * audit trail used by the headless test and by wiring code that wants
   * to react to a step (e.g. screen bleed).
   */
  readonly fired: FiredStep[] = [];

  constructor(ctx: AudioContext | null, destination: AudioNode | null, seed = DEFAULT_SEED) {
    this.ctx = ctx;
    this.out = destination;
    this.rng = mulberry32((seed ^ SEED_SALT) >>> 0);
    if (!ctx || !destination) {
      this.master = null;
      this.muffle = null;
      this.noise = null;
      return;
    }
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = muffleHz(FAR_DIST);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.muffle).connect(destination);

    // Shared 1 s white-noise buffer for every watcher step voice.
    const len = Math.max(1, Math.floor(ctx.sampleRate));
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    // audio DSP buffer fill — sim PRNG law carve-out
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  /**
   * Advance the watcher by dt seconds.
   * @param watcherDist straight-line distance to the watcher, or null
   *                    when untracked/unspawned (steps pause, silence)
   * @param playerMoving whether the player is currently walking
   * @param surface floor material UNDER THE WATCHER, not the player
   */
  update(dt: number, watcherDist: number | null, playerMoving: boolean, surface: string): void {
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25; // tab-back frame spike guard

    const kind = normalizeSurface(surface);
    const gain = watcherDist === null ? 0 : approachGain(watcherDist);
    this.applyEnvelope(watcherDist, gain);

    if (watcherDist === null) {
      // Untracked: hold position in the stride, say nothing.
      return;
    }

    if (playerMoving && !this.moving) {
      // Fresh start (or resumed mid-trailing): re-sync to the mirror.
      this.moving = true;
      this.trailing = 0;
      this.timer = MIRROR_OFFSET;
    } else if (!playerMoving && this.moving) {
      // The horrible realization: two more steps, then nothing.
      this.moving = false;
      this.trailing = TRAIL_STEPS;
    }

    if (!this.moving && this.trailing <= 0) {
      this.timer = STEP_INTERVAL; // parked mid-gap, ready to mirror again
      return;
    }

    this.timer -= dt;
    while (this.timer <= 0) {
      this.step(kind, gain);
      if (!this.moving) {
        this.trailing--;
        if (this.trailing <= 0) {
          this.timer = STEP_INTERVAL;
          break;
        }
      }
      this.timer += STEP_INTERVAL;
    }
  }

  /** Hard stop: clear the trail, cut the bus to silence immediately. */
  stop(): void {
    this.moving = false;
    this.trailing = 0;
    this.timer = STEP_INTERVAL;
    const g = this.master;
    const ctx = this.ctx;
    if (g && ctx) {
      g.gain.cancelScheduledValues(ctx.currentTime);
      g.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    }
  }

  /** Record one step and voice it if it would be audible. */
  private step(surface: SurfaceKind, gain: number): void {
    this.fired.push({ surface, gain });
    if (this.fired.length > 64) this.fired.shift();
    if (!this.ctx || !this.noise || !this.master) return;
    if (gain < 0.004) return; // below perception: don't burn voices on it
    this.voice(surface, gain);
  }

  /** Smoothly track the distance envelope on the shared output bus. */
  private applyEnvelope(dist: number | null, gain: number): void {
    const g = this.master;
    const m = this.muffle;
    const ctx = this.ctx;
    if (!g || !m || !ctx) return;
    g.gain.setTargetAtTime(gain, ctx.currentTime, 0.08);
    m.frequency.setTargetAtTime(
      dist === null ? muffleHz(FAR_DIST) : muffleHz(dist),
      ctx.currentTime,
      0.12,
    );
  }

  // ---- voices -----------------------------------------------------------
  // surfaces.ts conventions, pitched down (~15%) and lengthened so the
  // watcher never sounds quite like the player's own feet.

  private burst(rate: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.playbackRate.value = rate;
    return src;
  }

  private env(peak: number, dur: number, t0: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    return g;
  }

  /** Route one filtered burst through the shared envelope into the bus. */
  private emit(src: AudioBufferSourceNode, chain: AudioNode, dur: number): void {
    chain.connect(this.master!);
    src.start(this.ctx!.currentTime, this.rng() * 0.5, dur + 0.05);
  }

  private voice(surface: SurfaceKind, loud: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const jit = () => 1 + (this.rng() * 2 - 1) * 0.10;
    const pitch = 0.85 * jit(); // heavier than a player stride
    const vol = loud * jit();

    switch (surface) {
      case 'carpet': {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 200 * pitch;
        f.Q.value = 0.7;
        const g = this.env(vol * 0.14, 0.1, t);
        this.emit(this.burst(pitch), f.connect(g), 0.1);
        break;
      }
      case 'metal': {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 800 * pitch;
        bp.Q.value = 14;
        const g = this.env(vol * 0.09, 0.24, t);
        const partial = ctx.createBiquadFilter();
        partial.type = 'bandpass';
        partial.frequency.value = 800 * 2.76 * pitch;
        partial.Q.value = 18;
        const pg = this.env(vol * 0.032, 0.17, t);
        const src = this.burst(pitch);
        this.emit(src, bp.connect(g), 0.24);
        this.emit(src, partial.connect(pg), 0.17);
        break;
      }
      case 'splash': {
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(320 * pitch, t);
        hp.frequency.exponentialRampToValueAtTime(3400 * pitch, t + 0.14);
        hp.Q.value = 0.9;
        const g = this.env(vol * 0.16, 0.14, t);
        this.emit(this.burst(pitch), hp.connect(g), 0.14);
        break;
      }
      case 'tile':
      default: {
        const src = this.burst(pitch);
        const clickHp = ctx.createBiquadFilter();
        clickHp.type = 'highpass';
        clickHp.frequency.value = 1800 * pitch;
        const clickG = this.env(vol * 0.09, 0.004, t);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1000 * pitch;
        bp.Q.value = 2.2;
        const tailG = this.env(vol * 0.06, 0.06, t + 0.002);
        this.emit(src, clickHp.connect(clickG), 0.01);
        this.emit(src, bp.connect(tailG), 0.06);
        break;
      }
    }
  }
}

/** Unknown floor labels fall back to carpet rather than staying silent. */
function normalizeSurface(surface: string): SurfaceKind {
  return SURFACES.includes(surface) ? (surface as SurfaceKind) : 'carpet';
}


