/**
 * Night-vision camcorder (F42): IR mode with gain noise + audio artifacts.
 *
 * A pure mode model for the handheld camcorder. game.ts mounts it by
 * wiring three seams:
 *  - render consumer reads `tint` (green-tint descriptor) and applies it
 *    as a fullscreen grade;
 *  - the audio layer polls `artifactLevel` (pure number - this module never
 *    imports AudioEngine);
 *  - a DrainSink adapter forwards the battery-drain multiplier into
 *    whatever owns charge (e.g. src/player/flashlight.ts).
 *
 * State machine: off -> ramp-in (~0.3 s) -> on -> ramp-out (~0.3 s) -> off.
 * While active it emits a per-frame gain-noise value drawn from the seeded
 * hash stream (src/core/rng.ts law) keyed by frame tick, so identical
 * (seed, tick) pairs replay identically regardless of dt.
 *
 * Battery: an injected level provider drives auto-cutoff at an injected
 * threshold. The cutoff fires ONCE, latches the camera off, and only a
 * manual toggle() re-enables it - a dying cell never flaps the IR mode.
 */
import { rand2 } from '../core/rng';

/** Camera lifecycle states. */
export type NightVisionState = 'off' | 'ramp-in' | 'on' | 'ramp-out';

/** Green-tint descriptor handed to the render consumer, envelope-scaled. */
export interface TintDescriptor {
  r: number;
  g: number;
  b: number;
}

/** Injected battery-drain consumer (adapted onto the torch/charge owner). */
export interface DrainSink {
  /** Receive the current drain multiplier (1 = torch-on baseline). */
  setDrainMultiplier(multiplier: number): void;
}

/** Optional construction parameters; every field has a default. */
export interface NightVisionConfig {
  /** Deterministic seed for the gain-noise stream (src/core/rng.ts law). */
  seed?: number;
  /** Injected battery-level source 0..1; omit or junk disables auto-cutoff. */
  batteryLevel?: () => number;
  /** Auto-cutoff fires at or below this level (default 0.05). */
  cutoffThreshold?: number;
  /** Ramp-in/out duration in seconds (spec: ~0.3 each). */
  rampTime?: number;
}

/** Ramp-in and ramp-out duration in seconds. */
export const NV_RAMP_TIME = 0.3;
/** Drain multiplier while the IR mode is engaged (incl. ramps). */
export const NV_DRAIN_MULTIPLIER = 2.5;
/** Torch-on baseline drain multiplier; NV must exceed this. */
export const NV_BASELINE_DRAIN_MULTIPLIER = 1.0;
/** Default auto-cutoff battery level. */
export const NV_CUTOFF_THRESHOLD = 0.05;

/** Base green-tint descriptor at full envelope. */
export const NV_TINT_BASE: TintDescriptor = { r: 0.22, g: 1.0, b: 0.38 };
/** Audio-artifact loudness per unit of gain noise (bounded result [0,1]). */
export const NV_ARTIFACT_GAIN = 0.8;

function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

/**
 * Night-vision camcorder mode model. Feed update() once per frame; poll
 * state/tint/gainNoise/artifactLevel for the render + audio consumers.
 */
export class NightVision {
  private readonly seed: number;
  private readonly drain: DrainSink | null;
  private readonly batteryLevel: (() => number) | null;
  private readonly threshold: number;
  private readonly rampTime: number;

  private stateValue: NightVisionState = 'off';
  private env = 0;
  private tickValue = 0;
  private noise = 0;
  private latch = false;
  private cutoffs = 0;

  constructor(drain: DrainSink | null, config?: NightVisionConfig) {
    this.drain = drain && typeof drain.setDrainMultiplier === 'function' ? drain : null;
    this.seed =
      Number.isFinite(config?.seed) ? (config!.seed! >>> 0) : 0x1eca7a;
    this.batteryLevel =
      config?.batteryLevel && typeof config.batteryLevel === 'function'
        ? config.batteryLevel
        : null;
    this.threshold = Number.isFinite(config?.cutoffThreshold)
      ? clamp01(config!.cutoffThreshold!)
      : NV_CUTOFF_THRESHOLD;
    this.rampTime = Number.isFinite(config?.rampTime) && config!.rampTime! > 0
      ? Math.min(1, config!.rampTime!)
      : NV_RAMP_TIME;
    this.pushDrain();
  }

  /**
   * User toggle. Clears an auto-cutoff latch (manual re-enable) and flips
   * the ramp direction.
   * @returns true when the requested end state is enabled
   */
  toggle(): boolean {
    if (this.stateValue === 'off' || this.stateValue === 'ramp-out') {
      this.latch = false;
      this.stateValue = 'ramp-in';
      this.pushDrain();
      return true;
    }
    this.stateValue = 'ramp-out';
    this.pushDrain();
    return false;
  }

  /**
   * Advance the machine one frame.
   * @param dt frame delta in seconds (non-finite/negative treated as 0)
   */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    this.tickValue++;

    // -- envelope ramp --
    if (this.stateValue === 'ramp-in') {
      this.env += step / this.rampTime;
      if (this.env >= 1) {
        this.env = 1;
        this.stateValue = 'on';
      }
    } else if (this.stateValue === 'ramp-out') {
      this.env -= step / this.rampTime;
      if (this.env <= 0) {
        this.env = 0;
        this.stateValue = 'off';
        this.latch = false; // a normal power-down is not a cutoff latch
        this.pushDrain(); // hand the charge owner back its baseline drain
      }
    }

    // -- auto-cutoff: fires once, then requires a manual toggle --
    if (
      this.env > 0 &&
      !this.latch &&
      this.batteryLevel !== null
    ) {
      const level = this.batteryLevel();
      if (Number.isFinite(level) && level <= this.threshold) {
        this.cutoffs++;
        this.latch = true;
        this.env = 0;
        this.stateValue = 'off';
        this.pushDrain();
      }
    }

    // -- per-frame gain noise, keyed strictly by (seed, tick): identical
    //    ticks replay identically no matter what dt stream produced them --
    this.noise = rand2(this.tickValue, this.seed, 0x4e7);
  }

  /**
   * Forward the current drain multiplier through the injected sink.
   * @returns the multiplier that was pushed
   */
  private pushDrain(): number {
    const mult =
      this.env > 0 || this.stateValue === 'ramp-in' || this.stateValue === 'ramp-out'
        ? NV_DRAIN_MULTIPLIER
        : NV_BASELINE_DRAIN_MULTIPLIER;
    this.drain?.setDrainMultiplier(mult);
    return mult;
  }

  /** Current lifecycle state. */
  get state(): NightVisionState {
    return this.stateValue;
  }

  /** Ramp envelope 0..1 (0 fully off, 1 fully engaged). */
  get envelope(): number {
    return this.env;
  }

  /** Frame tick of the most recent update(); keys the noise stream. */
  get tick(): number {
    return this.tickValue;
  }

  /**
   * Gain-noise value for the current tick, bounded [0,1]; deterministic
   * per (seed, tick) and independent of the dt stream. Render/audio
   * consumers weight it by `envelope`, which is 0 while fully off.
   */
  get gainNoise(): number {
    return this.noise;
  }

  /**
   * Green-tint descriptor for the render consumer, scaled by the ramp
   * envelope so the grade fades with the mode.
   */
  get tint(): TintDescriptor {
    return {
      r: NV_TINT_BASE.r * this.env,
      g: NV_TINT_BASE.g * this.env,
      b: NV_TINT_BASE.b * this.env,
    };
  }

  /**
   * Audio-artifact level for the existing audio layer (pure number in
   * [0,1]); tracks gain noise linearly so hiss follows the picture.
   */
  get artifactLevel(): number {
    return clamp01(this.noise * NV_ARTIFACT_GAIN) * (this.env > 0 ? 1 : 0);
  }

  /** True after an auto-cutoff until a manual toggle clears it. */
  get isCutoffLatched(): boolean {
    return this.latch;
  }

  /** How many times the auto-cutoff has fired (monotone counter). */
  get cutoffCount(): number {
    return this.cutoffs;
  }
}
