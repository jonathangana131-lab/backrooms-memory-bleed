/**
 * Staged wake cinematic for BACKROOMS: MEMORY BLEED (F91).
 *
 * The waking sequence is procedurally staged per run seed: a shot list of
 * ceiling stares, hand rises, room sweeps, and carpet focuses with seeded
 * order, count, durations, and camera poses. The whole sequence stays within
 * TOTAL_CAP_MS so it can never stall the start of play, every pose lives
 * inside documented bounds, and the same seed replays a byte-identical shot
 * list. An injected skip input jumps straight to the final shot instantly —
 * the place does not argue with someone trying to open their eyes.
 *
 * All staging draws come from src/core/rng.ts keyed by the seed; junk seeds
 * fall back to a canonical value instead of throwing. No Date.now(), no
 * Math.random() (see test/wakecinematic-test.mjs).
 */

import { RNG } from '../core/rng';

// ---------------------------------------------------------------------------
// Staging model
// ---------------------------------------------------------------------------

/** One staged camera shot inside the wake sequence. */
export type WakeShotKind = 'ceiling-stare' | 'hand-rise' | 'room-sweep' | 'carpet-focus';

/** All shot kinds that may appear in a staging. */
export const WAKE_SHOT_KINDS: readonly WakeShotKind[] = [
  'ceiling-stare',
  'hand-rise',
  'room-sweep',
  'carpet-focus',
];

/** Camera pose of one shot; every component is bounded by POSE_BOUNDS. */
export interface WakeCameraPose {
  /** Camera world position [x, y, z]. */
  position: readonly [number, number, number];
  /** Look-at target [x, y, z]. */
  target: readonly [number, number, number];
  /** Vertical field of view in degrees. */
  fovDeg: number;
}

/** One staged shot. */
export interface WakeShot {
  /** What the waking eye is doing. */
  kind: WakeShotKind;
  /** Shot length in milliseconds (always >= MIN_SHOT_DURATION_MS). */
  durationMs: number;
  /** Bounded camera pose for this shot's start. */
  pose: WakeCameraPose;
}

/** A fully staged wake cinematic for one seed. */
export interface WakeStaging {
  /** Seeded shot list in play order; never empty. */
  shots: readonly WakeShot[];
  /** Sum of shot durations in ms; always <= TOTAL_CAP_MS. */
  totalMs: number;
}

// ---------------------------------------------------------------------------
// Tunables + pose bounds
// ---------------------------------------------------------------------------

/** Fewest shots a staging may contain. */
export const MIN_SHOTS = 4;

/** Most shots a staging may contain. */
export const MAX_SHOTS = 7;

/** Hard upper bound on the whole sequence, in milliseconds. */
export const TOTAL_CAP_MS = 6500;

/** Shortest legal single shot, in milliseconds. */
export const MIN_SHOT_DURATION_MS = 500;

/** Per-kind duration ranges [min, max] in ms. */
export const SHOT_DURATION_RANGE_MS: Readonly<Record<WakeShotKind, readonly [number, number]>> = {
  'ceiling-stare': [900, 1600],
  'hand-rise': [700, 1300],
  'room-sweep': [1100, 1900],
  'carpet-focus': [600, 1200],
};

/** Inclusive component bounds every staged camera pose respects. */
export const POSE_BOUNDS = {
  /** Camera x/z spread around the bed. */
  positionXZ: 1.2,
  /** Camera y range: lying in bed, head height. */
  positionYMin: 0.55,
  positionYMax: 1.15,
  /** Look-at x/z spread around the room. */
  targetXZ: 3,
  /** Look-at y range: floor carpet to ceiling tiles. */
  targetYMin: 0.1,
  targetYMax: 2.6,
  /** Vertical field-of-view range in degrees. */
  fovDegMin: 58,
  fovDegMax: 92,
} as const;

/** Canonical fallback seed for junk inputs. */
const FALLBACK_SEED = 0x9e3779b9;

/**
 * Stage the wake cinematic for one run seed.

 * @param seed Run seed; NaN/infinite/negative junk falls back to a canonical
 *   seed rather than throwing.
 * @returns A shot list whose total duration is <= TOTAL_CAP_MS and whose
 *   poses all respect POSE_BOUNDS; identical seeds replay identically.
 */
export function stageWakeCinematic(seed: number): WakeStaging {
  const safeSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 || FALLBACK_SEED : FALLBACK_SEED;
  const rng = new RNG(safeSeed);
  const count = rng.int(MIN_SHOTS, MAX_SHOTS + 1);
  const shots: WakeShot[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const kind = rng.pick(WAKE_SHOT_KINDS);
    const [dMin, dMax] = SHOT_DURATION_RANGE_MS[kind];
    const durationMs = Math.round(rng.range(dMin, dMax));
    total += durationMs;
    shots.push({ kind, durationMs, pose: drawPose(rng) });
  }
  // Proportionally shrink toward the cap, keeping every shot >=
  // MIN_SHOT_DURATION_MS; any residual excess trims off the longest shots.
  if (total > TOTAL_CAP_MS) {
    const scale = TOTAL_CAP_MS / total;
    for (const shot of shots) {
      shot.durationMs = Math.max(
        MIN_SHOT_DURATION_MS,
        Math.floor(shot.durationMs * scale),
      );
    }
    total = shots.reduce((sum, s) => sum + s.durationMs, 0);
    while (total > TOTAL_CAP_MS) {
      // A staging over the cap cannot have every shot at the minimum
      // (MIN_SHOTS x MIN_SHOT_DURATION_MS << TOTAL_CAP_MS), so the longest
      // shot always has headroom for a 1 ms trim.
      let longest = 0;
      for (let i = 1; i < shots.length; i++) {
        if (shots[i].durationMs > shots[longest].durationMs) longest = i;
      }
      shots[longest].durationMs -= 1;
      total -= 1;
    }
  }
  return { shots, totalMs: total };
}

/**
 * Draw one bounded camera pose.

 * @param rng Shared staging RNG.
 * @returns A pose with every component inside POSE_BOUNDS.
 */
function drawPose(rng: RNG): WakeCameraPose {
  const b = POSE_BOUNDS;
  return {
    position: [
      Number(rng.range(-b.positionXZ, b.positionXZ).toFixed(4)),
      Number(rng.range(b.positionYMin, b.positionYMax).toFixed(4)),
      Number(rng.range(-b.positionXZ, b.positionXZ).toFixed(4)),
    ],
    target: [
      Number(rng.range(-b.targetXZ, b.targetXZ).toFixed(4)),
      Number(rng.range(b.targetYMin, b.targetYMax).toFixed(4)),
      Number(rng.range(-b.targetXZ, b.targetXZ).toFixed(4)),
    ],
    fovDeg: Number(rng.range(b.fovDegMin, b.fovDegMax).toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// Playback model
// ---------------------------------------------------------------------------

/**
 * Clock-driven playback over a staged shot list. update() advances the
 * injected elapsed time through consecutive shots; skip() abandons the
 * sequence and lands on the final shot at its own start instantly.
 */
export class WakeCinematicPlayer {
  private elapsed = 0;

  private readonly staging: WakeStaging;

  /**
   * @param staging Injected staging to play back.
   * @throws When the staging has no shots.
   */
  constructor(staging: WakeStaging) {
    if (!staging.shots || staging.shots.length === 0) {
      throw new Error('wake cinematic needs at least one shot');
    }
    this.staging = staging;
  }

  /**
   * Advance playback by an injected frame delta.
   *
   * @param deltaMs Frame delta in ms; non-finite or negative deltas are
   *   ignored. Playback clamps at the end of the final shot.
   */
  update(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return;
    this.elapsed = Math.min(this.elapsed + deltaMs, this.staging.totalMs);
  }

  /** Index of the currently playing shot. */
  get activeIndex(): number {
    const { shots } = this.staging;
    let acc = 0;
    for (let i = 0; i < shots.length - 1; i++) {
      acc += shots[i].durationMs;
      if (this.elapsed < acc) return i;
    }
    return shots.length - 1;
  }

  /** Currently playing shot. */
  get activeShot(): WakeShot {
    return this.staging.shots[this.activeIndex];
  }

  /** Milliseconds remaining in the whole sequence. */
  get remainingMs(): number {
    return this.staging.totalMs - this.elapsed;
  }

  /**
   * Handle injected skip input: jump instantly to the final shot at its own
   * start, discarding everything earlier.
   */
  skip(): void {
    const { shots } = this.staging;
    this.elapsed = shots
      .slice(0, shots.length - 1)
      .reduce((sum, s) => sum + s.durationMs, 0);
  }
}
