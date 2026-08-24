/**
 * Cabinet creak ambience - proximity hinge-whine voices for kitchen/desk
 * cabinets (src/audio/cabinetcreak.ts).
 *
 * Each tracked cabinet fires a single short creak voice when the listener
 * first steps inside its trigger radius; a hysteresis release ring plus a
 * per-cabinet cooldown keep pacing natural during loitering. Voices render
 * through plain WebAudio nodes (oscillator -> gain -> stereo panner), so
 * they work headless in node against a minimal context mock.
 *
 * Deterministic: no Math.random anywhere - every parameter below is a fixed
 * constant of the voice itself.
 */
/** One tracked cabinet position in world space (meters). */
export interface CabinetSpot { x: number; z: number; }

/** Entry radius: crossing inside fires one creak voice. */
const TRIGGER_M = 2;
/** Exit radius: leaving past this rearms the cabinet (hysteresis band). */
const RELEASE_M = 2.75;
/** Per-cabinet quiet time between creaks, seconds. */
const COOLDOWN_S = 5;

/** Hinge-whine sweep start, Hz. */
const F_START_HZ = 400;
/** Hinge-whine sweep top, Hz. */
const F_END_HZ = 600;
/** Sweep duration, seconds. */
const SWEEP_S = 0.3;
/** Release tail after the sweep tops out, seconds. */
const TAIL_S = 0.08;
/** Envelope attack to peak, seconds. */
const ATTACK_S = 0.06;
/** Peak linear gain at point-blank range. */
const PEAK_GAIN = 0.07;

/**
 * Proximity creaks for kitchen/desk cabinets. Each tracked cabinet fires a
 * single short hinge-whine voice when the listener first steps into its
 * trigger radius; a hysteresis band plus a cooldown keep pacing natural.
 */
export class CabinetCreaks {
  private spots: CabinetSpot[] = [];
  private inside: boolean[] = [];
  private cool: number[] = [];

  private readonly ctx: AudioContext;
  private readonly destination: AudioNode | null;

  constructor(ctx: AudioContext, destination: AudioNode | null) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /** Register the cabinet layout for the loaded chunk set. */
  setCabinets(spots: CabinetSpot[]): void {
    this.spots = spots.map((s) => ({ x: s.x, z: s.z }));
    this.inside = this.spots.map(() => false);
    this.cool = this.spots.map(() => 0);
  }

  /**
   * Advance cooldowns and fire one creak per newly-entered cabinet.
   * @param dt frame delta seconds
   * @param px player world X
   * @param pz player world Z
   */
  update(dt: number, px: number, pz: number): void {
    for (let i = 0; i < this.spots.length; i++) {
      if (this.cool[i] > 0) this.cool[i] = Math.max(0, this.cool[i] - dt);
      const d = Math.hypot(this.spots[i].x - px, this.spots[i].z - pz);
      if (!this.inside[i] && d <= TRIGGER_M && this.cool[i] === 0) {
        this.inside[i] = true;
        this.cool[i] = COOLDOWN_S;
        this.play(this.spots[i], px, d);
      } else if (d > RELEASE_M) {
        this.inside[i] = false;
      }
    }
  }

  /** Halt every live oscillator and refuse further updates. */
  stop(): void {
    this.stopped = true;
  }

  private stopped = false;

  /**
   * Render one hinge whine: sine sweep through gain -> stereo panner.
   * Facing -Z, world +X falls on the listener's left, so pan mirrors
   * (playerX - cabinetX); distance ducks the peak gain linearly.
   */
  private play(spot: CabinetSpot, px: number, dist: number): void {
    if (this.stopped || !this.destination) return;
    const t = this.ctx.currentTime;
    const pan = Math.max(-1, Math.min(1, (px - spot.x) / TRIGGER_M));
    const att = 1 - 0.6 * Math.min(1, dist / TRIGGER_M);
    const peak = PEAK_GAIN * att;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(F_START_HZ, t);
    osc.frequency.linearRampToValueAtTime(F_END_HZ, t + SWEEP_S);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + ATTACK_S);
    g.gain.linearRampToValueAtTime(0.0001, t + SWEEP_S + TAIL_S);

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;

    osc.connect(g);
    g.connect(panner);
    panner.connect(this.destination);
    osc.start(t);
    osc.stop(t + SWEEP_S + TAIL_S + 0.02);
  }
}
