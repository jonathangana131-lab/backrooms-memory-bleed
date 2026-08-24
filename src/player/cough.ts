/**
 * Contamination cough (F71).
 *
 * Inside a contamination zone the player coughs on a seeded schedule:
 * the inter-cough interval interpolates from 45 s in clean air to 6 s at
 * full saturation, with ±15% seeded jitter per draw. Outside every zone
 * (saturation 0) no cough ever fires. Each event carries an intensity
 * proportional to the active saturation and a seeded duration, so audio
 * and UI can grade the fit without re-deriving it.
 *
 * Pure simulation logic: no Babylon imports. game.ts injects the zone
 * list and feeds update() a timestep plus the player position; events
 * accumulate in `events` for consumers to drain.
 * All randomness flows from src/core/rng.ts keyed by the session seed,
 * so a given seed + input timeline replays identically.
 */
import { RNG } from '../core/rng';

/** A circular contamination zone with its own saturation level. */
export interface ContaminationZone {
  x: number;
  z: number;
  /** Radius in meters; the player is inside when within this distance. */
  radius: number;
  /** Saturation in [0, 1]: 0 = harmless air, 1 = fully saturated. */
  saturation: number;
}

/** One fired cough. */
export interface CoughEvent {
  /** Session time in seconds at which the cough fired. */
  timeS: number;
  /** Equal to the active saturation in (0, 1]; 0 never fires. */
  intensity: number;
  /** Seeded audible length in seconds. */
  durationS: number;
}

/** Clean-air inter-cough interval in seconds. */
export const CLEAN_INTERVAL_S = 45;
/** Fully saturated inter-cough interval in seconds. */
export const SATURATED_INTERVAL_S = 6;
/** Half-width of the per-draw multiplicative jitter around the base interval. */
export const JITTER_FRACTION = 0.15;
/** Seeded cough-length band in seconds. */
const MIN_DURATION_S = 0.3;
const MAX_DURATION_S = 0.8;

/**
 * Base (unjittered) inter-cough interval for a saturation level:
 * linear interpolation from CLEAN_INTERVAL_S at s=0 down to
 * SATURATED_INTERVAL_S at s=1.
 */
export function baseIntervalS(saturation: number): number {
  return CLEAN_INTERVAL_S + (SATURATED_INTERVAL_S - CLEAN_INTERVAL_S) * clamp01(saturation);
}

/**
 * One jittered interval draw in [base * (1 - JITTER_FRACTION),
 * base * (1 + JITTER_FRACTION)], consuming exactly one RNG draw so
 * callers can reproduce any draw index deterministically.
 */
export function jitteredIntervalS(saturation: number, rng: RNG): number {
  return baseIntervalS(saturation) * (1 + (rng.next() * 2 - 1) * JITTER_FRACTION);
}

/** Active saturation at a point: max over zones containing it, else 0. */
export function saturationAt(zones: readonly ContaminationZone[], x: number, z: number): number {
  let s = 0;
  for (const zone of zones) {
    const dx = x - zone.x, dz = z - zone.z;
    if (dx * dx + dz * dz <= zone.radius * zone.radius) s = Math.max(s, clamp01(zone.saturation));
  }
  return s;
}

/**
 * Drives the cough schedule for one session. Feed every frame with the
 * player position; read or drain `events` afterwards.
 */
export class ContaminationCough {
  private readonly seed: number;
  private zones: readonly ContaminationZone[];
  private readonly rng: RNG;

  private nowS = 0;
  private elapsedInZoneS = 0;
  private scheduledS: number | null = null;
  private events_: CoughEvent[] = [];

  constructor(seed: number, zones: readonly ContaminationZone[] = []) {
    this.seed = seed >>> 0;
    this.zones = zones;
    this.rng = new RNG(this.seed ^ 0xc0ff);
  }

  /** Swap the zone layout between ticks (zones may open/close over time). */
  setZones(zones: readonly ContaminationZone[]): void {
    this.zones = [...zones];
  }

  /**
   * Advance one tick. The in-zone timer only advances while the player
   * stands inside some zone; outside, time still passes but nothing
   * accumulates and nothing can fire.
   */
  update(dt: number, playerX: number, playerZ: number): void {
    this.nowS += dt;
    const s = saturationAt(this.zones, playerX, playerZ);
    if (s <= 0) return;
    this.elapsedInZoneS += dt;
    if (this.scheduledS === null) this.scheduledS = this.drawInterval(s);
    while (this.elapsedInZoneS >= this.scheduledS) {
      this.elapsedInZoneS -= this.scheduledS;
      this.events_.push({ timeS: this.nowS, intensity: s, durationS: this.rng.range(MIN_DURATION_S, MAX_DURATION_S) });
      this.scheduledS = this.drawInterval(s);
    }
  }

  /** Events fired so far in session order; grows until drained. */
  get events(): readonly CoughEvent[] {
    return this.events_;
  }

  /** Hand the accumulated events to a consumer and reset the buffer. */
  drainEvents(): CoughEvent[] {
    const out = this.events_;
    this.events_ = [];
    return out;
  }

  // ---------------------------------------------------------------------------

  private drawInterval(s: number): number {
    return jitteredIntervalS(s, this.rng);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
