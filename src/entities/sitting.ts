/**
 * Sitting behavior.
 *
 * Sometimes a reconstructed human remembers benches. It walks to one,
 * turns to face the way the bench faces, and lowers itself to seated
 * height -- then sits for a minute or two, facing whatever pews face,
 * which is nothing. Believers feel this pull strongest near CHAPEL pews.
 *
 * Pure simulation logic: no Babylon imports. One SittingBehavior drives
 * one figure; update() consumes a timestep plus the figure's current
 * pose and returns whether it is sitting and where it should move.
 *
 * Seat claims live in a module-level registry so two figures can never
 * be steered onto the same bench, even across independent behavior
 * instances. Claims expire if their owner stops updating them.
 */
import { RNG } from '../core/rng';

/** A sittable spot on a bench/chair prop, fed in via setSeats(). */
export interface SeatPose {
  x: number;
  z: number;
  /** Direction the seat faces (radians). Figures align to this. */
  yaw: number;
  /** Tagged true for CHAPEL pews; believers strongly prefer these. */
  chapel?: boolean;
}

/** Minimal figure pose the behavior needs each tick. */
export interface SittingFigureState {
  x: number;
  z: number;
  yaw: number;
  /** Archetype name; 'believer' unlocks the CHAPEL preference. */
  type?: string;
}

/** What the caller should do with the figure this tick. */
export interface SittingResult {
  /** True from the moment the figure starts settling into the seat. */
  sitting: boolean;
  /** X movement to apply this tick (meters). */
  moveX: number;
  /** Z movement to apply this tick (meters). */
  moveZ: number;
  /** Yaw the figure should face this tick (radians). */
  yaw: number;
}

/** Walk speed while steering toward a claimed seat (m/s). */
const APPROACH_SPEED = 1.2;
/** Distance at which a figure starts settling into the seat (m). */
const SETTLE_DIST = 0.35;
/** Seconds spent lowering into the seat once close enough. */
const SETTLE_TIME = 0.9;

/**
 * One behavior instance drives one figure. The seed selects both whether
 * the figure feels the pull to sit at all and which kind of seat it
 * prefers, so replays are deterministic for a given seed + seat layout.
 */
export class SittingBehavior {
  /** The seat this figure has claimed, or null while unseated. */
  claimedSeat: SeatPose | null = null;

  private readonly rnd: () => number;
  private seats: readonly SeatPose[] = [];
  private decided = false;
  private willSit = false;
  private settleLeft = 0;
  private seated = false;
  private readonly instanceId = ++INSTANCE_COUNTER;

  constructor(seed: number) {
    this.rnd = mulberry32(seed >>> 0);
  }

  /**
   * Feed the sittable spots visible in this landmark room.
   * @param seats seats on offer; chapel-tagged ones pull believers
   */
  setSeats(seats: readonly SeatPose[]): void {
    this.seats = seats;
  }

  /**
   * Advance one tick.
   * @param dt seconds since the previous frame
   * @param fig the figure's current pose
   * @returns what the caller should do with the figure this tick
   */
  update(dt: number, fig: SittingFigureState): SittingResult {
    // First tick decides whether this figure feels the pull at all.
    if (!this.decided) {
      this.decided = true;
      const pullBase = fig.type === 'believer' ? 0.8 : 0.45;
      this.willSit = this.rnd() < pullBase;
    }

    if (!this.willSit || this.seats.length === 0) {
      return noOp(fig);
    }

    // Claim a seat once.
    if (!this.claimedSeat) {
      const seat = this.claim(this.seats, fig.type === 'believer', fig);
      if (!seat) return noOp(fig);
      this.claimedSeat = seat;
      this.settleLeft = SETTLE_TIME;
      this.refreshClaim(seat);
    }

    const seat = this.claimedSeat!;
    const dx = seat.x - fig.x;
    const dz = seat.z - fig.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Still walking over?
    if (dist > SETTLE_DIST) {
      this.seated = false;
      const step = Math.min(dist, APPROACH_SPEED * dt);
      this.refreshClaim(seat);
      return { sitting: false, moveX: (dx / dist) * step, moveZ: (dz / dist) * step, yaw: Math.atan2(dx, dz) };
    }

    // Settle down, then just sit facing whatever pews face.
    if (this.settleLeft > 0) {
      this.settleLeft -= dt;
      return { sitting: true, moveX: 0, moveZ: 0, yaw: seat.yaw };
    }
    this.seated = true;
    this.refreshClaim(seat);
    return { sitting: true, moveX: 0, moveZ: 0, yaw: seat.yaw };
  }

  /**
   * Release every claim this instance holds (figure despawned, disturbed,
   * or the room is going away).
   */
  releaseAll(): void {
    if (this.claimedSeat) releaseClaim(this.claimedSeat, this.instanceId);
    this.claimedSeat = null;
    this.decided = false;
    this.willSit = false;
    this.seated = false;
    this.settleLeft = 0;
  }

  // ---------------------------------------------------------------------------

  /**
   * Try to claim a seat fitting this figure's taste. Believers beeline for
   * CHAPEL pews when any exist; everyone else takes the nearest plain seat.
   * Seats currently claimed by another live owner are skipped.
   */
  private claim(candidates: readonly SeatPose[], believer: boolean, fig: SittingFigureState): SeatPose | null {
    expireStaleClaims();
    const free = candidates.filter((s) => !isClaimedByOther(s, this.instanceId));
    if (free.length === 0) return null;

    let pool = free;
    if (believer) {
      const pews = free.filter((s) => s.chapel);
      if (pews.length > 0) pool = pews;
    } else {
      const plain = free.filter((s) => !s.chapel);
      if (plain.length > 0) pool = plain;
    }

    // Nearest first with a little seeded jitter so crowds spread out.
    let best: SeatPose | null = null;
    let bestScore = Infinity;
    for (const s of pool) {
      const d = (s.x - fig.x) ** 2 + (s.z - fig.z) ** 2;
      const score = d + this.rnd() * 4;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    if (best) CLAIMS.set(best, { owner: this.instanceId, seen: nowSec() });
    return best;
  }

  private refreshClaim(seat: SeatPose): void {
    CLAIMS.set(seat, { owner: this.instanceId, seen: nowSec() });
  }
}

// ---------------------------------------------------------------------------
// Module-level claim registry: two figures can never share a bench.
// ---------------------------------------------------------------------------

interface ClaimRecord { owner: number; seen: number }

const CLAIMS = new Map<SeatPose, ClaimRecord>();
let INSTANCE_COUNTER = 0;

/** Monotonic clock for claim staleness (seconds). */
let CLOCK = 0;
function nowSec(): number {
  CLOCK += 1e-4;
  return CLOCK;
}

/** Drop claims whose owner stopped refreshing them (default 2 s). */
function expireStaleClaims(now = nowSec(), ttl = 2): void {
  for (const [seat, rec] of CLAIMS) {
    if (now - rec.seen > ttl) CLAIMS.delete(seat);
  }
}

function isClaimedByOther(seat: SeatPose, selfId: number): boolean {
  const rec = CLAIMS.get(seat);
  return rec !== undefined && rec.owner !== selfId;
}

function releaseClaim(seat: SeatPose, ownerId: number): void {
  const rec = CLAIMS.get(seat);
  if (rec && rec.owner === ownerId) CLAIMS.delete(seat);
}

/** Idle result: keep the figure where it is, facing as it was. */
function noOp(fig: SittingFigureState): SittingResult {
  return { sitting: false, moveX: 0, moveZ: 0, yaw: fig.yaw };
}

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
