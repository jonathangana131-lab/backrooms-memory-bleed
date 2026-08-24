/**
 * Ceiling-fan speed-state audio for BACKROOMS: MEMORY BLEED.
 *
 * Where FanAudio (fanaudio.ts) renders the blade whoosh of one nearby
 * fan, FanSpeedAudio renders the building-wide MOTOR voice that follows
 * each chunk's deterministic fan speed state -- the hum you hear through
 * the ceiling tiles without ever looking up:
 *
 *   HUM      one triangle oscillator whose pitch and level track the
 *            current state (OFF silent, SLOW 42 Hz, MEDIUM 58, FAST 74).
 *   BELT     every state change fires a short belt-squeak gliss while
 *            the motor spins up or coasts down.
 *   WOBBLE    at MEDIUM/FAST a periodic bent-rod knock ticks once per
 *            revolution, faster and louder the higher the state.
 *
 * Fully procedural Web Audio following doors.ts conventions: lazy graph
 * build on the first audible state, per-voice try/catch islands logging
 * '[bmb] ...', update() never throws. Wobble cadence derives from fixed
 * per-state constants; no Math.random anywhere.
 */

/** Ceiling-fan operating states fed from the per-chunk placement lottery. */
export type FanSpeedState = 'OFF' | 'SLOW' | 'MEDIUM' | 'FAST';

/** All states in ascending speed order. */
export const FAN_SPEED_STATES: readonly FanSpeedState[] = ['OFF', 'SLOW', 'MEDIUM', 'FAST'];

/** Hum pitch per state, Hz (OFF never reaches the graph). */
const HUM_HZ: Readonly<Record<FanSpeedState, number>> = {
  OFF: 0,
  SLOW: 42,
  MEDIUM: 58,
  FAST: 74,
};

/** Hum level per state. */
const HUM_LEVEL: Readonly<Record<FanSpeedState, number>> = {
  OFF: 0,
  SLOW: 0.006,
  MEDIUM: 0.01,
  FAST: 0.014,
};

/** Revolutions per second per state, mirroring the game-side speed feed. */
const REVS_PER_SEC: Readonly<Record<FanSpeedState, number>> = {
  OFF: 0,
  SLOW: 0.9,
  MEDIUM: 1.7,
  FAST: 2.6,
};

export class FanSpeedAudio {
  private readonly ctx: AudioContext;
  private readonly destination: AudioNode;

  private built = false;
  private stopped = false;

  // ---- motor hum ----
  private humOsc: OscillatorNode | null = null;
  private humGain: GainNode | null = null;

  /** Currently engaged state; OFF tears the motor down. */
  private state: FanSpeedState = 'OFF';
  /** Countdown to the next bent-rod wobble knock, seconds. */
  private nextWobbleIn = 0;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /**
   * Engage a new speed state. Transitioning between two running states
   * squeaks the belt; engaging from OFF builds the motor lazily.
   * @param state ceiling-fan speed for the current chunk
   */
  setState(state: FanSpeedState): void {
    if (this.stopped || state === this.state) return;
    const wasOff = this.state === 'OFF';
    const spinningUp = !wasOff && this.state !== 'OFF';
    this.state = state;

    if (state === 'OFF') {
      this.tearDown();
      return;
    }
    try {
      if (!this.built) this.build();
      const t = this.ctx.currentTime;
      this.humOsc!.frequency.setTargetAtTime(HUM_HZ[state], t, 0.8);
      this.humGain!.gain.setTargetAtTime(HUM_LEVEL[state], t, 0.8);
      if (spinningUp) this.beltSqueak(t);
      this.nextWobbleIn = 1 / REVS_PER_SEC[state];
    } catch (e) {
      console.warn('[bmb] fan state failed', e);
    }
  }

  /**
   * Per-frame tick: advances the wobble cadence for the current state.
   * @param dt seconds since the previous frame
   */
  update(dt: number): void {
    if (this.stopped || dt <= 0 || this.state === 'OFF') return;
    try {
      if (!this.built) return;
      this.nextWobbleIn -= dt;
      if (this.nextWobbleIn > 0) return;
      this.nextWobbleIn = 1 / REVS_PER_SEC[this.state];
      this.wobbleKnock(this.ctx.currentTime + 0.01, this.state);
    } catch (e) {
      console.warn('[bmb] fan wobble failed', e);
    }
  }

  /** Silence everything and release nodes; the instance will not restart. */
  stop(): void {
    this.stopped = true;
    this.tearDown();
  }

  // ---------------------------------------------------------------------------

  /** Build the motor hum once, the first time a running state engages. */
  private build(): void {
    this.built = true;
    this.humOsc = this.ctx.createOscillator();
    this.humOsc.type = 'triangle';
    this.humOsc.frequency.value = HUM_HZ[this.state];
    this.humGain = this.ctx.createGain();
    this.humGain.gain.value = 0;
    this.humOsc.connect(this.humGain).connect(this.destination);
    this.humOsc.start();
  }

  /** Stop the motor and drop back to a cold graph. */
  private tearDown(): void {
    if (this.humOsc) { try { this.humOsc.stop(); } catch { /* already stopped */ } this.humOsc = null; }
    this.humGain = null;
    this.built = false;
  }

  /** Short rising sine gliss when the drive train changes speed live. */
  private beltSqueak(at: number): void {
    try {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1400, at);
      osc.frequency.linearRampToValueAtTime(1900, at + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(0.004, at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(g).connect(this.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    } catch (e) {
      console.warn('[bmb] fan belt failed', e);
    }
  }

  /**
   * One bent-rod knock: a fast downward pitch thud once per revolution,
 * heavier in the faster states.
   */
  private wobbleKnock(at: number, state: FanSpeedState): void {
    try {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(95, at);
      osc.frequency.exponentialRampToValueAtTime(45, at + 0.09);
      const g = this.ctx.createGain();
      const peak = state === 'FAST' ? 0.02 : 0.012;
      g.gain.setValueAtTime(peak, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
      osc.connect(g).connect(this.destination);
      osc.start(at);
      osc.stop(at + 0.13);
    } catch (e) {
      console.warn('[bmb] fan knock failed', e);
    }
  }
}
