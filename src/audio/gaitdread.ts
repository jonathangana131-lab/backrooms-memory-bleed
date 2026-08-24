/**
 * Gait-synced dread for BACKROOMS: MEMORY BLEED.
 *
 * High director tension pulls the player's footstep micro-timing toward
 * heartbeat phase coherence: the faster the heart races, the more your
 * stride onsets drift onto its beat, until you are walking inside your
 * own pulse. The effect stays subliminal - total drift is bounded well
 * below half a heartbeat so an onset can never jump past the beat it
 * is being pulled toward.
 *
 * Pure math core: every function here maps its arguments to a result
 * with no state, no clock reads, and no randomness, so callers can run
 * it per frame or replay any sweep bit-for-bit. Determinism needs no
 * RNG at all - identical inputs always produce identical offsets.
 */

/** Heartbeat period at rest, in seconds (~67 bpm). */
export const HEARTBEAT_PERIOD_REST = 0.9;

/**
 * Hard cap on stride drift as a fraction of the heartbeat interval.
 * Below 0.5 so a pulled onset approaches its nearest beat but can
 * never cross to the next one.
 */
export const MAX_DRIFT_FRACTION = 0.35;

/**
 * Fraction of the maximum pull applied at a given tension. Linear in
 * tension and monotonically non-decreasing over [0, 1], which is what
 * makes downstream phase coherence monotone in tension too.
 * @param tension director tension, clamped to [0, 1]
 * @returns pull fraction 0..1
 */
function driftGain(tension: number): number {
  const t = Math.min(Math.max(tension, 0), 1);
  return t;
}

/**
 * Timing offset for one footstep under gait dread.
 *
 * The stride's next onset is pulled toward the nearest heartbeat onset
 * on the shared clock, proportionally to tension. At tension 0 the
 * offset is exactly 0; at tension 1 it is bounded by
 * MAX_DRIFT_FRACTION of the heartbeat interval, so the stride leans
 * onto the pulse without ever snapping to it.
 *
 * @param tension director tension 0..1
 * @param nominalOnset absolute clock time (seconds) where the step
 *                      would land with no dread applied; this is the
 *                      stride phase expressed on the heartbeat's clock
 * @param heartbeatPeriod current heartbeat interval in seconds
 *                        (shortens as arousal rises; see
 *                        excitedHeartbeatPeriod)
 * @returns signed offset in seconds to add to the onset; monotone in
 *          tension, pure and deterministic
 */
export function dreadOffset(
  tension: number,
  nominalOnset: number,
  heartbeatPeriod: number,
): number {
  if (!Number.isFinite(nominalOnset)) return 0;
  if (!(heartbeatPeriod > 0)) return 0;
  const pullToBeat = Math.round(nominalOnset / heartbeatPeriod) * heartbeatPeriod
    - nominalOnset;
  const maxDrift = MAX_DRIFT_FRACTION * heartbeatPeriod;
  const raw = pullToBeat * driftGain(tension);
  return Math.min(Math.max(raw, -maxDrift), maxDrift);
}

/**
 * Apply dread offsets across a synthetic train of stride onsets.
 * @param tension director tension 0..1
 * @param onsets nominal onset times in seconds, in stride order
 * @param heartbeatPeriod current heartbeat interval in seconds
 * @returns new array of shifted onset times; input untouched
 */
export function applyGaitDread(
  tension: number,
  onsets: readonly number[],
  heartbeatPeriod: number,
): number[] {
  return onsets.map((t) => t + dreadOffset(tension, t, heartbeatPeriod));
}

/**
 * Phase-coherence metric between stride onsets and a heartbeat period:
 * the mean cosine of each onset's phase mapped to [0, 1]. An onset
 * exactly on a beat scores 1; halfway between beats scores 0.
 *
 * Because dreadOffset only ever moves an onset toward its nearest beat
 * and can never move it past (the drift cap is below half a period),
 * this metric is monotone non-decreasing in tension for any fixed
 * onset train.
 *
 * @param onsets onset times in seconds (already-shifted or nominal)
 * @param heartbeatPeriod heartbeat interval in seconds
 * @returns coherence in [0, 1]
 */
export function phaseCoherence(
  onsets: readonly number[],
  heartbeatPeriod: number,
): number {
  if (!(heartbeatPeriod > 0) || onsets.length === 0) return 0;
  let sum = 0;
  for (const t of onsets) sum += Math.cos(2 * Math.PI * (t / heartbeatPeriod));
  return (1 + sum / onsets.length) / 2;
}

/**
 * Heartbeat interval under arousal: tension shortens the period, which
 * raises the resting pulse the stride is being pulled toward.
 * @param tension director tension 0..1
 * @param restPeriod period at rest in seconds
 * @returns shortened heartbeat interval in seconds, monotone
 *          non-increasing in tension
 */
export function excitedHeartbeatPeriod(tension: number, restPeriod = HEARTBEAT_PERIOD_REST): number {
  const t = Math.min(Math.max(tension, 0), 1);
  return restPeriod * (1 - MAX_DRIFT_FRACTION * t);
}
