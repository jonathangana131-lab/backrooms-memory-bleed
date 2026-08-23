/**
 * Emergency lighting: battery-backed backup units that wake up during
 * blackouts. A sparse, DETERMINISTIC subset of each chunk's ceiling
 * fixtures (every 7th) carries an emergency head; most burn dim red,
 * a few carry the green tint of an illuminated EXIT sign. Each unit
 * pulses on a slow 0.5 Hz sine - the wheeze of batteries that have
 * been waiting years for exactly this moment.
 *
 * The selection logic is pure (no Babylon), so it can be driven and
 * verified headlessly; only the light pool itself touches the scene.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import type { Scene } from '@babylonjs/core/scene';

/** one emergency unit per N-th fixture of the chunk */
export const EMERGENCY_STRIDE = 7;

/** pulse frequency in Hz: one slow breath every 2 s */
export const PULSE_HZ = 0.5;

/** pooled point lights (chunks never expose more than this) */
const POOL = 12;

/** hanging height of the fixtures these units piggyback on (see LightingRig) */
const FIXTURE_Y = 2.86;

/** dim on purpose: these are dying batteries, not work lights */
const RED_INTENSITY = 0.85;
const EXIT_INTENSITY = 1.05;
const RANGE = 10.5;

const RED = new Color3(0.92, 0.14, 0.07);
const EXIT_GREEN = new Color3(0.16, 0.95, 0.38);

export interface FixturePos { x: number; z: number }
export interface EmergencyUnit { x: number; z: number; exit: boolean; phase: number }

/** stable 0..1 hash from two coordinates (order-sensitive, no randomness) */
export function coordHash(x: number, z: number): number {
  let h = Math.imul(Math.floor(x * 1000) | 0, 0x27d4eb2d)
        ^ Math.imul(Math.floor(z * 1000) | 0, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Deterministic per-chunk placement: every EMERGENCY_STRIDE-th fixture
 * gets a battery-backed unit. ~20% of those are EXIT-sign green instead
 * of red, keyed off the fixture's own coordinates so the same chunk
 * always wires the same units.
 */
export function selectEmergencyUnits(fixtures: readonly FixturePos[]): EmergencyUnit[] {
  const units: EmergencyUnit[] = [];
  for (let i = 0; i < fixtures.length; i++) {
    if (i % EMERGENCY_STRIDE !== 0) continue;
    const f = fixtures[i];
    units.push({
      x: f.x,
      z: f.z,
      exit: coordHash(f.x, f.z) < 0.2,
      phase: coordHash(f.z + 31.7, f.x - 17.3) * Math.PI * 2,
    });
  }
  return units;
}

/**
 * Slow sine pulse in [0.1, 1] at PULSE_HZ - bright enough to read,
 * sluggish enough to sound like a failing cell.
 */
export function emergencyPulse(t: number, phase = 0): number {
  return 0.55 + 0.45 * Math.sin(2 * Math.PI * PULSE_HZ * t + phase);
}

export class EmergencyLights {
  private pool: PointLight[] = [];
  private units: EmergencyUnit[] = [];
  private active = false;
  private t = 0;
  private tmpColor = new Color3();

  constructor(scene: Scene) {
    for (let i = 0; i < POOL; i++) {
      const l = new PointLight('em' + i, new Vector3(0, -100, 0), scene);
      l.range = RANGE;
      l.intensity = 0;
      this.pool.push(l);
    }
  }

  /** Bind the battery units to a freshly loaded chunk's fixture list. */
  prepare(chunkFixtures: readonly FixturePos[]): void {
    this.units = selectEmergencyUnits(chunkFixtures);
  }

  /**
   * Drive the units. Outside blackouts everything stays dark; during a
   * blackout the first POOL units glow and pulse (extras stay parked -
   * the nearest chunks re-prepare as the player moves anyway).
   */
  update(dt: number, blackout: boolean): void {
    this.active = blackout;
    if (!blackout) {
      for (const l of this.pool) {
        l.intensity = 0;
        l.position.set(0, -100, 0);
      }
      return;
    }
    this.t += dt;
    for (let i = 0; i < this.pool.length; i++) {
      const l = this.pool[i];
      const u = this.units[i];
      if (!u) {
        l.intensity = 0;
        continue;
      }
      l.position.set(u.x, FIXTURE_Y, u.z);
      const target = u.exit ? EXIT_GREEN : RED;
      this.tmpColor.copyFrom(target);
      l.diffuse = this.tmpColor.clone();
      l.intensity = (u.exit ? EXIT_INTENSITY : RED_INTENSITY) * emergencyPulse(this.t, u.phase);
    }
  }

  /** Hard-off: blackout over or rig torn down. */
  deactivate(): void {
    this.active = false;
    for (const l of this.pool) {
      l.intensity = 0;
      l.position.set(0, -100, 0);
    }
  }
}


