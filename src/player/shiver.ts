/**
 * Cold-storage shiver (F76).
 *
 * Inside a cold zone the player shivers: a teeth-chatter envelope
 * oscillating around ~6 Hz with seeded per-cycle period jitter, and a
 * view-shiver amplitude coupled to the chatter at the fixed ratio
 * VIEW_SHIVER_RATIO. Entering cold ramps the drive in over RAMP_IN_S,
 * leaving ramps it out over RAMP_OUT_S; outside cold with the drive
 * fully decayed every output is exactly zero, so temperate rooms can
 * never leak motion into the camera rig.
 *
 * Pure simulation logic: no Babylon imports. game.ts injects the zone
 * list (temperature classes) and feeds update() a timestep plus the
 * player position; mount sites read `sample` each frame. All randomness
 * flows from src/core/rng.ts keyed by the session seed, so a given seed
 * + timeline replays identically.
 */
import { RNG } from '../core/rng';

/** Zone temperature classes understood by the model. */
export type TemperatureClass = 'cold' | 'temperate';

/** A circular zone carrying one temperature class. */
export interface ColdZone {
  x: number;
  z: number;
  /** Radius in meters; the player is inside when within this distance. */
  radius: number;
  temperature: TemperatureClass;
}

/** One frame of shiver output for consumers. */
export interface ShiverSample {
  /**
   * Chatter envelope in [0, 1]: 0 is still, 1 is full teeth chatter.
   * Exactly 0 outside cold zones once the exit ramp has decayed.
   */
  chatter: number;
  /**
   * View-shiver amplitude in [0, VIEW_SHIVER_RATIO]; equals `chatter`
   * times VIEW_SHIVER_RATIO exactly (fixed coupling ratio).
   */
  viewShiverAmp: number;
}

/** Base teeth-chatter frequency in cycles per second. */
export const BASE_CHATTER_HZ = 6;
/** Half-width of the seeded per-cycle multiplicative period jitter. */
export const CHATTER_JITTER_FRACTION = 0.08;
/** Exact multiplier from chatter envelope to view-shiver amplitude. */
export const VIEW_SHIVER_RATIO = 0.35;
/** Seconds to reach full drive after entering a cold zone. */
export const RAMP_IN_S = 2;
/** Seconds to decay to zero after leaving every cold zone. */
export const RAMP_OUT_S = 3;

const TWO_PI = Math.PI * 2;

/**
 * One jittered chatter period in seconds, drawn from `rng`: the base
 * period scaled by a factor in [1 - CHATTER_JITTER_FRACTION,
 * 1 + CHATTER_JITTER_FRACTION]. Consumes exactly one RNG draw.
 */
export function jitteredPeriodS(rng: RNG): number {
  return (1 / BASE_CHATTER_HZ) * (1 + (rng.next() * 2 - 1) * CHATTER_JITTER_FRACTION);
}

/**
 * Active temperature class at a point: 'cold' when any cold zone
 * contains it, else 'temperate'.
 *
 * @param zones Injected zone layout; may be empty.
 * @returns The resolved temperature class under the point.
 */
export function temperatureAt(zones: readonly ColdZone[], x: number, z: number): TemperatureClass {
  for (const zone of zones) {
    if (zone.temperature !== 'cold') continue;
    const dx = x - zone.x, dz = z - zone.z;
    if (dx * dx + dz * dz <= zone.radius * zone.radius) return 'cold';
  }
  return 'temperate';
}

/**
 * Drives the shiver across one session. Feed every frame with the
 * player position over the injected zones; read `sample` afterwards.
 * Junk timesteps (NaN, infinite, negative) are ignored whole, so a
 * broken frame can never corrupt the ramp or phase state.
 */
export class ColdShiver {
  private readonly rng: RNG;
  private zones: readonly ColdZone[];
  private drive = 0;
  private phase = 0;
  private periodS: number;
  private sample_: ShiverSample = { chatter: 0, viewShiverAmp: 0 };

  constructor(seed: number, zones: readonly ColdZone[] = []) {
    this.rng = new RNG((seed >>> 0) ^ 0x5417e2);
    this.zones = zones;
    this.periodS = jitteredPeriodS(this.rng);
  }

  /** Swap the zone layout between ticks (zones may open/close over time). */
  setZones(zones: readonly ColdZone[]): void {
    this.zones = [...zones];
  }

  /**
   * Advance one tick using zone containment under the player position.
   *
   * @param dt Frame timestep in seconds; non-finite or negative values
   *   advance nothing.
   * @param playerX Player x used for zone containment.
   * @param playerZ Player z used for zone containment.
   */
  update(dt: number, playerX: number, playerZ: number): void {
    this.updateTemp(dt, temperatureAt(this.zones, playerX, playerZ));
  }

  /**
   * Advance one tick from an already-resolved temperature class, for
   * mounts whose zone lookup lives elsewhere.
   *
   * @param dt Frame timestep in seconds; non-finite or negative values
   *   advance nothing.
   * @param temperature Injected temperature class this frame.
   */
  updateTemp(dt: number, temperature: TemperatureClass): void {
    if (!Number.isFinite(dt) || dt <= 0) {
      this.sample_ = this.currentSample();
      return;
    }
    const inCold = temperature === 'cold';
    if (inCold) this.drive = Math.min(1, this.drive + dt / RAMP_IN_S);
    else this.drive = Math.max(0, this.drive - dt / RAMP_OUT_S);
    // Floating-point subtraction leaves ~1e-16 residue at the end of the
    // exit ramp; snap it so the zero outside cold zones is exact.
    if (this.drive < 1e-12) this.drive = 0;

    let remaining = dt / this.periodS;
    while (remaining > 0) {
      const step = Math.min(remaining, 1 - this.phase);
      this.phase += step;
      remaining -= step;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.periodS = jitteredPeriodS(this.rng);
      }
    }
    this.sample_ = this.currentSample();
  }

  /** Latest computed frame sample; exactly zero at zero drive. */
  get sample(): ShiverSample {
    return this.sample_;
  }

  // ---------------------------------------------------------------------------

  private currentSample(): ShiverSample {
    if (this.drive === 0) return { chatter: 0, viewShiverAmp: 0 };
    const chatter = this.drive * (0.5 - 0.5 * Math.cos(TWO_PI * this.phase));
    return { chatter, viewShiverAmp: chatter * VIEW_SHIVER_RATIO };
  }
}
