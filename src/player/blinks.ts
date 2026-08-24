/**
 * Sleep pressure micro-blinks (F74).
 *
 * After long sessions the player's eyelids intrude: a scheduler fires blinks
 * whose rate climbs from BASE_BLINKS_PER_MIN (fresh) to
 * LONG_SESSION_BLINKS_PER_MIN after RATE_RAMP_HOURS of session time, with
 * seeded per-interval jitter. Every blink exposes an eyelid-closure envelope
 * in [0, 1] - closing over BLINK_CLOSE_MS, reopening slower over
 * BLINK_OPEN_MS - that a render consumer applies directly as a
 * vignette/blur weight. Past DRIFT_ONSET_HOURS the drift adds micro-blinks:
 * for BURST_DURATION_S every BURST_PERIOD_S of session time the blink rate
 * doubles and each blink is flagged `micro` (shorter envelope, shallower
 * peak) so consumers can grade the intrusion.
 *
 * Pure simulation logic: no Babylon imports. game.ts feeds update() a
 * timestep and the current session hours; events accumulate in `events` for
 * consumers to drain. All randomness flows from src/core/rng.ts keyed by the
 * session seed, so a given seed + update timeline replays identically.
 */
import { RNG } from '../core/rng';

/** One fired blink; `micro` marks the long-session burst variant. */
export interface BlinkEvent {
  /** Session time in seconds at which the blink fired (closure starts rising). */
  timeS: number;
  /** True inside a drift burst window: shorter envelope, shallower peak. */
  micro: boolean;
  /** Total close+open duration in seconds for this blink. */
  durationS: number;
}

/** Baseline blink rate for a fresh session, per minute. */
export const BASE_BLINKS_PER_MIN = 15;
/** Blink rate once the session has run RATE_RAMP_HOURS, per minute. */
export const LONG_SESSION_BLINKS_PER_MIN = 40;
/** Session hours over which the rate ramps linearly from baseline to max. */
export const RATE_RAMP_HOURS = 6;
/** Half-width of the per-interval multiplicative jitter around the base interval. */
export const JITTER_FRACTION = 0.2;
/** Eyelid-closing phase length in milliseconds (fast). */
export const BLINK_CLOSE_MS = 45;
/** Eyelid-reopening phase length in milliseconds (slower than the close). */
export const BLINK_OPEN_MS = 75;
/** Duration scale applied to micro-blink envelopes. */
export const MICRO_DURATION_SCALE = 0.5;
/** Peak closure of a micro-blink (full blinks peak at exactly 1). */
export const MICRO_CLOSURE_PEAK = 0.55;
/** Session hours after which drift bursts turn on. */
export const DRIFT_ONSET_HOURS = 1;
/** Drift burst spacing in session seconds (~10 min). */
export const BURST_PERIOD_S = 600;
/** Drift burst length in session seconds. */
export const BURST_DURATION_S = 20;
/** Blink-rate multiplier inside a burst window. */
export const BURST_RATE_MULT = 2;

/**
 * Base (unjittered) blink rate for a session age.
 * @param sessionHours Hours since session start; clamped to [0, RATE_RAMP_HOURS].
 * @returns Blinks per minute, linearly interpolated and monotone non-decreasing.
 */
export function blinkRatePerMin(sessionHours: number): number {
  const t = Math.min(1, Math.max(0, sessionHours) / RATE_RAMP_HOURS);
  return BASE_BLINKS_PER_MIN + (LONG_SESSION_BLINKS_PER_MIN - BASE_BLINKS_PER_MIN) * t;
}

/**
 * Whether session time tS lies in a drift burst window. Windows are the
 * half-open intervals [k*BURST_PERIOD_S, k*BURST_PERIOD_S + BURST_DURATION_S)
 * for integers k >= 0.
 */
export function inBurstWindow(tS: number): boolean {
  if (tS < 0) return false;
  return tS % BURST_PERIOD_S < BURST_DURATION_S;
}

/**
 * Fixed eyelid-closure shape sampled `msIntoBlink` after the blink fired:
 * linear rise 0 -> 1 across BLINK_CLOSE_MS, then linear fall 1 -> 0 across
 * BLINK_OPEN_MS. Outside [0, close+open) the closure is exactly 0.
 * @param msIntoBlink Milliseconds since the blink fired.
 * @param closeMs Closing phase length; defaults to BLINK_CLOSE_MS.
 * @param openMs Reopening phase length; defaults to BLINK_OPEN_MS.
 * @returns Closure fraction in [0, 1].
 */
export function blinkClosureAt(
  msIntoBlink: number,
  closeMs: number = BLINK_CLOSE_MS,
  openMs: number = BLINK_OPEN_MS,
): number {
  if (!(msIntoBlink > 0) || msIntoBlink >= closeMs + openMs) return 0;
  return msIntoBlink <= closeMs ? msIntoBlink / closeMs : (closeMs + openMs - msIntoBlink) / openMs;
}

/**
 * Schedules blinks over injected session hours and derives the current
 * eyelid-closure value for render consumers.
 */
export class BlinkScheduler {
  /** Internal session clock in seconds. */
  private tS = 0;
  private readonly rng: RNG;
  /** Session time of the next scheduled blink. */
  private nextBlinkS: number;
  private fired: BlinkEvent[] = [];
  private recent: BlinkEvent[] = [];

  constructor(seed: number) {
    this.rng = new RNG(seed | 0);
    this.nextBlinkS = this.drawIntervalS(blinkRatePerMin(0));
  }

  /**
   * Advance the clock, firing every blink due by the new time.
   * @param dtS Frame time in seconds (negative values are treated as 0).
   * @param sessionHours Current session age in hours; drives the blink rate
   *   and drift-burst gating at each firing instant.
   */
  update(dtS: number, sessionHours: number): void {
    this.tS += Math.max(0, dtS);
    while (this.nextBlinkS <= this.tS) {
      const fireT = this.nextBlinkS;
      const micro = sessionHours >= DRIFT_ONSET_HOURS && inBurstWindow(fireT);
      const durS = ((BLINK_CLOSE_MS + BLINK_OPEN_MS) / 1000) * (micro ? MICRO_DURATION_SCALE : 1);
      const event: BlinkEvent = { timeS: fireT, micro, durationS: durS };
      this.fired.push(event);
      this.recent.push(event);
      this.nextBlinkS = fireT + this.drawIntervalS(blinkRatePerMin(sessionHours), micro);
    }
    while (this.recent.length > 0 && this.recent[0].timeS + this.recent[0].durationS <= this.tS) {
      this.recent.shift();
    }
  }

  /**
   * Eyelid-closure value in [0, MICRO_CLOSURE_PEAK .. 1]: the maximum closure
   * over all active blink envelopes at the current clock time. A render
   * consumer applies it directly as vignette/blur weight.
   */
  get eyelidClosure(): number {
    let c = 0;
    for (const e of this.recent) {
      const msIn = (this.tS - e.timeS) * 1000;
      const shape = blinkClosureAt(msIn);
      if (shape <= 0) continue;
      c = Math.max(c, shape * (e.micro ? MICRO_CLOSURE_PEAK : 1));
    }
    return c;
  }

  /** Drain fired blink events in firing order. */
  drainEvents(): BlinkEvent[] {
    const out = this.fired;
    this.fired = [];
    return out;
  }

  /**
   * One jittered inter-blink interval in [base*(1-JITTER_FRACTION),
   * base*(1+BURST_RATE_MULT-adjusted)*(1+JITTER_FRACTION)], consuming exactly
   * one RNG draw. Micro-blinks compress the base interval by BURST_RATE_MULT.
   */
  private drawIntervalS(ratePerMin: number, micro = false): number {
    const base = 60 / (ratePerMin * (micro ? BURST_RATE_MULT : 1));
    return base * (1 - JITTER_FRACTION + 2 * JITTER_FRACTION * this.rng.next());
  }
}
