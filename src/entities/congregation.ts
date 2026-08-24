/**
 * F25 Believer congregations — chapel landmarks host kneeling night services.
 *
 * The believers remember congregation even though they cannot remember
 * being anyone. At night a chapel fills: attendees walk in from the dark,
 * kneel in rings facing the altar point for the service, then disperse
 * outward along the rays they came in on — never across the altar.
 *
 * Pure simulation logic (no Babylon imports), matching schedules.ts.
 * The caller mounts attendee transforms and feeds the day-phase clock:
 * `dayPhase` is an injected provider returning the fraction of the local
 * day cycle in [0, 1), so tests drive every transition deterministically
 * and the game can wire it to its own time-of-day source.
 */
import { RNG } from '../core/rng';

// ---- tuning ------------------------------------------------------------------

/** Nominal arc distance between adjacent seats on a ring (metres). */
export const SEAT_SPACING = 1.25;
/** Hard floor for any two seats (and any two live attendees) in metres. */
export const MIN_SEAT_DIST = 0.8;
/** Collision radius of one kneeling attendee (matches HumanFigure bodies). */
export const ATTENDEE_RADIUS = 0.3;
/** Innermost ring radius around the altar point; also the altar clearance. */
export const INNER_RING_RADIUS = 2.4;
/** Radial gap between consecutive rings (metres). */
export const RING_GAP = 1.1;
/** Dispersal/entry targets sit this far beyond each seat along its ray. */
export const RAY_STANDOFF = 6;
/** Walk speed while gathering or dispersing (m/s). */
export const WALK_SPEED = 0.6;

/** Day-phase fraction where gathering begins. */
export const SERVICE_START = 0.8;
/** Day-phase fraction where attendees kneel. */
export const KNEEL_START = 0.85;
/** Day-phase fraction where kneel ends and dispersal begins. */
export const SERVICE_END = 0.93;
/** Day-phase fraction where everyone has gone and the chapel sits empty. */
export const DISPERSE_END = 0.97;

/** Stream salt for the formation's seeded jitter draws. */
const FORMATION_SALT = 0xc066 >>> 0;

export type ServicePhase = 'idle' | 'gathering' | 'kneel' | 'disperse';
export type AttendeePose = 'stand' | 'walk' | 'kneel';

/** One assigned kneeling spot, yaw facing the altar point. */
export interface Seat {
  x: number;
  z: number;
  /** facing yaw toward the altar (repo convention: atan2(dx, dz)) */
  yaw: number;
  /** 0-based ring index; ring 0 is closest to the altar */
  ring: number;
}

/**
 * Service phase for a day-phase fraction. All windows are non-wrapping so
 * the night service always sits inside one [0, 1) pass of the cycle.
 */
export function servicePhaseAt(dayPhase: number): ServicePhase {
  if (dayPhase < SERVICE_START || dayPhase >= DISPERSE_END) return 'idle';
  if (dayPhase < KNEEL_START) return 'gathering';
  if (dayPhase < SERVICE_END) return 'kneel';
  return 'disperse';
}

/** Everything the constructor needs; altar defaults to the chapel center. */
export interface CongregationOptions {
  centerX: number;
  centerZ: number;
  altarX?: number;
  altarZ?: number;
  count: number;
  seed: number;
  /** injected day-phase provider returning [0, 1); queried every update() */
  dayPhase: () => number;
}

/** Live state of one attendee, driven by update(). */
export interface AttendeeState {
  readonly seat: Seat;
  x: number;
  z: number;
  yaw: number;
  pose: AttendeePose;
  /** true only after this attendee reached its seat during gathering */
  seated: boolean;
}

/**
 * Generate the kneeling formation: concentric rings centred on the altar
 * point, every seat facing it. Deterministic per seed — same seed returns
 * byte-identical seats, different seeds jitter ring rotations independently.
 *
 * Spacing guarantee: capacity per ring reserves headroom for the seeded
 * angular jitter, so the worst-case neighbour chord stays >= MIN_SEAT_DIST;
 * cross-ring neighbours are separated by RING_GAP radially. Both bounds
 * exceed 2 * ATTENDEE_RADIUS, so no two attendees ever overlap.
 *
 * @param altarX Altar point x; rings are centred here.
 * @param altarZ Altar point z.
 * @param count Attendees to place; fewer than capacity is fine.
 * @param seed Deterministic formation seed.
 * @returns Seats ordered inner ring first.
 */
export function generateFormation(
  altarX: number,
  altarZ: number,
  count: number,
  seed: number,
): Seat[] {
  const rng = new RNG((seed ^ FORMATION_SALT) >>> 0);
  // headroom factor: worst-case opposite jitters shrink an arc by (1-2*JITTER)
  const JITTER_FRACTION = 0.15;
  const effectiveSpacing = SEAT_SPACING / (1 - 2 * JITTER_FRACTION);
  const seats: Seat[] = [];
  let ring = 0;
  while (seats.length < count) {
    const r = INNER_RING_RADIUS + ring * RING_GAP;
    const capacity = Math.max(1, Math.floor((Math.PI * 2 * r) / effectiveSpacing));
    const baseAngle = rng.next() * Math.PI * 2;
    const slotArc = (Math.PI * 2) / capacity;
    for (let i = 0; i < capacity && seats.length < count; i++) {
      const ang = baseAngle + i * slotArc + (rng.next() - 0.5) * 2 * JITTER_FRACTION * slotArc;
      const x = altarX + Math.cos(ang) * r;
      const z = altarZ + Math.sin(ang) * r;
      seats.push({ x, z, yaw: Math.atan2(altarX - x, altarZ - z), ring });
    }
    ring++;
  }
  return seats;
}

/** Point on the attendee's ray this far beyond (negative: before) the seat. */
function rayPoint(altarX: number, altarZ: number, seat: Seat, beyond: number): { x: number; z: number } {
  const dx = seat.x - altarX;
  const dz = seat.z - altarZ;
  const d = Math.hypot(dx, dz);
  const k = (d + beyond) / d;
  return { x: altarX + dx * k, z: altarZ + dz * k };
}

/**
 * One chapel's night service. Feed update(dt) per frame; read `phase`,
 * `attendees`, and `poseOf` to mount visuals/audio. The provider is queried
 * every update so external time changes take effect immediately.
 */
export class Congregation {
  readonly seats: readonly Seat[];
  readonly attendees: AttendeeState[] = [];
  /** phase observed at the most recent update() */
  phase: ServicePhase = 'idle';

  private readonly altarX: number;
  private readonly altarZ: number;

  constructor(opts: CongregationOptions) {
    this.altarX = opts.altarX ?? opts.centerX;
    this.altarZ = opts.altarZ ?? opts.centerZ;
    this.seats = generateFormation(this.altarX, this.altarZ, opts.count, opts.seed);
    // attendees start out at their dispersal stand-off points: the same ray
    // they will leave along, so entry and exit both skirt the altar
    for (const seat of this.seats) {
      const entry = rayPoint(this.altarX, this.altarZ, seat, RAY_STANDOFF);
      this.attendees.push({
        seat,
        x: entry.x,
        z: entry.z,
        yaw: seat.yaw,
        pose: 'stand',
        seated: false,
      });
    }
    this.phase = servicePhaseAt(opts.dayPhase());
  }

  /**
   * Advance one frame. Phase comes straight from the injected provider;
   * poses follow the phase exactly — 'kneel' poses exist only during the
   * kneel phase, never before or after.
   */
  update(dt: number, dayPhase: () => number): void {
    const phase = servicePhaseAt(dayPhase());
    this.phase = phase;
    for (const a of this.attendees) {
      switch (phase) {
        case 'gathering': {
          a.pose = 'walk';
          a.seated = false;
          this.stepToward(a, a.seat.x, a.seat.z, dt);
          break;
        }
        case 'kneel': {
          a.pose = 'kneel';
          a.x = a.seat.x;
          a.z = a.seat.z;
          a.yaw = a.seat.yaw;
          a.seated = true;
          break;
        }
        case 'disperse': {
          a.pose = 'walk';
          a.seated = false;
          const exit = rayPoint(this.altarX, this.altarZ, a.seat, RAY_STANDOFF);
          this.stepToward(a, exit.x, exit.z, dt);
          break;
        }
        case 'idle': {
          a.pose = 'stand';
          break;
        }
      }
    }
  }

  /** Pose of attendee i (mount helper; mirrors attendees[i].pose). */
  poseOf(i: number): AttendeePose {
    return this.attendees[i].pose;
  }

  /** Straight-line dispersal target for attendee i (never crosses the altar). */
  exitTarget(i: number): { x: number; z: number } {
    return rayPoint(this.altarX, this.altarZ, this.seats[i], RAY_STANDOFF);
  }

  private stepToward(a: AttendeeState, tx: number, tz: number, dt: number): void {
    const dx = tx - a.x;
    const dz = tz - a.z;
    const d = Math.hypot(dx, dz);
    if (d <= WALK_SPEED * dt || d < 1e-6) {
      a.x = tx;
      a.z = tz;
      return;
    }
    a.x += (dx / d) * WALK_SPEED * dt;
    a.z += (dz / d) * WALK_SPEED * dt;
    a.yaw = Math.atan2(dx, dz);
  }
}
