/**
 * Panic breathing control (F78).
 *
 * A hold-rhythm minigame that steadies the breath meter: the game prompts a
 * hold/release rhythm and the player's actual input timeline is scored
 * against a target square wave (period 2.4 s, 50% duty, seeded phase
 * offset). Alignment is measured as the exact fraction of the evaluated
 * window in which the held state agrees with the target wave; chance-level
 * input maps to a steadiness of 0 and a locked-in performance maps to 1.
 *
 * The steadiness score feeds a breath-meter stabilization multiplier that
 * eases from 1 (no help) down to 0.4 as steadiness rises, so a calm rhythm
 * visibly slows the panic breathing while mashing does nothing.
 *
 * Pure simulation logic: no Babylon imports. game.ts injects input events
 * {t, held}; all randomness flows from src/core/rng.ts keyed by the session
 * seed, so a given seed + input timeline replays identically.
 */
import { hash32 } from '../core/rng';

/** One player input sample: session time in seconds plus the held state. */
export interface BreathInput {
  /** Session time in seconds at which the held state took effect. */
  t: number;
  /** True while the player holds the breath key. */
  held: boolean;
}

/** Target rhythm period in seconds. */
export const TARGET_PERIOD_S = 2.4;
/** Fraction of each period the target wave spends in the held state. */
export const TARGET_DUTY = 0.5;
/** Breath-meter multiplier reached at perfect steadiness. */
export const STABILIZATION_MIN_MULTIPLIER = 0.4;
/** Steadiness eases toward the measured alignment with this time constant. */
export const EASE_TAU_S = 1.5;
/** Rolling evaluation window for the live minigame, in seconds. */
export const ROLLING_WINDOW_S = 12;

/**
 * Rhythm-clock helpers quantize time to whole milliseconds so wave-edge
 * comparisons are exact: a hold edge landing on a release edge is decided
 * deterministically instead of by float rounding direction.
 */
const MS = 1000;
const PERIOD_MS = Math.round(TARGET_PERIOD_S * MS);
const HOLD_MS = Math.round(TARGET_DUTY * TARGET_PERIOD_S * MS);

/** Quantize a seconds timestamp to whole milliseconds. */
function toMs(t: number): number {
  return Math.round(t * MS);
}

/** The target square wave at time `t`: held during the first TARGET_DUTY of each period. */
export function targetHeldAt(t: number, phaseOffsetS: number): boolean {
  const u = (((toMs(t) - toMs(phaseOffsetS)) % PERIOD_MS) + PERIOD_MS) % PERIOD_MS;
  return u < HOLD_MS;
}

/**
 * Duration inside [ta, tb) during which the target wave is in the held
 * state, computed exactly from half-open cycle intervals in whole
 * milliseconds (no sampling error, no float drift). Assumes ta <= tb.
 */
export function targetHeldDurationS(ta: number, tb: number, phaseOffsetS: number): number {
  return targetHeldDurationMs(toMs(ta), toMs(tb), toMs(phaseOffsetS)) / MS;
}

/** Held-state overlap of [aMs, bMs) with the wave shifted by phaseMs; whole-millisecond domain. */
function targetHeldDurationMs(aMs: number, bMs: number, phaseMs: number): number {
  const a = aMs - phaseMs;
  const b = bMs - phaseMs;
  let totalMs = 0;
  const kFirst = Math.floor(a / PERIOD_MS) - 1;
  const kLast = Math.floor(b / PERIOD_MS) + 1;
  for (let k = kFirst; k <= kLast; k++) {
    const lo = Math.max(a, k * PERIOD_MS);
    const hi = Math.min(b, k * PERIOD_MS + HOLD_MS);
    if (hi > lo) totalMs += hi - lo;
  }
  return totalMs;
}

/**
 * Raw alignment of an input timeline against the target wave over
 * [tStart, tEnd]: the exact fraction of the window in which the held state
 * equals targetHeldAt. Inputs are sorted internally; before the first
 * event the player counts as released. Returns 0 for an empty window.
 */
export function alignmentScore(
  inputs: readonly BreathInput[],
  tStart: number,
  tEnd: number,
  phaseOffsetS = 0,
): number {
  const startMs = toMs(tStart);
  const endMs = toMs(tEnd);
  if (!(endMs > startMs)) return 0;
  const events = [...inputs].sort((p, q) => p.t - q.t);
  const phaseMs = toMs(phaseOffsetS);
  let agreeMs = 0;
  let prevMs = Number.NEGATIVE_INFINITY;
  let prevHeld = false;
  const addSegment = (a: number, b: number): void => {
    const lo = Math.max(a, startMs);
    const hi = Math.min(b, endMs);
    if (hi <= lo) return;
    const heldMs = targetHeldDurationMs(lo, hi, phaseMs);
    agreeMs += prevHeld ? heldMs : hi - lo - heldMs;
  };
  for (const event of events) {
    const tMs = toMs(event.t);
    if (tMs < prevMs) continue;
    addSegment(prevMs, tMs);
    prevMs = tMs;
    prevHeld = event.held;
  }
  addSegment(prevMs, Number.POSITIVE_INFINITY);
  return agreeMs / (endMs - startMs);
}

/**
 * Map raw alignment to a steadiness score in [0, 1]: chance-level input
 * (agreement ~0.5) maps to 0, perfect lock-on maps to 1. The linear 2x-1
 * remap keeps the response monotone in alignment quality.
 */
export function steadinessFromAlignment(alignment: number): number {
  const s = 2 * alignment - 1;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

/**
 * Breath-meter stabilization multiplier for a steadiness score: 1 with no
 * control, easing linearly down to STABILIZATION_MIN_MULTIPLIER at
 * perfect steadiness.
 */
export function stabilizationMultiplier(steadiness: number): number {
  const s = steadiness < 0 ? 0 : steadiness > 1 ? 1 : steadiness;
  return 1 + (STABILIZATION_MIN_MULTIPLIER - 1) * s;
}

/** Seeded phase offset for the prompted rhythm, a whole number of milliseconds in [0, TARGET_PERIOD_S). */
export function phaseOffsetFromSeed(seed: number): number {
  return (hash32(seed >>> 0) % PERIOD_MS) / MS;
}

/**
 * Live minigame driver: accumulate injected inputs, re-measure alignment
 * over a rolling window each tick, and ease the reported steadiness toward
 * it so the breath meter responds smoothly instead of snapping.
 */
export class PanicBreathMinigame {
  /** Prompted-rhythm phase offset derived from the session seed. */
  readonly phaseOffsetS: number;

  private readonly inputs: BreathInput[] = [];
  private nowS = 0;
  private steadiness_ = 0;

  constructor(seed: number) {
    this.phaseOffsetS = phaseOffsetFromSeed(seed);
  }

  /**
   * Record one injected input event; events may arrive out of order and
   * may reference already-elapsed times. update() owns the session clock.
   */
  onInput(event: BreathInput): void {
    this.inputs.push(event);
  }

  /**
   * Advance the clock by `dt` seconds and ease the steadiness score toward
   * the alignment measured over the last ROLLING_WINDOW_S seconds. The
   * exponential ease consumes no randomness, so identical call sequences
   * replay identically.
   */
  update(dt: number): void {
    this.nowS += dt;
    const alignment = alignmentScore(
      this.inputs,
      Math.max(0, this.nowS - ROLLING_WINDOW_S),
      this.nowS,
      this.phaseOffsetS,
    );
    const target = steadinessFromAlignment(alignment);
    const ease = 1 - Math.exp(-Math.max(0, dt) / EASE_TAU_S);
    this.steadiness_ += (target - this.steadiness_) * ease;
    if (this.steadiness_ < 0) this.steadiness_ = 0;
    if (this.steadiness_ > 1) this.steadiness_ = 1;
  }

  /** Current eased steadiness score in [0, 1]. */
  get steadiness(): number {
    return this.steadiness_;
  }

  /** Current breath-meter stabilization multiplier in [0.4, 1]. */
  get multiplier(): number {
    return stabilizationMultiplier(this.steadiness_);
  }
}
