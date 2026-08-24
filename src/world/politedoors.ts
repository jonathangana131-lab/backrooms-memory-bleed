/**
 * F69 Polite Doors — doors that open for you, then close behind you.
 *
 * Each injected door watches the player's motion. When the player walks
 * TOWARD a door inside {@link APPROACH_RADIUS_M}, it opens itself over an
 * eased curve. It holds fully open until the player has walked
 * {@link PASS_BEHIND_M} metres past the far side along the approach axis,
 * then closes politely. A per-door cooldown armed when closing begins
 * prevents flapping: a door will not reopen until the cooldown expires.
 *
 * Away-motion is inert: if the player's velocity points away from the door,
 * or they are not moving toward it, nothing triggers - even inside the
 * radius, even mid-cooldown expiry.
 *
 * Determinism: every seeded quantity flows through src/core/rng.ts hashes;
 * identical (seed, inputs) replays byte-identical timelines.
 *
 * Pure logic - no DOM, no Babylon. The caller renders openness each frame
 * from advance().
 */
import { RNG, hash2i } from '../core/rng';

/** Salt so polite-door draws never correlate with any other feature. */
const DOORS_SALT = 0xf69;

/** Player must be within this radius and moving toward the door to trigger. */
export const APPROACH_RADIUS_M = 6;

/** Hold ends once the player is this far past the far side of the door. */
export const PASS_BEHIND_M = 2;

/** Minimum seconds from close-start before the same door may reopen. */
export const COOLDOWN_MIN_S = 3;

/** Maximum seconds from close-start before the same door may reopen. */
export const COOLDOWN_MAX_S = 5;

/** Seconds for the 0 -> 1 ease while opening. */
export const OPEN_TIME_S = 0.8;

/** Seconds for the 1 -> 0 ease while closing. */
export const CLOSE_TIME_S = 1.2;

/** Dot-product threshold separating toward-walking from everything else. */
const TOWARD_DOT_MIN = 0.05;

/**
 * Planar world position (metres, x/z ground plane).
 */
export interface Vec2 {
  /** East-west coordinate in metres. */
  readonly x: number;
  /** North-south coordinate in metres. */
  readonly z: number;
}

/**
 * One injectable door: a stable id plus its hinge position in the world.
 */
export interface DoorSpec {
  /** Stable unique id; duplicates fail loud at construction. */
  readonly id: string;
  /** World position of the door plane centre. */
  readonly pos: Vec2;
}

/**
 * Constructor options for one polite-doors set.
 */
export interface PoliteDoorsOpts {
  /** Master run seed; keys per-door cooldown draws. */
  readonly seed: number;
  /** All doors under courtesy control. */
  readonly doors: readonly DoorSpec[];
}

/** Lifecycle phase of a single door. */
export type DoorPhase =
  /** Fully shut; only phase that may transition to 'opening'. */
  | 'closed'
  /** Ease curve rising 0 -> 1 over OPEN_TIME_S. */
  | 'opening'
  /** Held at 1 until the player passes PASS_BEHIND_M beyond the door. */
  | 'open'
  /** Ease curve falling 1 -> 0 over CLOSE_TIME_S; arms the cooldown. */
  | 'closing';

/**
 * Live state of one door as returned by {@link PoliteDoors.state}.
 */
export interface DoorState {
  /** Door id this snapshot describes. */
  readonly id: string;
  /** Lifecycle phase. */
  readonly phase: DoorPhase;
  /** Openness in [0,1]; 0 closed, 1 fully open, eased between. */
  readonly openness: number;
  /** Seconds remaining before this door may reopen; 0 when eligible. */
  readonly cooldownRemainingS: number;
}

interface InternalDoor {
  readonly spec: DoorSpec;
  readonly cooldownS: number;
  phase: DoorPhase;
  openness: number;
  phaseT: number;
  cooldownRemainingS: number;
  /** Unit vector from trigger position toward the door, frozen at trigger. */
  approachDirX: number;
  approachDirZ: number;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Smoothstep ease: exact S-curve used by both opening and closing. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Courtesy coordinator for one run's doors. Feed it the player position
 * every frame; it derives the player velocity from consecutive positions
 * and owns every door's open-hold-close timeline and cooldowns.
 */
export class PoliteDoors {
  private readonly doors: InternalDoor[];
  private readonly byId: Map<string, InternalDoor>;
  private prevPos: Vec2 | null = null;
  private nowS = 0;

  /**
   * Validates every injected door. Duplicate ids fail loud at construction.
   * @param opts Fully specified per-run options.
   */
  constructor(opts: PoliteDoorsOpts) {
    const seen = new Set<string>();
    const rr = new RNG(hash2i(opts.seed, DOORS_SALT, opts.doors.length));
    this.doors = opts.doors.map((spec) => {
      if (seen.has(spec.id)) throw new Error(`politedoors: duplicate door id ${spec.id}`);
      seen.add(spec.id);
      return {
        spec,
        cooldownS: rr.range(COOLDOWN_MIN_S, COOLDOWN_MAX_S),
        phase: 'closed' as DoorPhase,
        openness: 0,
        phaseT: 0,
        cooldownRemainingS: 0,
        approachDirX: 0,
        approachDirZ: 0,
      };
    });
    this.byId = new Map(this.doors.map((d) => [d.spec.id, d]));
  }

  /**
   * Snapshot of one door without advancing time.
   * @param id Door id from the injected specs; unknown ids throw.
   */
  state(id: string): DoorState {
    const d = this.byId.get(id);
    if (!d) throw new Error(`politedoors: unknown door ${id}`);
    return {
      id,
      phase: d.phase,
      openness: d.openness,
      cooldownRemainingS: Math.max(0, d.cooldownRemainingS),
    };
  }

  /**
   * Advance one simulation step.
   *
   * Trigger: a closed door whose cooldown has expired opens when the player
   * is within APPROACH_RADIUS_M AND moving toward it (velocity dot the
   * player-to-door direction above TOWARD_DOT_MIN). Away-motion never
   * triggers.
   *
   * Timeline: opening eases 0 -> 1 over OPEN_TIME_S via smoothstep; the
   * hold keeps openness at exactly 1 until the player's projection onto the
   * frozen approach axis reaches PASS_BEHIND_M beyond the door; closing
   * eases 1 -> 0 over CLOSE_TIME_S and arms the per-door cooldown at
   * close-start.
   * @param dtS Seconds to advance.
   * @param playerPos Player world position this frame.
   */
  advance(dtS: number, playerPos: Vec2): void {
    const dt = Math.max(0, dtS);
    this.nowS += dt;
    let velX = 0;
    let velZ = 0;
    if (this.prevPos && dt > 0) {
      velX = (playerPos.x - this.prevPos.x) / dt;
      velZ = (playerPos.z - this.prevPos.z) / dt;
    }
    this.prevPos = { x: playerPos.x, z: playerPos.z };

    for (const d of this.doors) {
      switch (d.phase) {
        case 'closed': {
          if (d.cooldownRemainingS > 0) {
            d.cooldownRemainingS = Math.max(0, d.cooldownRemainingS - dt);
            break;
          }
          const dx = d.spec.pos.x - playerPos.x;
          const dz = d.spec.pos.z - playerPos.z;
          const range = Math.hypot(dx, dz);
          if (range > APPROACH_RADIUS_M || range < 1e-9) break;
          const invRange = 1 / range;
          const dot = velX * dx * invRange + velZ * dz * invRange;
          if (dot <= TOWARD_DOT_MIN) break;
          d.phase = 'opening';
          d.phaseT = 0;
          d.approachDirX = dx * invRange;
          d.approachDirZ = dz * invRange;
          break;
        }
        case 'opening': {
          d.phaseT += dt;
          const t = Math.min(1, d.phaseT / OPEN_TIME_S);
          d.openness = smoothstep(t);
          if (t >= 1) {
            d.phase = 'open';
            d.phaseT = 0;
          }
          break;
        }
        case 'open': {
          d.openness = 1;
          // Projection along the frozen approach axis: positive values are
          // the far side of the door relative to the trigger position.
          const relX = playerPos.x - d.spec.pos.x;
          const relZ = playerPos.z - d.spec.pos.z;
          const along = relX * d.approachDirX + relZ * d.approachDirZ;
          if (along >= PASS_BEHIND_M) {
            d.phase = 'closing';
            d.phaseT = 0;
            d.cooldownRemainingS = d.cooldownS;
          }
          break;
        }
        case 'closing': {
          d.phaseT += dt;
          const t = Math.min(1, d.phaseT / CLOSE_TIME_S);
          d.openness = 1 - smoothstep(t);
          if (t >= 1) {
            d.phase = 'closed';
            d.phaseT = 0;
          }
          break;
        }
      }
    }
  }
}
