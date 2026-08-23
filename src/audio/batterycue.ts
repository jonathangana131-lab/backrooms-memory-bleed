/**
 * Battery state audio cues for BACKROOMS: MEMORY BLEED.
 *
 * The torch is the player's lifeline; its charge level talks back
 * through small procedural cues, no asset files:
 *
 *   LOW      below 15% a soft double-beep (two short quiet 880 Hz
 *            sines) sounds once every 30 s.
 *   CRITICAL below 5% the double-beep is replaced by a single urgent
 *            1200 Hz beep every 10 s.
 *   FULL     the moment the pack reaches 100% while recharging a
 *            gentle ascending two-note confirmation plays
 *            (660 -> 880 Hz); once per charge cycle.
 *   PICKUP   pickupSound() confirms a collected battery cell with an
 *            ascending three-note arpeggio.
 *
 * Warnings are suppressed while recharging, and critical always
 * supersedes low so the interval never doubles up.
 */

export type BatteryCueKind = 'low' | 'critical' | 'full' | 'pickup';

/** Warning thresholds as percentages of full charge. */
const LOW_PCT = 15;
const CRITICAL_PCT = 5;

/** Seconds between repeats of each warning tier. */
const LOW_INTERVAL = 30;
const CRITICAL_INTERVAL = 10;

export class BatteryCues {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Absolute context times for the next scheduled warning of each tier. */
  private nextLowAt = 0;
  private nextCriticalAt = 0;
  /** True once the current charge cycle has played its full chime. */
  private fullAnnounced = false;
  /** True after stop(); every cue becomes a no-op. */

(Showing lines 1-40 of 145. Use offset=41 to continue.)

