/**
 * Idle micro-motions.
 *
 * People who have forgotten they are people still have bodies, and bodies
 * cannot hold perfectly still. While an entity stands -- pausing mid-loop,
 * waiting for something that never arrives -- it shifts its weight, rolls a
 * shoulder, tilts its head toward a thought. Except the watchers. The
 * watchers were made to be looked at; statues do not scratch their noses.
 *
 * Pure simulation logic: no Babylon imports. update() consumes a timestep
 * and an archetype and returns the pose modifiers the caller should apply,
 * or null when the body is resting.
 */
import { RNG } from '../core/rng';

/** One idle fidget every 8-20 seconds (seeded). */
const GAP_MIN = 8;
const GAP_MAX = 20;
/** Each fidget lasts 1-3 seconds including its ease in/out. */
const DUR_MIN = 1;
const DUR_MAX = 3;

/** Peak amplitudes. */
const HEAD_TILT_DEG = 10; // head tilt holds +-10deg
const SHOULDER_Y_M = 0.01; // shoulder roll y-offset +-0.01m
const HANDFACE_ROLL_DEG = 12; // arm proxy rotation, read through body roll
const WEIGHT_LEAN_DEG = 2; // slight lean +-2deg

const DEG = Math.PI / 180;

export type FidgetKind =
  | 'headTilt' // head tips +-10deg and holds ~2s
  | 'shoulderRoll' // shoulders rise/drop, y-offset +-0.01m
  | 'handToFace' // one arm raises toward where a face used to be
  | 'weightShift'; // weight rocks onto one leg, slight lean +-2deg

export interface FidgetPose {
  /** Vertical offset in metres (shoulder roll). */
  yOff: number;
  /** Body roll / arm-proxy rotation in radians (weight shift, hand-to-face). */
  rotZ: number;
  /** Head tilt offset in radians (head tilt). */
  rotHeadX: number;
}

interface FidgetDef {
  kind: FidgetKind;
  /** Relative selection weight per archetype; missing key means weight 1. */
  weights: Partial<Record<string, number>>;
  /** Plateau length at full amplitude, seconds. */
  holdSeconds: number;
}

const FIDGETS: readonly FidgetDef[] = [
  {
    kind: 'headTilt',
    weights: { watcher: 0 },
    holdSeconds: 2,
  },
  {
    kind: 'shoulderRoll',
    weights: { watcher: 0 },
    holdSeconds: 0.25,
  },
  {
    kind: 'handToFace',
    // believers favour this: it reads as prayer to whatever they worship here
    weights: { watcher: 0, believer: 3 },
    holdSeconds: 0.5,
  },
  {
    kind: 'weightShift',
    // wanderers favour this: feet used to carry them somewhere
    weights: { watcher: 0, wanderer: 3 },
    holdSeconds: 0.4,
  },
];

function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Ease-in / plateau / ease-out envelope over [0, dur], peak amplitude 1.
 * The fades split whatever time the hold leaves over.
 */
function envelope(elapsed: number, dur: number, hold: number): number {
  const fade = Math.max(0.05, (dur - Math.min(hold, dur * 0.6)) / 2);
  if (elapsed < fade) return smoothstep(elapsed / fade);
  if (elapsed < fade + hold) return 1;
  if (elapsed < fade + hold + fade) return smoothstep(1 - (elapsed - fade - hold) / fade);
  return 0;
}

function weightOf(def: FidgetDef, archetype: string): number {
  const w = def.weights[archetype];
  return w === undefined ? 1 : w;
}

export class IdleFidgets {
  private readonly rng: RNG;
  private life = 0;
  private nextAt: number;
  /** Currently playing fidget; null between fidgets. */
  private active: FidgetDef | null = null;
  private startedAt = -1;
  private duration = 0;
  /** Sign/side of the motion, picked per fidget. */
  private side = 1;
  /** Archetype seen on the most recent update(); used by pick(). */
  private archetype = '';
  /** Kind of the most recent (or current) fidget, for callers and tests. */
  lastKind: FidgetKind | null = null;

  constructor(seed: number) {
    this.rng = new RNG(seed);
    this.nextAt = this.rng.range(GAP_MIN, GAP_MAX);
  }

  /** Kind being played right now; null between fidgets. */
  get activeKind(): FidgetKind | null {
    return this.active === null ? null : this.active.kind;
  }

  /**
   * Advance the idle clock. Returns the current pose modifiers while a
   * fidget plays, null otherwise. Watchers never fidget: update() returns
   * null forever and no internal state advances.
   */
  update(dt: number, archetype: string): FidgetPose | null {
    // statues do not fidget -- their internal clock does not even run
    if (archetype === 'watcher') return null;
    if (dt <= 0 && this.active !== null) return this.sample();
    this.archetype = archetype;
    this.life += dt;

    if (this.active !== null) {
      const elapsed = this.life - this.startedAt;
      if (elapsed >= this.duration) {
        this.active = null;
        // schedule from the fidget's exact end so gaps stay inside [8,20]
        this.nextAt = this.startedAt + this.duration + this.rng.range(GAP_MIN, GAP_MAX);
      } else {
        return this.sample();
      }
    }

    if (this.life >= this.nextAt) {
      this.begin();
      return this.sample();
    }
    return null;
  }

  private begin(): void {
    const def = this.pick();
    this.active = def;
    this.lastKind = def.kind;
    this.startedAt = this.life;
    this.duration = this.rng.range(DUR_MIN, DUR_MAX);
    this.side = this.rng.chance(0.5) ? 1 : -1;
  }

  private pick(): FidgetDef {
    let total = 0;
    let i = 0;
    for (; i < FIDGETS.length; i++) total += weightOf(FIDGETS[i], this.archetype);
    let roll = this.rng.next() * total;
    for (i = 0; i < FIDGETS.length; i++) {
      roll -= weightOf(FIDGETS[i], this.archetype);
      if (roll < 0) return FIDGETS[i];
    }
    return FIDGETS[FIDGETS.length - 1];
  }

  private sample(): FidgetPose {
    const def = this.active as FidgetDef;
    const e = envelope(this.life - this.startedAt, this.duration, def.holdSeconds);
    const s = this.side * e;
    switch (def.kind) {
      case 'headTilt':
        return { yOff: 0, rotZ: 0, rotHeadX: s * HEAD_TILT_DEG * DEG };
      case 'shoulderRoll':
        return { yOff: s * SHOULDER_Y_M, rotZ: 0, rotHeadX: 0 };
      case 'handToFace':
        // arm proxy: the torso rolls slightly as the hand comes up
        return { yOff: 0, rotZ: s * HANDFACE_ROLL_DEG * DEG, rotHeadX: s * 2 * DEG };
      case 'weightShift':
        return { yOff: 0, rotZ: s * WEIGHT_LEAN_DEG * DEG, rotHeadX: 0 };
    }
  }
}


