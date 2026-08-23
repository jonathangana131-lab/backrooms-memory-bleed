/**
 * Distant self-moving doors for BACKROOMS: MEMORY BLEED.
 *
 * Every 45-90 s during calm/build phases a door somewhere in the dark
 * creaks open or shut by itself. Fully procedural, no asset files:
 *
 *   CREAK     one sawtooth swept slowly 80 -> 140 Hz through a lowpass,
 *             amplitude chopped into irregular stick-slip stutters (the
 *             hinge grabs, releases, grabs again), kept very quiet.
 *   PLACEMENT random bearing around the player at 15-40 m; stereo pan
 *             follows the bearing, volume follows an inverse-square
 *             falloff so far doors barely breathe.
 *   SCHEDULER never fires while the director is tense, and never picks
 *             the same compass quadrant twice in a row.
 *   TORCH     shine the torch toward the door's bearing within 3 s and
 *             something answers: a second, softer creak from the same
 *             spot a beat later.
 */

const TWO_PI = Math.PI * 2;

/** Inverse-square distance attenuation, unity at 5 m and closer. */
function rolloff(dist: number): number {
  const REF = 5;
  if (!(dist >= REF)) return 1;
  const r = REF / dist;
  return r * r;
}

/** Compass quadrant of a bearing: 0 NE, 1 SE, 2 SW, 3 NW. */
function quadrantOf(bearing: number): number {
  return Math.floor((((bearing % TWO_PI) + TWO_PI) % TWO_PI) / (Math.PI / 2));
}

export class DoorCreaks {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Seconds until the next scheduled self-moving door. */
  private nextIn = 10 + Math.random() * 10;
  /** Quadrant of the most recent creak; never repeated consecutively. */
  private lastQuadrant = -1;

  /** Beam-response window: bearing of the last creak and when it closes. */
  private beamBearing = 0;
  private beamWindowUntil = 0;
  private beamUsed = true;
  /** Bearing of a queued answer creak and when it should sound. */
  private answerAt = -1;
  private answerBearing = 0;
  private answerDist = 20;
  /** Raw bearing and distance of the most recent scheduled door. */
  private lastBearing = 0;
  private lastDist = 20;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = destination;
  }

  /**
   * Per-frame tick.
   * @param dt      seconds since the previous frame
   * @param tension director tension 0..1; creaks only occur in the
   *                calm/build half (tension <= 0.4)
   */
  update(dt: number, tension = 0): void {
    // A torch beam toward the door's origin inside the 3 s window earns
    // an answer; schedule it here so timing stays frame-driven too.
    if (this.answerAt >= 0 && this.ctx.currentTime >= this.answerAt) {
      this.answerAt = -1;
      // Same door, same distance: only the volume says something moved again.
      this.creak(this.answerBearing, this.answerDist, 0.5);
    }

    this.nextIn -= dt;
    if (this.nextIn > 0 || tension > 0.4) return;
    this.nextIn = 45 + Math.random() * 45;
    this.distantDoor();
  }

  /**
   * The player just swept the torch beam horizontally.
   * @param pan beam centre, -1 hard left .. 1 hard right
   */
  torchToward(pan: number): void {
    if (this.beamUsed || this.ctx.currentTime >= this.beamWindowUntil) return;
    if (Math.abs(pan - this.beamBearing) > 0.45) return; // wrong direction
    this.beamUsed = true;
    // Something moved again — quieter, a beat later, roughly the same spot.
    this.answerAt = this.ctx.currentTime + 0.5 + Math.random() * 0.9;
    this.answerBearing = this.lastBearing; // raw bearing, not the panned value
    this.answerDist = this.lastDist;
  }

  /** Pick a fresh door somewhere: new quadrant, 15-40 m out, then creak it. */
  private distantDoor(): void {
    // Four quadrants; skip whichever the last door came from.
    const choices = [0, 1, 2, 3].filter((q) => q !== this.lastQuadrant);
    const q = choices[Math.floor(Math.random() * choices.length)];
    this.lastQuadrant = q;
    const bearing = (q + Math.random()) * (Math.PI / 2);
    const dist = 15 + Math.random() * 25;
    this.lastDist = dist;
    this.creak(bearing, dist, 1);

    // Open the 3 s torch-response window on this door's bearing.
    this.lastBearing = bearing;
    this.beamBearing = panFor(bearing);
    this.beamWindowUntil = this.ctx.currentTime + 3;
    this.beamUsed = false;
  }

  /**
   * One creak voice.
   * @param bearing horizontal bearing of the door, radians
   * @param dist    metres from the listener
   * @param volMul  1 for scheduled doors, ~0.5 for torch-answer creaks
   */
  private creak(bearing: number, dist: number, volMul: number): void {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = 1.7 + Math.random() * 1.1;

    // Slow sawtooth sweep 80 -> 140 Hz with per-door jitter; a touch of
    // downward drift at the tail reads as the door settling shut.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const fLo = 78 + Math.random() * 14;
    const fHi = 128 + Math.random() * 24;
    o.frequency.setValueAtTime(fLo, t0);
    o.frequency.linearRampToValueAtTime(fHi, t0 + dur * 0.72);
    o.frequency.linearRampToValueAtTime(fLo + (fHi - fLo) * 0.35, t0 + dur);

    // Lowpass keeps it muffled and distant; higher cutoff for nearer doors.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420 + 900 * rolloff(dist);
    lp.Q.value = 0.8;

    // Stick-slip envelope: irregular grab/release stutters instead of a
    // smooth swell. Each cycle ramps up (slip — audible screech) then
    // collapses almost to silence (stick — hinge holding).
    const g = ctx.createGain();
    const peak = 0.085 * rolloff(dist) * volMul;
    g.gain.setValueAtTime(0.0001, t0);
    let t = t0 + 0.12;
    while (t < t0 + dur - 0.25) {
      const rise = 0.05 + Math.random() * 0.14;
      const lvl = peak * (0.3 + Math.random() * 0.7);
      g.gain.linearRampToValueAtTime(lvl, t + rise);
      t += rise;
      const hold = 0.03 + Math.random() * 0.08;
      g.gain.linearRampToValueAtTime(lvl * 0.12, t + hold);
      t += hold;
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    const p = ctx.createStereoPanner();
    p.pan.value = panFor(bearing);

    o.connect(lp).connect(g).connect(p).connect(this.out);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** Test hooks: which quadrant sounded last, and whether a beam may still answer. */
  get lastDoorQuadrant(): number { return this.lastQuadrant; }
  get awaitingBeam(): boolean { return !this.beamUsed && this.ctx.currentTime < this.beamWindowUntil; }
}

/** Stereo pan for a bearing: forward 0, right +1, behind 0, left -1. */
function panFor(bearing: number): number {
  return Math.max(-1, Math.min(1, Math.sin(bearing)));
}


