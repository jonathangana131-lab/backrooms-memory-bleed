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


  private stopped = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /**
   * Per-frame tick driven by the torch battery.
   * @param batteryPct charge as a fraction (0..1) or a percentage (0..100)
   * @param recharging true while the pack is on charge (warnings suppressed)
   */
  update(batteryPct: number, recharging: boolean): void {
    if (this.stopped) return;
    // Accept either a 0..1 fraction or a 0..100 percentage.
    const pct = batteryPct <= 1 ? batteryPct * 100 : batteryPct;
    const t = this.ctx.currentTime;

    if (recharging) {
      if (pct >= 99.5 && !this.fullAnnounced) {
        this.fullAnnounced = true;
        this.tone(660, t, 0.09, 0.05);
        this.tone(880, t + 0.11, 0.14, 0.05);
      }
      return;
    }
    if (pct < 99.5) this.fullAnnounced = false;

    if (pct < CRITICAL_PCT) {
      if (t >= this.nextCriticalAt) {
        this.nextCriticalAt = t + CRITICAL_INTERVAL;
        this.nextLowAt = Math.max(this.nextLowAt, t + LOW_INTERVAL); // never double up
        this.tone(1200, t, 0.12, 0.07);
      }
    } else if (pct < LOW_PCT) {
      if (t >= this.nextLowAt) {
        this.nextLowAt = t + LOW_INTERVAL;
        this.tone(880, t, 0.06, 0.04);
        this.tone(880, t + 0.15, 0.06, 0.04);
      }
    }
  }

  /** Ascending three-note arpeggio confirming a collected battery cell. */
  pickupSound(): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    this.tone(520, t, 0.07, 0.05);
    this.tone(660, t + 0.08, 0.07, 0.05);
    this.tone(880, t + 0.16, 0.11, 0.05);
  }

  /** Silence everything; every later cue becomes a no-op. */
  stop(): void {
    this.stopped = true;
  }

  /** One soft sine blip through a short gain envelope into the bus. */
  private tone(freq: number, at: number, dur: number, peak: number): void {
    try {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(g);
      g.connect(this.out);
      osc.start(at);
      osc.stop(at + dur + 0.02);
    } catch (err) {
      console.warn('[bmb] battery cue failed', err);
    }
  }
}
