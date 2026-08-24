/**
 * Shadow audience (F70).
 *
 * During director peaks, reconstructed onlookers gather as silhouettes at
 * the far ends of halls, facing the player. They never approach: the
 * audience exists only while tension holds a peak. Dropping below the
 * peak threshold scatters everyone instantly; walking straight at a
 * silhouette scatters that one instantly. The next peak gathers a fresh
 * crowd with fresh seeds, so no two peaks look alike.
 *
 * Pure simulation logic: no Babylon imports. game.ts injects a tension
 * provider and the hall-end position list; update() consumes a timestep
 * plus the player position and maintains the alive silhouette set.
 * All randomness flows from src/core/rng.ts keyed by (seed, peak index),
 * so a given seed + input timeline replays identically.
 */
import { RNG, hash2i } from '../core/rng';

/** A world-space point on the XZ plane (meters). */
export interface HallEnd {
  x: number;
  z: number;
}

/** One gathered silhouette the renderer should draw. */
export interface Silhouette {
  /** Unique across the session; never reused after a scatter. */
  id: number;
  x: number;
  z: number;
  /** Facing direction in radians; aimed at the player at spawn time. */
  yaw: number;
}

/** Injected tension source (director tension normalized to [0, 1]). */
export type TensionProvider = () => number;

/** Tunables for one ShadowAudience instance. */
export interface ShadowAudienceOptions {
  /** Tension at or above which the moment counts as a peak. */
  gatherThreshold?: number;
  /** Direct-approach distance (m) that scatters a silhouette instantly. */
  scatterRadius?: number;
  /**
   * Hard cap on simultaneously alive silhouettes (also the count at the
   * deepest possible peak).
   */
  maxCount?: number;
}

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_SCATTER_RADIUS = 3.5;
const DEFAULT_MAX_COUNT = 6;
/** Position jitter half-width around a hall end (m). */
const JITTER = 0.6;

/**
 * Drives the shadow audience for one session. Feed it every frame with
 * the current player position; read `silhouettes` afterwards to render.
 */
export class ShadowAudience {
  private readonly tension: TensionProvider;
  private readonly ends: readonly HallEnd[];
  private readonly seed: number;
  private readonly threshold: number;
  private readonly scatterRadius: number;
  private readonly maxCount: number;

  private alive: Silhouette[] = [];
  /** Index of the most recent gathering; fresh seeds come from it. */
  private peakIndex = 0;
  /** True once the current peak was consumed by a scatter; re-arms below threshold. */
  private peakSpent = false;
  /** Largest crowd this gathering has grown to; crowds never shrink mid-peak. */
  private peakCrowd = 0;
  /** Heads approach-scattered from this gathering; those slots stay empty. */
  private lostToApproach = 0;
  private nextId = 0;
  private spawnOrder: readonly HallEnd[] = [];
  private spawnRng = new RNG(1);

  constructor(tension: TensionProvider, hallEnds: readonly HallEnd[], seed: number, options: ShadowAudienceOptions = {}) {
    if (hallEnds.length === 0) throw new Error('ShadowAudience requires at least one hall end');
    this.tension = tension;
    this.ends = hallEnds;
    this.seed = seed >>> 0;
    this.threshold = options.gatherThreshold ?? DEFAULT_THRESHOLD;
    this.scatterRadius = options.scatterRadius ?? DEFAULT_SCATTER_RADIUS;
    this.maxCount = Math.max(1, Math.floor(options.maxCount ?? DEFAULT_MAX_COUNT));
  }

  /**
   * Advance one tick.
   * @param _dt seconds since the previous frame (gating is instantaneous)
   * @param playerX player world X
   * @param playerZ player world Z
   */
  update(_dt: number, playerX: number, playerZ: number): void {
    const t = clamp01(this.tension());

    if (this.alive.length > 0) {
      // Direct approach scatters exactly the silhouette(s) walked into, and
      // those slots stay empty for the rest of this gathering.
      const r2 = this.scatterRadius * this.scatterRadius;
      const before = this.alive.length;
      this.alive = this.alive.filter((s) => dist2(s.x, s.z, playerX, playerZ) > r2);
      this.lostToApproach += before - this.alive.length;
      // Tension drop scatters everyone instantly.
      if (t < this.threshold) this.alive = [];
      if (this.alive.length === 0) {
        this.peakSpent = true;
        this.lostToApproach = 0;
      }
    } else if (!this.peakSpent && t >= this.threshold) {
      this.gather(playerX, playerZ, t);
    } else if (this.peakSpent && t < this.threshold) {
      this.peakSpent = false;
    }

    // While the peak holds, grow the crowd toward its target count, minus
    // any heads already scattered by direct approach.
    if (this.alive.length > 0) {
      this.peakCrowd = Math.max(this.peakCrowd, this.countForPeakDepth(t));
      while (this.alive.length + this.lostToApproach < this.peakCrowd) this.spawnOne(playerX, playerZ);
    }
  }

  /** Currently alive silhouettes; empty between peaks. */
  get silhouettes(): readonly Silhouette[] {
    return this.alive;
  }

  /** Whether an audience is currently gathered. */
  get gathered(): boolean {
    return this.alive.length > 0;
  }

  // ---------------------------------------------------------------------------

  /**
   * Silhouette count as a function of peak depth (the driving tension).
   * Monotone non-decreasing over [threshold, 1]: threshold itself yields 1,
   * full saturation yields `maxCount`.
   */
  private countForPeakDepth(depth: number): number {
    const span = Math.max(1e-9, 1 - this.threshold);
    const frac = clamp01((clamp01(depth) - this.threshold) / span);
    return Math.min(this.maxCount, 1 + Math.floor(frac * this.maxCount));
  }

  /**
   * Start a fresh gathering seeded from (session seed, peak index), so each
   * later peak re-gathers with a different layout while staying replayable.
   */
  private gather(playerX: number, playerZ: number, depth: number): void {
    this.peakIndex += 1;
    this.spawnOrder = farthestFirst(this.ends, playerX, playerZ, new RNG(hash2i(this.seed, this.peakIndex, 0x51ed)));
    this.spawnRng = new RNG(hash2i(this.seed, this.peakIndex, 0x9e37));
    this.peakSpent = false;
    this.peakCrowd = this.countForPeakDepth(depth);
    this.lostToApproach = 0;
    this.alive = [];
    for (let i = 0; i < this.peakCrowd; i++) this.spawnOne(playerX, playerZ);
  }

  /** Add one silhouette at the next slot in this gathering's spawn order. */
  private spawnOne(playerX: number, playerZ: number): void {
    const base = this.spawnOrder[this.alive.length % this.spawnOrder.length];
    const x = base.x + (this.spawnRng.next() * 2 - 1) * JITTER;
    const z = base.z + (this.spawnRng.next() * 2 - 1) * JITTER;
    this.alive.push({ id: this.nextId++, x, z, yaw: Math.atan2(playerX - x, playerZ - z) });
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

/** Hall ends ordered farthest-from-player first, tie-broken deterministically. */
function farthestFirst(ends: readonly HallEnd[], px: number, pz: number, rng: RNG): readonly HallEnd[] {
  return ends
    .map((e, i) => ({ e, d: dist2(e.x, e.z, px, pz), k: rng.next(), i }))
    .sort((a, b) => (b.d - a.d) || (a.k - b.k) || (a.i - b.i))
    .map((r) => r.e);
}
