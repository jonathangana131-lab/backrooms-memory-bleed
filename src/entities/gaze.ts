/**
 * Entity gaze tracking.
 *
 * Every reconstructed human feels you before it sees you. Inside the
 * peripheral arc a head begins to orient -- subtly, even mid-patrol --
 * and the closer you walk, the harder the lock becomes. Watchers never
 * let go. Everyone else can only hold your eyes for a few seconds
 * before something older than memory makes them look away.
 *
 * Pure simulation logic: no Babylon imports. update() consumes a
 * timestep plus the player and figure positions/body yaw and returns a
 * single scalar -- the head yaw OFFSET (radians) relative to the body
 * yaw the caller should apply to the figure's head node.
 *
 * Yaw convention matches the rest of the entity code:
 *   worldYaw(direction) = atan2(dx, dz)
 *   positive offsets turn the head toward the figure's left.
 */

export interface GazeOptions {
  /**
   * Watchers hold unbroken eye contact and never glance away.
   * Everyone else averts after 2-4 seconds of mutual gaze.
   */
  watcher?: boolean;
  /** Deterministic seed for glance-away timing. Default 0. */
  seed?: number;
  /**
   * Half-angle of the peripheral awareness cone in degrees. The figure
   * only orients its head while the player stands within +/- this many
   * degrees of where its body faces. Default 60.
   */
  peripheralHalfAngleDeg?: number;
  /** Head rotation speed cap in degrees/second. Default 90. */
  maxTurnRateDegPerSec?: number;
  /** Neck clamp in degrees; heads never exceed +/- this offset. Default 75. */
  neckClampDeg?: number;
}

/** Full lock inside this distance (metres). */


const LOCK_RANGE = 5;
/** Gentle-bias distance: tracking is weakest-but-present here. */
const FADE_START = 20;
/** Beyond this distance the head does not track at all (metres). */
const FADE_END = 25;
/** Tracking strength at FADE_START (a gentle bias, not a lock). */
const FAR_BIAS = 0.2;

function wrapAngle(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Small deterministic LCG so glance-away timing needs no dependency on
 * the shared RNG module and stays reproducible per figure.
 */
class TinyRng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    // mulberry32-style integer mix, deterministic across runs
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
}

export interface GazeState {
  /** Distance to the player this frame, metres. */
  distance: number;
  /** True while the player stands inside the peripheral cone. */
  inPeripheral: boolean;
  /** Current tracking strength, 0..1 (1 = full lock). */
  weight: number;
  /** Seconds of continuous mutual gaze accumulated (non-watchers). */
  mutualGazeTime: number;
  /** True while deliberately glancing away from the player. */
  averting: boolean;
}

export class GazeController {
  private readonly watcher: boolean;
  private readonly peripheralCos: number;
  private readonly maxTurnRate: number; // rad/s
  private readonly neckClamp: number; // rad

  private rng: TinyRng;
  /** Smoothed head yaw offset actually held, radians. */
  private currentOffset = 0;
  private weight = 0;
  private mutualTime = 0;
  private averting = false;
  private avertUntil = 0;
  private avertTarget = 0;
  private nextAvertAt: number;
  private lastDistance = 0;
  private inPeripheral = false;

  constructor(opts: GazeOptions = {}) {
    this.watcher = opts.watcher === true;
    const halfDeg = opts.peripheralHalfAngleDeg ?? 60;
    this.peripheralCos = Math.cos((halfDeg * Math.PI) / 180);
    this.maxTurnRate = ((opts.maxTurnRateDegPerSec ?? 90) * Math.PI) / 180;
    this.neckClamp = ((opts.neckClampDeg ?? 75) * Math.PI) / 180;
    this.rng = new TinyRng(((opts.seed ?? 0) ^ 0x51ed270b) >>> 0);
    this.nextAvertAt = this.rng.range(2, 4);
  }

  /** Current head yaw offset relative to body yaw, radians. */
  get headYawOffset(): number {


    return this.currentOffset;
  }

  /** Snapshot of internal state, useful for tuning and tests. */
  get state(): GazeState {
    return {
      distance: this.lastDistance,
      inPeripheral: this.inPeripheral,
      weight: this.weight,
      mutualGazeTime: this.mutualTime,
      averting: this.averting,
    };
  }

  /**
   * Advance one frame.
   *
   * @param dt        timestep, seconds
   * @param px pz     player position
   * @param fx fz     figure position
   * @param bodyYaw   figure body yaw (world yaw = atan2(dx, dz) convention)
   * @returns head yaw offset in radians to apply to the head node
   */
  update(dt: number, px: number, pz: number, fx: number, fz: number, bodyYaw: number): number {
    const dx = px - fx;
    const dz = pz - fz;
    const dist = Math.hypot(dx, dz);
    this.lastDistance = dist;

    const toPlayerYaw = dist > 1e-6 ? Math.atan2(dx, dz) : bodyYaw;
    const rawOffset = wrapAngle(toPlayerYaw - bodyYaw);

    // --- peripheral gate: angle between body forward and player direction ---
    // inside the cone  <=>  cos(angle) >= cos(half-angle)
    this.inPeripheral = dist > 1e-6 && Math.cos(rawOffset) >= this.peripheralCos - 1e-9;

    // --- proximity weight: full at LOCK_RANGE, FAR_BIAS at FADE_START, 0 past FADE_END ---
    let targetWeight: number;
    if (dist <= LOCK_RANGE) {
      targetWeight = 1;
    } else if (dist < FADE_START) {
      const t = (dist - LOCK_RANGE) / (FADE_START - LOCK_RANGE);
      targetWeight = 1 + (FAR_BIAS - 1) * t;
    } else if (dist < FADE_END) {
      const t = (dist - FADE_START) / (FADE_END - FADE_START);
      targetWeight = FAR_BIAS * (1 - t);
    } else {
      targetWeight = 0;
    }
    // outside the cone the head relaxes entirely
    if (!this.inPeripheral) targetWeight = 0;

    this.weight += (targetWeight - this.weight) * clamp(dt * 8, 0, 1);

    // --- mutual-gaze bookkeeping (watchers are exempt from averting) ---
    if (!this.watcher && this.inPeripheral && dist <= LOCK_RANGE && !this.averting) {
      // close enough for eye contact and already oriented -> mutual gaze
      this.mutualTime += dt;
      if (this.mutualTime >= this.nextAvertAt) {
        this.averting = true;
        this.avertUntil = this.rng.range(1, 3);
        // glance off to one side, well clear of the player
        const side = this.rng.next() < 0.5 ? -1 : 1;
        this.avertTarget = side * this.rng.range(0.7, 1.1) * this.neckClamp;
      }
    }
    if (this.averting) {
      this.avertUntil -= dt;
      if (this.avertUntil <= 0 || !this.inPeripheral || dist > LOCK_RANGE * 2) {
        this.averting = false;
        this.mutualTime = 0;
        this.nextAvertAt = this.rng.range(2, 4);
      }
    } else if (!this.inPeripheral || dist > LOCK_RANGE) {
      // broken contact drains the clock
      this.mutualTime = Math.max(0, this.mutualTime - dt * 2);
    }

    // --- desired offset ---
    let desired: number;
    if (this.averting) {
      desired = this.avertTarget;
    } else {
      const clamped = clamp(rawOffset, -this.neckClamp, this.neckClamp);
      desired = clamped * this.weight;
    }

    // --- smooth motion: proportional ease capped at maxTurnRate ---
    const delta = wrapAngle(desired - this.currentOffset);
    const ease = clamp(Math.abs(delta) * 6, 0, 1);
    let step = delta * ease;
    const maxStep = this.maxTurnRate * dt;
    if (Math.abs(step) > maxStep) step = Math.sign(step) * maxStep;
    this.currentOffset = wrapAngle(this.currentOffset + step);

    return this.currentOffset;
  }
}


