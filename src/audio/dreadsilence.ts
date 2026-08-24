/**
 * Dread silence for BACKROOMS: MEMORY BLEED.
 *
 * Before a major anomaly the director can command total-mix duck: every
 * sound in the game collapses over one second into a held breath of
 * near-silence, stays there for a seeded 8-20 s, then returns with an
 * audible exhale ramp. The shape:
 *
 *   DUCK     master gain ramps to DUCK_FLOOR_LINEAR (-30 dB) within
 *            DUCK_ATTACK_SEC (<= 1 s)
 *   HOLD     flat floor for holdDuration seconds, drawn once per duck
 *            from the injected seeded RNG, always inside [8, 20]
 *   EXHALE   linear recovery back to unity over EXHALE_SEC (>= 2 s),
 *            so the mix audibly breathes back in
 *   RATION   at most one duck per COOLDOWN_SEC (25 minutes) of session
 *            time; requestDuck() refuses and canDuck() reports why
 *
 * The class is a pure scheduler over an injected gain parameter: it takes
 * explicit session-clock seconds (the same playtimeSec the director uses),
 * never reads wall time, and records every automation event it schedules
 * in `automation` so tests can prove the curve headlessly.
 */

import { RNG } from '../core/rng';

/** Minimal scheduling surface of the injected master GainNode param. */
export interface DuckGainParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

/** Injected audio bus: any node exposing a schedulable `gain` param. */
export interface DuckBus {
  gain: DuckGainParamLike;
}

/** Construction options; seed defaults keep runs reproducible. */
export interface DreadSilenceOptions {
  /** Seeded RNG source for hold durations; defaults to seed 0. */
  seed?: number;
}

/** One scheduled automation event on the master gain (audit trail). */
export interface DuckAutomationEvent {
  op: 'set' | 'linear';
  /** Target linear gain value. */
  value: number;
  /** Session-clock seconds this event lands at. */
  at: number;
}

export type DuckPhase = 'idle' | 'ducking' | 'holding' | 'recovering';

/** Seconds from command to full floor (spec ceiling is 1 s). */
export const DUCK_ATTACK_SEC = 0.7;
/** Floor depth: -30 dB linear, comfortably past the -24 dB spec line. */
export const DUCK_FLOOR_LINEAR = Math.pow(10, -30 / 20);
/** Recovery return level: unity (>= -1 dB spec line). */
export const DUCK_RETURN_LINEAR = 1;
/** Exhale duration: the audible recovery ramp (spec minimum 2 s). */
export const EXHALE_SEC = 3;
/** Hold duration window drawn per duck, seconds. */
export const HOLD_MIN_SEC = 8;
export const HOLD_MAX_SEC = 20;
/** Minimum session-time spacing between ducks: 25 minutes. */
export const COOLDOWN_SEC = 25 * 60;

/**
 * Director-commanded total-mix duck with hard 25-minute rationing.
 * Mount once against the master gain; drive tick(nowSec) each frame and
 * call requestDuck(nowSec) when an anomaly deserves the silence.
 */
export class DreadSilence {
  /**
   * Every automation event scheduled since construction, oldest first --
   * the audit trail used by the AC proof and debug overlays.
   */
  readonly automation: DuckAutomationEvent[] = [];

  /**
   * Hold duration drawn for the most recent duck; -1 before the first.
   * Always inside [HOLD_MIN_SEC, HOLD_MAX_SEC].
   */
  lastHoldSec = -1;

  /** Session-clock time of the most recent accepted duck; -1 if none. */
  lastDuckAt = -1;

  private readonly bus: DuckBus;
  private readonly rng: RNG;
  private startAt = -1;
  private endAt = -1;
  /** Latest session time seen through tick()/requestDuck()/canDuck(). */
  private clock = 0;

  constructor(bus: DuckBus, options: DreadSilenceOptions = {}) {
    this.bus = bus;
    this.rng = new RNG(options.seed ?? 0);
  }

  /**
   * Whether the ration allows a duck right now: true until one has run,
   * afterwards only once COOLDOWN_SEC of session time has passed since
   * the last accepted duck.
   *
   * @param nowSec current session time; defaults to the latest clock
   *               the instance has observed via tick()/requestDuck()
   * @returns true when requestDuck() would be accepted
   */
  canDuck(nowSec?: number): boolean {
    const now = nowSec ?? this.clock;
    if (now > this.clock) this.clock = now;
    if (this.lastDuckAt < 0) return true;
    return now - this.lastDuckAt >= COOLDOWN_SEC;
  }

  /**
   * Command a duck starting at session time nowSec. Schedules the full
   * attack/hold/exhale curve onto the bus in one call and records it in
   * `automation`. Refused while the 25-minute ration is running down or
   * a duck is already in flight.
   *
   * @param nowSec session-clock start time, seconds
   * @returns true when the duck started, false when rationed/refused
   */
  requestDuck(nowSec: number): boolean {
    if (!(nowSec >= 0)) return false;
    if (nowSec > this.clock) this.clock = nowSec;
    if (!this.canDuck(nowSec)) return false;
    if (this.startAt >= 0 && nowSec < this.endAt) return false;

    // One seeded draw per duck keeps pacing unpredictable but bounded.
    const hold = this.rng.range(HOLD_MIN_SEC, HOLD_MAX_SEC);
    this.lastHoldSec = hold;
    this.lastDuckAt = nowSec;
    this.startAt = nowSec;
    this.endAt = nowSec + DUCK_ATTACK_SEC + hold + EXHALE_SEC;

    const g = this.bus.gain;
    const events: DuckAutomationEvent[] = [
      { op: 'set', value: g.value, at: nowSec },
      { op: 'linear', value: DUCK_FLOOR_LINEAR, at: nowSec + DUCK_ATTACK_SEC },
      { op: 'set', value: DUCK_FLOOR_LINEAR, at: nowSec + DUCK_ATTACK_SEC + hold },
      { op: 'linear', value: DUCK_RETURN_LINEAR, at: this.endAt },
    ];
    g.cancelScheduledValues(nowSec);
    for (const ev of events) {
      this.automation.push(ev);
      if (ev.op === 'set') {
        g.setValueAtTime(ev.value, ev.at);
      } else {
        g.linearRampToValueAtTime(ev.value, ev.at);
      }
    }
    return true;
  }

  /**
   * Per-frame advance: refresh the internal clock and phase. Pure
   * bookkeeping -- all audio motion was already scheduled at requestDuck().
   *
   * @param nowSec current session time, seconds
   * @returns current phase of the duck lifecycle
   */
  tick(nowSec: number): DuckPhase {
    if (nowSec > this.clock) this.clock = nowSec;
    if (this.startAt < 0 || nowSec < this.startAt) return 'idle';
    if (nowSec < this.startAt + DUCK_ATTACK_SEC) return 'ducking';
    if (this.endAt < 0) return 'idle';
    const holdEnd = this.endAt - EXHALE_SEC;
    if (nowSec < holdEnd) return 'holding';
    if (nowSec < this.endAt) return 'recovering';
    return 'idle';
  }
}
