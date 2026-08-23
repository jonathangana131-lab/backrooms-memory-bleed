/**
 * Patrol routines.
 *
 * Wanderers and believers walk the same small loops they walked before
 * the Backrooms took their memories. Nobody remembers choosing the route;
 * the route was chosen by a hash of where they first appeared.
 *
 * Shift work: an entity stays on its rounds for a few minutes, then
 * stops wherever it is and stands very still for a while -- harder to
 * notice, easier to miss. Watchers are exempt. Watchers are always on duty.
 *
 * Pure simulation logic: no Babylon imports. update() consumes a timestep
 * and a speed and returns the velocity vector the caller should apply.
 */
import { RNG, hash32 } from '../core/rng';

export interface Waypoint {
  x: number;
  z: number;
}

export interface PatrolVelocity {
  vx: number;
  vz: number;
}

export interface PatrolOptions {
  /**
   * Watchers never rest. Their loop still runs, but the shift cycle
   * never enters the standing-still phase.
   */
  alwaysOn?: boolean;
  /** Max turn rate in rad/s while homing toward a waypoint. Default 1.8. */
  maxTurnRate?: number;
  /** Consider the waypoint reached within this many metres. Default 1.2. */
  arrivalRadius?: number;
}

/** Active shift length bounds, seconds (3-5 minutes). */
const ACTIVE_MIN = 180;
const ACTIVE_MAX = 300;
/** Rest break length bounds, seconds (1-2 minutes). */
const REST_MIN = 60;
const REST_MAX = 120;
/** Waypoint dwell time bounds, seconds (2-5s). */
const DWELL_MIN = 2;
const DWELL_MAX = 5;

function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class PatrolSchedule {
  /** The deterministic loop this entity walks, relative to nothing. */
  readonly waypoints: readonly Waypoint[];

  private readonly rng: RNG;
  private readonly opts: Required<Pick<PatrolOptions, 'alwaysOn' | 'maxTurnRate' | 'arrivalRadius'>>;

  /** Internal clock, advanced only by update(). */
  private life = 0;
  /** Current facing; turns interpolate toward the target bearing. */
  private heading: number;
  /** Index of the waypoint being walked toward. */
  private wpIndex = 0;
  /** Sim-clock instant the current waypoint dwell ends (-1 while walking). */
  private dwellUntil = -1;
  /** Integrated position estimate, used only to detect arrivals. */
  private estX: number;
  private estZ: number;
  /** Current shift-cycle boundaries. */
  private activeEnd: number;
  private restEnd: number;
  private restingNow = false;

  constructor(spawnX: number, spawnZ: number, seed: number, options: PatrolOptions = {}) {
    // Seed the routine from both the entity's own seed and where it spawned,
    // so the same seed in different corridors walks different loops.
    const kx = Math.round(spawnX * 16) | 0;
    const kz = Math.round(spawnZ * 16) | 0;
    const loopSeed = hash32(seed ^ hash32(kx) ^ Math.imul(hash32(kz), 0x9e3779b1));
    this.rng = new RNG(loopSeed);
    this.opts = {
      alwaysOn: options.alwaysOn ?? false,
      maxTurnRate: options.maxTurnRate ?? 1.8,
      arrivalRadius: options.arrivalRadius ?? 1.2,
    };

    // 4-6 waypoints on a jittered ring, 8-20m out from the spawn point.
    const count = this.rng.int(4, 7);
    const baseAngle = this.rng.next() * Math.PI * 2;
    const pts: Waypoint[] = [];
    for (let i = 0; i < count; i++) {
      const angle = baseAngle + (i / count) * Math.PI * 2 + this.rng.range(-0.35, 0.35);
      const radius = this.rng.range(8, 20);
      pts.push({ x: spawnX + Math.sin(angle) * radius, z: spawnZ + Math.cos(angle) * radius });
    }
    this.waypoints = pts;

    this.estX = spawnX;
    this.estZ = spawnZ;
    this.heading = Math.atan2(pts[0].x - spawnX, pts[0].z - spawnZ);

    // First shift begins immediately; rest lengths roll per cycle.
    this.activeEnd = this.rng.range(ACTIVE_MIN, ACTIVE_MAX);
    this.restEnd = this.activeEnd + this.rng.range(REST_MIN, REST_MAX);
  }

  /** True while off duty: standing still, harder to notice. */
  get resting(): boolean {
    return this.restingNow;
  }

  /** Which waypoint of the loop the entity currently walks toward. */
  get targetIndex(): number {
    return this.wpIndex;
  }

  /**
   * Advance the routine by dt seconds at the given walking speed.
   * Returns the velocity vector to apply this frame (zero while dwelling
   * at a waypoint or resting through a break).
   */
  update(dt: number, speed: number): PatrolVelocity {
    if (!(dt > 0)) return { vx: 0, vz: 0 };
    const step = Math.min(dt, 0.25); // clamp big frames so turns stay gentle
    this.life += step;

    // --- shift-work cycle ---
    if (!this.opts.alwaysOn) {
      if (!this.restingNow && this.life >= this.activeEnd) {
        this.restingNow = true;
        this.dwellUntil = -1;
      } else if (this.restingNow && this.life >= this.restEnd) {
        // back on duty; roll the next shift
        this.restingNow = false;
        this.activeEnd = this.life + this.rng.range(ACTIVE_MIN, ACTIVE_MAX);
        this.restEnd = this.activeEnd + this.rng.range(REST_MIN, REST_MAX);
      }
    }
    if (this.restingNow) return { vx: 0, vz: 0 };

    // --- waypoint dwell ---
    if (this.life < this.dwellUntil) return { vx: 0, vz: 0 };

    // --- home toward the current waypoint ---
    const wp = this.waypoints[this.wpIndex];
    const desired = Math.atan2(wp.x - this.estX, wp.z - this.estZ);
    const da = angleDelta(this.heading, desired);
    const maxTurn = this.opts.maxTurnRate * step;
    this.heading += Math.max(-maxTurn, Math.min(maxTurn, da));

    const vx = Math.sin(this.heading) * speed;
    const vz = Math.cos(this.heading) * speed;
    this.estX += vx * step;
    this.estZ += vz * step;

    // arrived? dwell a moment, then take the next leg of the loop
    if (Math.hypot(wp.x - this.estX, wp.z - this.estZ) <= this.opts.arrivalRadius) {
      this.wpIndex = (this.wpIndex + 1) % this.waypoints.length;
      this.dwellUntil = this.life + this.rng.range(DWELL_MIN, DWELL_MAX);
      return { vx: 0, vz: 0 };
    }
    return { vx, vz };
  }
}

/** Convenience factory for watchers: patrols forever, never rests. */
export function watcherPatrol(spawnX: number, spawnZ: number, seed: number): PatrolSchedule {
  return new PatrolSchedule(spawnX, spawnZ, seed, { alwaysOn: true });
}


