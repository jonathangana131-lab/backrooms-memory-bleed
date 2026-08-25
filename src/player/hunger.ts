/**
 * Hunger pangs (F73).
 *
 * The longer the expedition runs, the more often the player's stomach
 * announces itself: the base inter-pang interval interpolates from
 * START_INTERVAL_MIN at session start down to END_INTERVAL_MIN after
 * INTERVAL_SATURATION_MIN minutes and holds there, with +/-10% seeded
 * jitter per draw. Each fired pang carries an intensity that grows with
 * expedition length plus a seeded audible duration, so the ambient audio
 * layer can grade the growl without re-deriving either.
 *
 * Nothing fires before a configurable grace period: a fresh run is quiet
 * for its first minutes no matter how the clock is fed. reset() restores
 * the exact birth state so every run starts the schedule identically.
 * Pure simulation logic, no Babylon imports; game.ts injects the session
 * clock in minutes and drains `events` into the audio layer.
 * All randomness flows from src/core/rng.ts keyed by the session seed,
 * so a given seed + clock timeline replays identically.
 */
import { RNG } from '../core/rng';

/** Base inter-pang interval for a fresh expedition, in minutes. */
export const START_INTERVAL_MIN = 12;
/** Base inter-pang interval once the expedition is long, in minutes. */
export const END_INTERVAL_MIN = 3;
/** Session age in minutes at which the interval reaches END_INTERVAL_MIN. */
export const INTERVAL_SATURATION_MIN = 90;
/** Half-width of the per-draw multiplicative jitter around the base interval. */
export const JITTER_FRACTION = 0.1;
/** Default quiet period at run start before the first pang can fire. */
export const DEFAULT_GRACE_PERIOD_MIN = 10;

/** Seeded pang-length band in seconds. */
const MIN_DURATION_S = 0.5;
const MAX_DURATION_S = 1.6;

/**
 * Base (unjittered) inter-pang interval for an expedition of this age:
 * linear interpolation from START_INTERVAL_MIN at 0 minutes down to
 * END_INTERVAL_MIN at INTERVAL_SATURATION_MIN, constant beyond.
 *
 * @param sessionMinutes Injected absolute session clock in minutes.
 * @returns Base interval in minutes (>= END_INTERVAL_MIN).
 */
export function baseIntervalMin(sessionMinutes: number): number {
  const t = clamp01(sessionMinutes / INTERVAL_SATURATION_MIN);
  return START_INTERVAL_MIN + (END_INTERVAL_MIN - START_INTERVAL_MIN) * t;
}

/**
 * One jittered interval draw in [base * (1 - JITTER_FRACTION),
 * base * (1 + JITTER_FRACTION)], consuming exactly one RNG draw so
 * callers can reproduce any draw index deterministically.
 */
export function jitteredIntervalMin(sessionMinutes: number, rng: RNG): number {
  return baseIntervalMin(sessionMinutes) * (1 + (rng.next() * 2 - 1) * JITTER_FRACTION);
}

/** One fired stomach pang, ready for the ambient audio layer. */
export interface PangEvent {
  /** Session clock in minutes at which the pang fired. */
  timeMin: number;
  /** Grows with expedition length in [0, 1]; later pangs hit harder. */
  intensity: number;
  /** Seeded audible growl length in seconds. */
  durationS: number;
}

export interface HungerPangsOptions {
  /**
   * Quiet period in session minutes before the first pang may fire.
   * Must be finite and >= 0; defaults to DEFAULT_GRACE_PERIOD_MIN.
   */
  gracePeriodMin?: number;
}

/** Serialized pang-schedule snapshot (persisted inside a SaveSlot). */
export interface HungerPangsState {
  /** Schema version for the snapshot payload itself. */
  v: 1;
  /** Injected session clock in minutes at capture time. */
  clockMin: number;
  /** Absolute session minute the next pang is scheduled to fire at. */
  nextPangAtMin: number;
  /** Raw RNG stream position so jitter/duration draws replay identically. */
  rngState: number;
}

/**
 * Drives the pang schedule for one run. Feed update() with the injected
 * session clock; read or drain `events` afterwards. The clock only moves
 * forward — regressed readings are ignored so replays stay stable.
 * reset() returns the scheduler to its birth state for a new run.
 */
export class HungerPangs {
  private readonly seed: number;
  private readonly gracePeriodMin_: number;
  private rng: RNG;
  private clockMin = 0;
  private nextPangAtMin: number;
  private events_: PangEvent[] = [];

  constructor(seed: number, options: HungerPangsOptions = {}) {
    this.seed = seed >>> 0;
    const g = options.gracePeriodMin ?? DEFAULT_GRACE_PERIOD_MIN;
    if (!Number.isFinite(g) || g < 0) {
      throw new RangeError(`gracePeriodMin must be finite >= 0, got ${options.gracePeriodMin}`);
    }
    this.gracePeriodMin_ = g;
    this.rng = new RNG(this.seed ^ 0xfeed);
    // Drawn eagerly, never re-drawn: the whole future schedule then
    // depends only on fire times, not on how often update() is called.
    this.nextPangAtMin = this.firstPangAt();
  }

  /** Configured quiet period in minutes before the first pang can fire. */
  get gracePeriodMin(): number {
    return this.gracePeriodMin_;
  }

  /**
   * Advance to the injected absolute session clock. Jumping far ahead
   * fires every due pang in order; times before the grace period or
   * behind the current clock never fire.
   *
   * @param sessionMin Absolute session clock in minutes.
   */
  update(sessionMin: number): void {
    if (!(sessionMin > this.clockMin)) return;
    this.clockMin = sessionMin;
    while (this.nextPangAtMin <= this.clockMin) {
      const fireAt = this.nextPangAtMin;
      this.events_.push({
        timeMin: fireAt,
        intensity: clamp01(fireAt / INTERVAL_SATURATION_MIN),
        durationS: this.rng.range(MIN_DURATION_S, MAX_DURATION_S),
      });
      // The next gap scales with the expedition length at the moment it
      // fires, so long runs see pangs crowd closer together.
      this.nextPangAtMin = fireAt + jitteredIntervalMin(fireAt, this.rng);
    }
  }

  /** Events fired so far in firing order; grows until drained. */
  get events(): readonly PangEvent[] {
    return this.events_;
  }

  /** Hand the accumulated events to a consumer and reset the buffer. */
  drainEvents(): PangEvent[] {
    const out = this.events_;
    this.events_ = [];
    return out;
  }

  /** Start a fresh run: identical seed + timeline replays identically. */
  reset(): void {
    this.rng = new RNG(this.seed ^ 0xfeed);
    this.clockMin = 0;
    this.nextPangAtMin = this.firstPangAt();
    this.events_ = [];
  }

  /**
   * Snapshot the schedule for persistence across sessions (F73): a saved
   * expedition resumes its elapsed-hunger pacing instead of restarting
   * the grace period. Pure data — no Babylon / DOM types involved.
   */
  serialize(): HungerPangsState {
    return {
      v: 1,
      clockMin: this.clockMin,
      nextPangAtMin: this.nextPangAtMin,
      rngState: this.rng.state,
    };
  }

  /**
   * Apply a snapshot from serialize(). Returns false and leaves this
   * scheduler untouched when the payload is malformed or from an
   * incompatible schema, so callers fall back to a fresh schedule.
   */
  restore(state: HungerPangsState | unknown): boolean {
    const s = state as HungerPangsState | null;
    if (!s || typeof s !== 'object' || s.v !== 1) return false;
    if (!Number.isFinite(s.clockMin) || !Number.isFinite(s.nextPangAtMin) ||
        !Number.isFinite(s.rngState)) return false;
    this.rng = new RNG(this.seed ^ 0xfeed);
    this.rng.state = s.rngState;
    this.clockMin = Math.max(0, s.clockMin);
    // A next-pang time behind the restored clock (corrupt payload) would
    // fire instantly on resume; push it one full interval past the resume
    // point instead so continued runs stay quiet. Valid snapshots always
    // have nextPangAtMin >= clockMin and take the first branch untouched.
    this.nextPangAtMin = s.nextPangAtMin >= this.clockMin
      ? s.nextPangAtMin
      : this.clockMin + jitteredIntervalMin(this.clockMin, this.rng);
    this.events_ = [];
    return true;
  }

  /** Earliest possible first-pang time: one jittered interval past grace. */
  private firstPangAt(): number {
    return this.gracePeriodMin_ + jitteredIntervalMin(this.gracePeriodMin_, this.rng);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
