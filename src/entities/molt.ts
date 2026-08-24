/**
 * F62 Watcher molt — vacated skins keep watching.
 *
 * When an injected watcher despawn event fires, the watcher's shed skin
 * stays behind at its last position with the same silhouette. The molt is
 * inert: it never moves, never stalks, never vocalizes - yet it counts as
 * a watcher for player-proximity fear math, so the dread of being watched
 * outlives the watcher itself.
 *
 * Each molt decays after a seeded lifetime drawn from 60-120 s (deterministic
 * per (seed, watcherId)), or immediately on direct touch by the player.
 * At most MAX_ALIVE_MOLTS molts exist at once; spawning past the bound
 * evicts the oldest skin first.
 *
 * Pure logic - no DOM, no Babylon. Determinism law holds: every draw flows
 * through src/core/rng.ts hashes keyed per watcher id, so identical despawn
 * timelines replay identically per seed regardless of call ordering.
 */
import { hash2i } from '../core/rng';

/** Salt so molt draws never correlate with any other feature. */
const MOLT_SALT = 0xf62;

/** Minimum decay lifetime of one molt, in seconds. */
export const MOLT_LIFETIME_MIN_S = 60;

/** Maximum decay lifetime of one molt, in seconds. */
export const MOLT_LIFETIME_MAX_S = 120;

/** Hard cap on simultaneously alive molts. */
export const MAX_ALIVE_MOLTS = 3;

/** Player distance considered a direct touch, in metres. */
export const TOUCH_RADIUS_M = 0.9;

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
 * One injected watcher despawn: the moment a live watcher leaves the sim.
 * The position is the watcher's LAST observed position - where the skin lands.
 */
export interface WatcherDespawnEvent {
  /** Stable id of the despawning watcher; keys its molt's seeded lifetime. */
  readonly watcherId: number;
  /** Silhouette identifier carried over verbatim onto the molt. */
  readonly silhouetteId: string;
  /** Last position of the watcher before despawn. */
  readonly pos: Vec2;
  /** Simulation seconds at despawn. */
  readonly timeS: number;
}

/**
 * One vacated watcher skin left behind by a despawn.
 */
export interface MoltDecoy {
  /** Watcher whose skin this was; also the decoy's stable identity. */
  readonly watcherId: number;
  /** Same silhouette id the living watcher wore. */
  readonly silhouetteId: string;
  /** Where the skin rests. */
  readonly pos: Vec2;
  /** Simulation second the molt appeared. */
  readonly spawnTimeS: number;
  /** Seeded decay deadline in simulation seconds (spawnTimeS + lifetime). */
  readonly expireTimeS: number;
}

/** Why a molt stopped existing. */
export type MoltRemovalReason = 'decayed' | 'touched' | 'evicted';

/**
 * A molt removed from the pool, with the cause.
 */
export interface RemovedMolt {
  /** The decoy that was removed. */
  readonly decoy: MoltDecoy;
  /** What ended it. */
  readonly reason: MoltRemovalReason;
}

/**
 * Seeded decay lifetime for one watcher's molt, uniform over the 60-120 s
 * band. Deterministic per (seed, watcherId) - independent of spawn order.
 * @param seed Master run seed.
 * @param watcherId Watcher the skin belonged to.
 * @returns Lifetime in seconds within [MOLT_LIFETIME_MIN_S, MOLT_LIFETIME_MAX_S].
 */
export function moltLifetimeS(seed: number, watcherId: number): number {
  const u = hash2i(watcherId, 0, seed ^ MOLT_SALT) / 4294967296;
  return MOLT_LIFETIME_MIN_S + u * (MOLT_LIFETIME_MAX_S - MOLT_LIFETIME_MIN_S);
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/**
 * Molt pool fed by injected watcher despawn events. Owns nothing but skins:
 * callers keep rendering and fear math on their side, reading aliveDecoys()
 * / fearSources() each frame.
 */
export class MoltSystem {
  private readonly seed: number;
  private alive: MoltDecoy[];

  /**
   * @param seed Master run seed; keys every molt lifetime.
   */
  constructor(seed: number) {
    this.seed = seed;
    this.alive = [];
  }

  /**
   * Ingest one watcher despawn and leave its skin behind. No-op when the
   * same watcher already has a living molt (a watcher despawns once, but
   * replays must be idempotent). Enforces the MAX_ALIVE_MOLTS bound by
   * evicting the oldest skin when full.
   * @param evt Despawn event from the caller's watcher tracking.
   * @returns The molt created, or null when the input was ignored.
   */
  onDespawn(evt: WatcherDespawnEvent): MoltDecoy | null {
    if (this.alive.some((d) => d.watcherId === evt.watcherId)) return null;
    // Enforce the bound before appending: oldest skin goes first.
    if (this.alive.length >= MAX_ALIVE_MOLTS) this.evictOldest();
    const lifetime = moltLifetimeS(this.seed, evt.watcherId);
    const decoy: MoltDecoy = {
      watcherId: evt.watcherId,
      silhouetteId: evt.silhouetteId,
      pos: evt.pos,
      spawnTimeS: evt.timeS,
      expireTimeS: evt.timeS + lifetime,
    };
    this.alive.push(decoy);
    return decoy;
  }

  /**
   * Drop the oldest living skin to make room for a new one.
   * @returns The evicted decoy.
   */
  private evictOldest(): MoltDecoy {
    // alive is append-ordered, so index 0 is always the oldest spawn.
    const [oldest] = this.alive.splice(0, 1);
    return oldest;
  }

  /**
   * Advance time: expire skins past their seeded lifetime and destroy skins
   * directly touched by the player. Call once per frame with current sim time.
   * @param nowS Current simulation seconds.
   * @param playerPos Player position for touch detection.
   * @returns Molts removed by this call (expired or touched), in removal order.
   */
  update(nowS: number, playerPos: Vec2): RemovedMolt[] {
    const removed: RemovedMolt[] = [];
    const r2 = TOUCH_RADIUS_M * TOUCH_RADIUS_M;
    this.alive = this.alive.filter((d) => {
      if (nowS >= d.expireTimeS) {
        removed.push({ decoy: d, reason: 'decayed' });
        return false;
      }
      if (dist2(d.pos, playerPos) <= r2) {
        removed.push({ decoy: d, reason: 'touched' });
        return false;
      }
      return true;
    });
    return removed;
  }

  /**
   * All currently living molts, oldest spawn first. Callers must not mutate.
   */
  get decoys(): readonly MoltDecoy[] {
    return this.alive;
  }

  /**
   * Fear-math view: the molts standing in as watchers right now. While a
   * molt lives it appears here exactly like a live watcher would; after
   * decay or touch it vanishes. Injected consumers fold these positions
   * into player-proximity fear alongside real watchers.
   * @returns Living decoys contributing watcher presence.
   */
  fearSources(): readonly MoltDecoy[] {
    return this.alive;
  }
}
