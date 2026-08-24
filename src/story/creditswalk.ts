/**
 * The credits walk for BACKROOMS: MEMORY BLEED (F100).
 *
 * The credits roll while the player walks an endless corridor lined with
 * their own expedition screenshots. The model is built from injected data
 * only: a screenshot list [{id, takenAtSec}], a walk speed, a seed, and an
 * optional credit-name roster. It produces
 *
 *   - an endless corridor segment stream: every segment's wall variant,
 *     flicker, and prop set derive from hash2i(seed, index) via
 *     src/core/rng.ts, so any stretch regenerates identically at any time;
 *   - screenshot frames scheduled at fixed spacing along the walk,
 *     recycling the injected list cyclically so walks longer than the list
 *     never leave an empty frame slot;
 *   - credit lines interleaved with those frames by index: name k wears
 *     role CREDIT_ROLES[k mod roles] and is placed on a fixed time grid;
 *   - one merged timeline whose order is exact and recomputable.
 *
 * Total duration scales with content (every screenshot is shown at least
 * once; longer rosters roll proportionally) but is hard-bounded at
 * MAX_DURATION_SEC (10 minutes). Everything is immutable per build;
 * CreditsWalker advances a private clock over the plan and restart() rewinds
 * it exactly, so loop/restart cycles replay byte-identical event streams.
 *
 * Junk-safe contract: non-finite or sub-minimum speed clamps to
 * MIN_WALK_SPEED_MPS; non-finite segment indices clamp to 0; junk
 * takenAtSec reads as 0; junk advance() deltas read as 0. Only structural
 * junk fails loud: a screenshot or credit entry without a non-empty string
 * id/name throws at build time. There is no Date.now() and no Math.random()
 * anywhere in this module.
 */

import { hash2i } from '../core/rng';

// ---------------------------------------------------------------------------
// Injected inputs
// ---------------------------------------------------------------------------

/** One captured screenshot eligible for the corridor walls. */
export interface ScreenshotRef {
  /** Stable capture identity; also the display caption anchor. */
  readonly id: string;
  /** Session-clock second the shot was taken; junk clamps to 0. */
  readonly takenAtSec: number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Corridor segment length in meters; segments tile the whole walk. */
export const SEGMENT_LENGTH_M = 12;

/** Meters between consecutive screenshot frames along the walk. */
export const FRAME_SPACING_M = 6;

/** First credit line appears this many seconds into the walk. */
export const CREDIT_START_SEC = 2;

/** Seconds between consecutive credit lines. */
export const CREDIT_INTERVAL_SEC = 3.5;

/** Minimum number of frame slots on any walk, even a tiny gallery. */
export const MIN_FRAMES = 12;

/** Hard duration ceiling: the credits walk never exceeds ten minutes. */
export const MAX_DURATION_SEC = 600;

/** Walk speed used when none is injected. */
export const DEFAULT_WALK_SPEED_MPS = 2.2;

/** Slowest legal walk speed; junk speeds clamp here. */
export const MIN_WALK_SPEED_MPS = 0.5;

/**
 * Roles table: credit line k is paired with
 * CREDIT_ROLES[k mod CREDIT_ROLES.length].
 */
export const CREDIT_ROLES: readonly string[] = Object.freeze([
  'Direction',
  'World Generation',
  'Anomaly Design',
  'Soundscape',
  'Cinematography',
  'Journal Handwriting',
  'Memory Reconstruction',
]);

// ---------------------------------------------------------------------------
// Corridor segment stream
// ---------------------------------------------------------------------------

/** One procedural corridor segment of the credits walk. */
export interface CorridorSegment {
  /** Stream index; segment i spans meters [i*SEGMENT_LENGTH_M, (i+1)*...). */
  readonly index: number;
  /** Segment length in meters (constant tiling unit). */
  readonly lengthM: number;
  /** Wallpaper variant index in [0, 4). */
  readonly wallVariant: number;
  /** Flicker intensity draw in [0, 1). */
  readonly lightFlicker: number;
  /** Prop-set variant index in [0, 6). */
  readonly propSet: number;
}

/**
 * Endless seeded segment stream, sampled at one index. Pure: identical
 * (seed, index) calls return identical descriptors in any order.

 * @param seed Run seed driving all variation.
 * @param index Segment index; non-finite clamps to 0.
 * @returns The segment descriptor.
 */
export function corridorSegment(seed: number, index: number): CorridorSegment {
  const s = Number.isFinite(seed) ? seed | 0 : 0;
  const i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return {
    index: i,
    lengthM: SEGMENT_LENGTH_M,
    wallVariant: hash2i(s, i, 11) % 4,
    lightFlicker: hash2i(s, i, 23) / 4294967296,
    propSet: hash2i(s, i, 37) % 6,
  };
}

// ---------------------------------------------------------------------------
// Plan model
// ---------------------------------------------------------------------------

/** One screenshot frame placed along the corridor. */
export interface ScreenshotFrame {
  /** Injected screenshot id shown in this slot. */
  readonly id: string;
  /** Index into the injected list this slot recycled from. */
  readonly sourceIndex: number;
  /** Which complete pass over the list this slot belongs to. */
  readonly cycle: number;
  /** Frame-slot ordinal along the walk, starting at 0. */
  readonly slot: number;
  /** Distance down the corridor in meters. */
  readonly atM: number;
  /** Walk-clock second the player passes this frame. */
  readonly atSec: number;
  /** Injected takenAtSec of the sourced screenshot (junk-clamped to 0). */
  readonly takenAtSec: number;
}

/** One rolling credit line. */
export interface CreditLine {
  /** Line ordinal in roster order, starting at 0. */
  readonly index: number;
  /** Paired role from CREDIT_ROLES by index modulo. */
  readonly role: string;
  /** Injected credit name. */
  readonly name: string;
  /** Walk-clock second the line reaches center screen. */
  readonly atSec: number;
}

/** One merged timeline element: either a screenshot frame or a credit. */
export type TimelineEntry =
  | { readonly kind: 'frame'; readonly atSec: number; readonly frame: ScreenshotFrame }
  | { readonly kind: 'credit'; readonly atSec: number; readonly credit: CreditLine };

/** Fully materialized credits-walk plan for one run. Immutable. */
export interface CreditsWalkPlan {
  /** Seed the corridor stream was built from. */
  readonly seed: number;
  /** Sanitized walk speed in m/s (>= MIN_WALK_SPEED_MPS). */
  readonly speedMps: number;
  /** Total walked distance in meters (duration x speed). */
  readonly distanceM: number;
  /** Total duration in seconds; always <= MAX_DURATION_SEC. */
  readonly durationSec: number;
  /** Materialized segments covering [0, distanceM]. */
  readonly segments: readonly CorridorSegment[];
  /** Scheduled screenshot frames in walk order. */
  readonly frames: readonly ScreenshotFrame[];
  /** Credit lines in roster order. */
  readonly credits: readonly CreditLine[];
  /** Frames + credits merged into exact playback order. */
  readonly timeline: readonly TimelineEntry[];
}

/** Build options accepted by buildCreditsWalk. */
export interface CreditsWalkOptions {
  /** Captured screenshots to line the corridor with; may be empty. */
  readonly screenshots: readonly ScreenshotRef[];
  /** Run seed driving corridor repetition. */
  readonly seed: number;
  /** Walk speed in m/s; defaults to DEFAULT_WALK_SPEED_MPS. */
  readonly speedMps?: number;
  /** Credit names in roll order; defaults to the built-in roster. */
  readonly credits?: readonly string[];
}

/** Built-in fallback roster when no names are injected. */
export const DEFAULT_CREDITS: readonly string[] = Object.freeze([
  'BACKROOMS: MEMORY BLEED',
  'THE PLACE THAT REMEMBERS',
  'AND YOU, WHO NOCLIPPED THROUGH',
]);

function sanitizeSpeed(speedMps: number | undefined): number {
  if (speedMps === undefined || !Number.isFinite(speedMps)) {
    return DEFAULT_WALK_SPEED_MPS;
  }
  return Math.max(MIN_WALK_SPEED_MPS, speedMps);
}

/**
 * Build the full credits-walk plan from injected content.

 * @param opts Screenshots, seed, optional speed and credit roster.
 * @returns The immutable plan; deterministic per inputs.
 * @throws When any screenshot lacks a non-empty string id, or any credit
 *   name is not a non-empty string.
 */
export function buildCreditsWalk(opts: CreditsWalkOptions): CreditsWalkPlan {
  if (!opts || typeof opts !== 'object') {
    throw new Error('credits walk needs an options object');
  }
  const shots = Array.isArray(opts.screenshots) ? opts.screenshots : [];
  shots.forEach((shot, i) => {
    if (!shot || typeof shot.id !== 'string' || shot.id === '') {
      throw new Error(`screenshot ${i} needs a non-empty string id`);
    }
  });
  const roster = opts.credits ?? DEFAULT_CREDITS;
  if (!Array.isArray(roster)) throw new Error('credits must be an array of names');
  roster.forEach((name, i) => {
    if (typeof name !== 'string' || name === '') {
      throw new Error(`credit ${i} needs a non-empty string name`);
    }
  });

  const seed = Number.isFinite(opts.seed) ? opts.seed | 0 : 0;
  const speed = sanitizeSpeed(opts.speedMps);

  // Duration scales with content: every screenshot gets at least one frame
  // slot (MIN_FRAMES floor keeps tiny galleries worth walking), then the
  // hard <=10 min bound applies.
  const contentFrames = Math.max(shots.length, MIN_FRAMES);
  const rawDurationSec = (contentFrames * FRAME_SPACING_M) / speed;
  const durationSec = Math.min(MAX_DURATION_SEC, rawDurationSec);
  const distanceM = durationSec * speed;

  // Frame slots at fixed spacing while they fit inside the bounded walk.
  const frames: ScreenshotFrame[] = [];
  if (shots.length > 0) {
    for (let slot = 0; ; slot++) {
      const atM = (slot + 1) * FRAME_SPACING_M;
      const atSec = atM / speed;
      if (atSec > durationSec) break;
      const sourceIndex = slot % shots.length;
      frames.push({
        id: shots[sourceIndex].id,
        sourceIndex,
        cycle: Math.floor(slot / shots.length),
        slot,
        atM,
        atSec,
        takenAtSec: Number.isFinite(shots[sourceIndex].takenAtSec)
          ? shots[sourceIndex].takenAtSec
          : 0,
      });
    }
  }

  // Credit lines on the fixed time grid, interleaved against the frames.
  const credits: CreditLine[] = [];
  for (let k = 0; ; k++) {
    const atSec = CREDIT_START_SEC + k * CREDIT_INTERVAL_SEC;
    if (atSec > durationSec) break;
    credits.push({ index: k, role: CREDIT_ROLES[k % CREDIT_ROLES.length], name: roster[k % roster.length], atSec });
  }

  // Segments tile the walked distance exactly.
  const segmentCount = Math.max(1, Math.ceil(distanceM / SEGMENT_LENGTH_M));
  const segments: CorridorSegment[] = [];
  for (let i = 0; i < segmentCount; i++) segments.push(corridorSegment(seed, i));

  // Exact merge order: sort by time only; concat puts frames before credits
  // at equal times (Array#sort is stable), which is the documented tie rule.
  const timeline: TimelineEntry[] = [
    ...frames.map((frame) => ({ kind: 'frame' as const, atSec: frame.atSec, frame })),
    ...credits.map((credit) => ({ kind: 'credit' as const, atSec: credit.atSec, credit })),
  ].sort((a, b) => a.atSec - b.atSec);

  return {
    seed,
    speedMps: speed,
    distanceM,
    durationSec,
    segments,
    frames,
    credits,
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Playback cursor
// ---------------------------------------------------------------------------

/** Events surfaced by one walker advance tick. */
export interface WalkEvents {
  /** Frames the player passed during this tick. */
  readonly frames: readonly ScreenshotFrame[];
  /** Credit lines that reached center screen during this tick. */
  readonly credits: readonly CreditLine[];
}

/**
 * Private-time playback cursor over an immutable plan. advance() surfaces
 * every event whose timestamp falls inside the elapsed window; restart()
 * rewinds the clock to zero exactly, so loop-safe restart cycles replay
 * identical event streams forever.
 */
export class CreditsWalker {
  private elapsed = 0;

  /** The immutable plan this walker plays over. */
  private readonly plan: CreditsWalkPlan;

  constructor(plan: CreditsWalkPlan) {
    this.plan = plan;
  }

  /** Current walk-clock second. */
  get elapsedSec(): number {
    return this.elapsed;
  }

  /** True once the walk has reached its bounded duration. */
  get finished(): boolean {
    return this.elapsed >= this.plan.durationSec;
  }

  /**
   * Rewind the clock to zero. Deterministic: repeated restart/advance
   * cycles reproduce identical event streams.

   * @returns The plan this walker plays over (unchanged).
   */
  restart(): CreditsWalkPlan {
    this.elapsed = 0;
    return this.plan;
  }

  /**
   * Advance the clock and collect events entering view this tick.

   * @param dtSec Delta in seconds; non-finite/negative deltas read as 0.
   * @returns Events with timestamps inside (previous, new] elapsed.
   */
  advance(dtSec: number): WalkEvents {
    const dt = Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;
    const from = this.elapsed;
    this.elapsed = Math.min(this.plan.durationSec, this.elapsed + dt);
    return {
      frames: this.plan.frames.filter((f) => f.atSec > from && f.atSec <= this.elapsed),
      credits: this.plan.credits.filter((c) => c.atSec > from && c.atSec <= this.elapsed),
    };
  }
}
