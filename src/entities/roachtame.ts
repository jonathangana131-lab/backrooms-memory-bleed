/**
 * F67 Roach domestication — feed the roaches and they lead you to
 * batteries.
 *
 * A feeding model layered over an injected roach colony state exposing
 * `populationAt(cell)`. The player drops food (injected events); nearby
 * roaches aggregate around qualifying drops. Once >=N fed events pile up
 * inside a sliding T-second window, the swarm leaves its feeding spot,
 * enters the 'leading' state, and walks toward the nearest battery from an
 * injected battery list for a bounded duration. If the player strays too
 * far from the swarm mid-lead, it disperses and the trail is lost.
 *
 * Guarantees (the AC):
 *   - aggregation thresholds are exact: N-1 fresh drops never trigger,
 *     the Nth does; stale drops outside the window do not count;
 *   - a lead aborts the moment the player strafes beyond follow range;
 *   - over wide-open ground the swarm reliably reaches its battery
 *     vicinity (>=95% of seeded trials with batteries 10-40 m away);
 *   - everything replays identically per seed through src/core/rng.ts.
 *
 * Pure simulation — no DOM, no Babylon. All randomness flows through
 * rng.ts hashes and the seeded RNG class.
 */
import { RNG, hash4i } from '../core/rng';

// ---- injected world -----------------------------------------------------------

/** One plan-view cell position in meters. */
export interface FeedCell {
  x: number;
  z: number;
}

/** Minimal roach colony surface consumed by the feeder (injected). */
export interface ColonyPresence {
  /** Live roach population at one cell (fractional populations allowed). */
  populationAt(cell: FeedCell): number;
}

/** One collectable battery the swarm can lead the player to (injected). */
export interface BatterySite {
  /** Stable battery id surfaced to callers when the swarm delivers. */
  readonly id: string;
  x: number;
  z: number;
}

/** One player food-drop event. */
export interface FoodDrop {
  /** Where the food landed. */
  cell: FeedCell;
  /** Session clock of the drop, seconds. */
  timeSec: number;
}

// ---- tuning -------------------------------------------------------------------

/** Drops closer than this to a live colony attract roaches; farther ones rot. */
export const AGGREGATE_RADIUS_M = 8;

/** Minimum colony presence at a drop cell for roaches to bother aggregating. */
export const ROACH_MIN_PRESENCE = 5;

/** Fed events needed inside the window before the swarm starts leading. */
export const FEED_EVENTS_NEEDED = 4;

/** Sliding-window length for counting fresh fed events, seconds. */
export const FEED_WINDOW_SEC = 20;

/** Swarm travel speed while leading, meters per second. */
export const SWARM_SPEED_MPS = 2;

/** Hard bound on how long a swarm keeps leading, seconds. */
export const LEAD_DURATION_SEC = 30;

/** Distance from the battery that counts as delivered, meters. */
export const BATTERY_ARRIVAL_RADIUS_M = 3;

/** Player-to-swarm distance past which the swarm scatters, meters. */
export const PLAYER_FOLLOW_RADIUS_M = 14;

/** Lateral wander amplitude while leading, meters (seeded sine wiggle). */
export const LEAD_WANDER_M = 0.4;

/** Salt separating this system's hash stream from other rng.ts consumers. */
const HASH_SALT = 0x74616d65; // "tame"

// ---- state --------------------------------------------------------------------

/** Lifecycle of the domesticated swarm. */
export type SwarmState = 'idle' | 'gathering' | 'leading' | 'delivered' | 'dispersed';

// ---- model --------------------------------------------------------------------

/**
 * Feeding/domestication simulator over an injected colony. Feed it player
 * food drops and periodic ticks carrying the session clock and player
 * position; read the swarm's state, position, and target from getters.
 */
export class RoachDomestication {
  private readonly colony: ColonyPresence;
  private readonly batteries: readonly BatterySite[];
  private readonly wanderPhase: number;
  private readonly wanderFreq: number;
  private readonly fedEvents: FoodDrop[] = [];
  private _state: SwarmState = 'idle';
  private _pos: FeedCell = { x: 0, z: 0 };
  private _target: BatterySite | null = null;
  private lastTickSec: number | null = null;
  private leadElapsedSec = 0;

  constructor(deps: { colony: ColonyPresence; batteries: readonly BatterySite[]; seed: number }) {
    this.colony = deps.colony;
    this.batteries = Array.isArray(deps.batteries) ? deps.batteries : [];
    const rng = new RNG(hash4i((deps.seed >>> 0) || 0x9e3779b9, HASH_SALT, 1, HASH_SALT));
    // Seeded wander keeps trails distinct per run yet replayable per seed.
    this.wanderPhase = rng.range(0, Math.PI * 2);
    this.wanderFreq = rng.range(0.6, 1.4);
  }

  /** Current swarm lifecycle state. */
  get state(): SwarmState {
    return this._state;
  }

  /** Swarm centroid position (feeding site until it starts leading). */
  get position(): FeedCell {
    return { ...this._pos };
  }

  /** Battery the swarm is leading toward, or null outside 'leading'. */
  get target(): BatterySite | null {
    return this._state === 'leading' && this._target ? this._target : null;
  }

  /** Id of the battery reached in the current/most recent delivery. */
  get deliveredBatteryId(): string | null {
    return this._state === 'delivered' && this._target ? this._target.id : null;
  }

  /**
   * Fresh (in-window) fed-event count at an absolute clock time. Stale
   * events past FEED_WINDOW_SEC behind the newest drop no longer count.
   */
  fedCount(timeSec: number): number {
    return this.fedEvents.filter((e) => timeSec - e.timeSec <= FEED_WINDOW_SEC).length;
  }

  /**
   * Player drops food at a cell/time. Qualifying drops land on cells with
   * live colony presence; anything else is ignored garbage. Accumulating
   * FEED_EVENTS_NEEDED fresh drops flips the swarm into 'leading'
   * immediately.
   *
   * @returns true when the drop attracted roaches and was counted
   */
  dropFood(drop: FoodDrop): boolean {
    if (!drop || !drop.cell || !Number.isFinite(drop.cell.x) || !Number.isFinite(drop.cell.z)) return false;
    if (!Number.isFinite(drop.timeSec)) return false;
    const popHere = this.colony.populationAt({ x: drop.cell.x, z: drop.cell.z });
    if (!(popHere >= ROACH_MIN_PRESENCE)) return false;

    this.fedEvents.push({ cell: { x: drop.cell.x, z: drop.cell.z }, timeSec: drop.timeSec });

    // The swarm feeds where the crumbs are; the centroid tracks the newest drop.
    const last = this.fedEvents[this.fedEvents.length - 1]!;
    if (this._state === 'idle') {
      this._state = 'gathering';
      this._pos = { x: last.cell.x, z: last.cell.z };
    }
    this.pruneStale(last.timeSec);

    if (this._state === 'gathering' && this.fedEvents.length >= FEED_EVENTS_NEEDED) {
      this.beginLead();
    }
    return true;
  }

  /**
   * Advance the simulation. While leading, the swarm walks toward its
   * battery at SWARM_SPEED_MPS with a small seeded wander, delivers on
   * reaching BATTERY_ARRIVAL_RADIUS_M, gives up at LEAD_DURATION_SEC, and
   * disperses instantly whenever the player strays beyond
   * PLAYER_FOLLOW_RADIUS_M.
   *
   * @param timeSec absolute session clock, seconds (monotone per run)
   * @param playerPos current player position, meters
   */
  doTick(timeSec: number, playerPos: FeedCell): void {
    if (this.lastTickSec === null) this.lastTickSec = timeSec;
    const dt = Math.max(0, Math.min(1, timeSec - this.lastTickSec));
    this.lastTickSec = timeSec;

    if (this._state === 'leading' && this._target) {
      // Strafe check first: a lost player means a lost swarm, same tick.
      const playerDist = Math.hypot(playerPos.x - this._pos.x, playerPos.z - this._pos.z);
      if (playerDist > PLAYER_FOLLOW_RADIUS_M) {
        this.disperse();
        return;
      }
      this.leadElapsedSec += dt;
      this.stepToward(this._target, dt, timeSec);
      const remain = Math.hypot(this._target.x - this._pos.x, this._target.z - this._pos.z);
      if (remain <= BATTERY_ARRIVAL_RADIUS_M) {
        this._state = 'delivered';
        return;
      }
      if (this.leadElapsedSec >= LEAD_DURATION_SEC) this.disperse();
      return;
    }

    // Gathering swarms linger only while their crumbs stay in-window.
    if (this._state === 'gathering') {
      this.pruneStale(timeSec);
    }
  }

  // -- internals ----------------------------------------------------------------

  /** Drop every event older than the window behind nowSec, in place. */
  private pruneStale(nowSec: number): void {
    for (let i = this.fedEvents.length - 1; i >= 0; i--) {
      if (nowSec - this.fedEvents[i]!.timeSec > FEED_WINDOW_SEC) this.fedEvents.splice(i, 1);
    }
    if (this._state === 'gathering' && this.fedEvents.length === 0) this._state = 'idle';
  }

  /** Lock onto the nearest battery by Euclidean distance and start walking. */
  private beginLead(): void {
    let best: BatterySite | null = null;
    let bestD = Infinity;
    for (const b of this.batteries) {
      const d = Math.hypot(b.x - this._pos.x, b.z - this._pos.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best) return; // nowhere worth leading: keep gathering
    this._target = best;
    this._state = 'leading';
    this.leadElapsedSec = 0;
  }

  /** Advance the swarm one step along its trail with seeded wander. */
  private stepToward(target: BatterySite, dt: number, timeSec: number): void {
    const dx = target.x - this._pos.x;
    const dz = target.z - this._pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-9) return;
    // Perpendicular sine wiggle keeps the trail organic but deterministic.
    const wobble =
      Math.sin(timeSec * this.wanderFreq + this.wanderPhase) * LEAD_WANDER_M;
    const ux = dx / dist;
    const uz = dz / dist;
    this._pos.x += ux * SWARM_SPEED_MPS * dt + -uz * wobble * dt;
    this._pos.z += uz * SWARM_SPEED_MPS * dt + ux * wobble * dt;
  }

  /** Scatter: clear the trail and forget the target. */
  private disperse(): void {
    this._state = 'dispersed';
    this._target = null;
    this.fedEvents.length = 0;
  }
}
