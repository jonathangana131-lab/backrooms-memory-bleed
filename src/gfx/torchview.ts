/**
 * Torch view-model (F11): the visible flashlight hand.
 *
 * A pure pose model that drives an injected mesh-like target (anything
 * with position/rotation setters) so the torch reads as a held object
 * instead of a floating spotlight. No Babylon imports: game.ts builds
 * the mesh and feeds it here every frame.
 *
 * Motion layers, composed additively onto the rest pose:
 *  - Idle sway: two-frequency sine drift per axis, phases hashed from
 *    the seed (src/core/rng.ts law) so the drift is bounded and
 *    deterministic per seed.
 *  - Walk bob: phase advanced by an injected speed provider, so stride
 *    rhythm comes from the controller rather than a wall clock.
 *  - Recoil kick: exponential-decay pitch/backward jolt fired on toggle.
 *  - Battery-swap beat: lower -> pause -> raise timeline, total <= 1.2 s,
 *    started by beginSwap() when game.ts sees the battery-swap event.
 *
 * Light anchor: getLightAnchor() returns the lens point derived from the
 * current pose by rotating anchorLocal with the SAME Euler order used for
 * the mesh, so the SpotLight parented to the anchor can never detach from
 * the visible hand. Rotation order is yaw (Y), then pitch (X), then roll
 * (Z), applied to local vectors as R = Ry * Rx * Rz.
 */
import { hash2i } from '../core/rng';

/** Minimal 3-vector read/written by this model. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Mesh-like consumer the model drives; satisfied by a Babylon TransformNode adapter. */
export interface TorchViewTarget {
  /** Place the mesh in camera-local space (meters). */
  setPosition(x: number, y: number, z: number): void;
  /** Orient the mesh with Euler angles in radians, Y-X-Z order semantics. */
  setRotation(x: number, y: number, z: number): void;
}

/** Injected speed source; returns planar speed in m/s (junk tolerated). */
export type SpeedProvider = () => number;

/** Optional construction parameters; every field has a procedural default. */
export interface TorchViewConfig {
  /** Deterministic seed for sway phases (src/core/rng.ts law). */
  seed?: number;
  /** Rest pose position in camera-local meters. */
  restPosition?: Vec3Like;
  /** Rest pose Euler angles in radians. */
  restRotation?: Vec3Like;
  /** Lens point in hand-local space; the SpotLight mounts here. */
  anchorLocal?: Vec3Like;
}

/** Hard ceiling on the whole battery-swap beat; the spec requires < 1.2 s. */
export const SWAP_MAX_DURATION = 1.2;

/** Idle-sway half-amplitudes (radians / meters). Bounds asserted by test. */
export const SWAY_YAW_AMP = 0.014;
export const SWAY_PITCH_AMP = 0.01;
export const SWAY_ROLL_AMP = 0.008;
export const SWAY_LATERAL_AMP = 0.006;

/** Walk-bob tuning: bob frequency is speed * BOB_HZ_PER_SPEED. */
export const BOB_HZ_PER_SPEED = 2.1;
/** Reference speed where bob reaches full amplitude (m/s). */
export const BOB_REF_SPEED = 3.2;
export const BOB_VERTICAL_AMP = 0.02;
export const BOB_LATERAL_AMP = 0.014;

/** Recoil: initial pitch kick (rad) and exponential decay tau (s). */
export const RECOIL_PITCH_KICK = 0.05;
export const RECOIL_BACK_KICK = 0.03;
const RECOIL_TAU = 0.11;
/** Recoil is considered settled below this envelope value. */
const RECOIL_EPSILON = 0.001;

/** Battery-swap beat segment durations (s); total 1.15 <= SWAP_MAX_DURATION. */
export const SWAP_LOWER_TIME = 0.45;
export const SWAP_PAUSE_TIME = 0.25;
export const SWAP_RAISE_TIME = 0.45;
export const SWAP_TOTAL_TIME = SWAP_LOWER_TIME + SWAP_PAUSE_TIME + SWAP_RAISE_TIME;

/** How far the hand dips during a swap: meters down and radians of pitch-down. */
export const SWAP_DIP_METERS = 0.34;
export const SWAP_DIP_PITCH = 0.55;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Sanitize any injected scalar: non-finite becomes fallback, range clamped. */
function sane(v: number, fallback: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

function vec(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

/** Copy a possibly-junk vector into a finite one, component-wise. */
function saneVec(v: Vec3Like | undefined, dx: number, dy: number, dz: number): Vec3Like {
  if (!v || typeof v !== 'object') return vec(dx, dy, dz);
  return vec(
    Number.isFinite(v.x) ? v.x : dx,
    Number.isFinite(v.y) ? v.y : dy,
    Number.isFinite(v.z) ? v.z : dz,
  );
}

/**
 * Rotate a local vector by Euler angles in the documented Y-X-Z order:
 * first roll about Z, then pitch about X, then yaw about Y.
 * @param v local vector
 * @param rx pitch radians
 * @param ry yaw radians
 * @param rz roll radians
 * @returns rotated vector (fresh object)
 */
function rotateEulerYXZ(v: Vec3Like, rx: number, ry: number, rz: number): Vec3Like {
  // roll (Z)
  const cz = Math.cos(rz), sz = Math.sin(rz);
  let x = v.x * cz - v.y * sz;
  let y = v.x * sz + v.y * cz;
  const z0 = v.z;
  // pitch (X)
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const y2 = y * cx - z0 * sx;
  const z2 = y * sx + z0 * cx;
  // yaw (Y)
  const cy = Math.cos(ry), sy = Math.sin(ry);
  return vec(x * cy + z2 * sy, y2, -x * sy + z2 * cy);
}

/** Immutable snapshot of the current computed pose. */
export interface TorchPose {
  position: Vec3Like;
  rotation: Vec3Like;
}

/**
 * Torch view-model. Feed update() once per frame; read back the pose on
 * the injected target or via pose/lightAnchor.
 */
export class TorchView {
  private readonly seed: number;
  private readonly restPos: Vec3Like;
  private readonly restRot: Vec3Like;
  private readonly anchorLocal: Vec3Like;
  private readonly target: TorchViewTarget;
  private readonly getSpeed: SpeedProvider;

  private clock = 0;
  private bobPhase = 0;
  private recoilAge = Infinity;
  private recoilStrength = 0;
  private swapElapsed = 0;
  private swapping = false;
  private lastPose: TorchPose;

  constructor(target: TorchViewTarget, getSpeed: SpeedProvider, config?: TorchViewConfig) {
    this.target = target;
    this.getSpeed =
      typeof getSpeed === 'function' ? getSpeed : (): number => 0;
    this.seed = sane(config?.seed ?? 0x7e110ca, 0x7e110ca, 0, 0xffffffff) >>> 0;
    this.restPos = saneVec(config?.restPosition, 0.18, -0.24, 0.38);
    this.restRot = saneVec(config?.restRotation, 0, 0, 0);
    this.anchorLocal = saneVec(config?.anchorLocal, 0, 0.05, 0.14);
    this.lastPose = { position: { ...this.restPos }, rotation: { ...this.restRot } };
    this.applyPose();
  }

  /**
   * Seeded sine phase for one motion channel.
   * @param channel stable per-channel salt
   * @returns phase in [0, 2pi)
   */
  private phase(channel: number): number {
    return (hash2i(this.seed, channel, 0x70bc) / 4294967296) * Math.PI * 2;
  }

  /**
   * Advance all layers and drive the injected target.
   * @param dt frame delta in seconds (non-finite/negative treated as 0)
   */
  update(dt: number): void {
    const step = sane(dt, 0, 0, 0.1);
    this.clock += step;

    // -- idle sway: two frequencies per axis, seeded phases --
    const t = this.clock;
    const yaw =
      SWAY_YAW_AMP * 0.62 * Math.sin(t * 2 * Math.PI * 0.9 + this.phase(1)) +
      SWAY_YAW_AMP * 0.38 * Math.sin(t * 2 * Math.PI * 1.7 + this.phase(2));
    const pitch =
      SWAY_PITCH_AMP * 0.62 * Math.sin(t * 2 * Math.PI * 0.7 + this.phase(3)) +
      SWAY_PITCH_AMP * 0.38 * Math.sin(t * 2 * Math.PI * 1.3 + this.phase(4));
    const roll =
      SWAY_ROLL_AMP * 0.62 * Math.sin(t * 2 * Math.PI * 0.5 + this.phase(5)) +
      SWAY_ROLL_AMP * 0.38 * Math.sin(t * 2 * Math.PI * 1.9 + this.phase(6));

    // -- walk bob from injected speed --
    const rawSpeed = this.getSpeed();
    const speed = sane(rawSpeed, 0, 0, 10);
    const speedFactor = clamp(speed / BOB_REF_SPEED, 0, 1);
    this.bobPhase += speed * BOB_HZ_PER_SPEED * step;
    const bobY = Math.sin(this.bobPhase * Math.PI * 2) * BOB_VERTICAL_AMP * speedFactor;
    const bobX = Math.cos(this.bobPhase * Math.PI) * BOB_LATERAL_AMP * speedFactor;

    // -- recoil decay --
    let recoil = 0;
    if (this.recoilStrength > 0 && this.recoilAge < Infinity) {
      this.recoilAge += step;
      const env = Math.exp(-this.recoilAge / RECOIL_TAU);
      if (env < RECOIL_EPSILON) {
        this.recoilStrength = 0;
        this.recoilAge = Infinity;
      }
      recoil = env * this.recoilStrength;
    }

    // -- battery-swap timeline --
    if (this.swapping) this.swapElapsed += step;
    const dip = this.swapDip();

    const px = this.restPos.x + bobX + Math.sin(t * 2 * Math.PI * 1.1 + this.phase(7)) * SWAY_LATERAL_AMP;
    const py = this.restPos.y + bobY - dip * SWAP_DIP_METERS - recoil * RECOIL_BACK_KICK * 0.5;
    const pz = this.restPos.z - recoil * RECOIL_BACK_KICK - dip * 0.08;
    const rx = this.restRot.x + pitch - dip * SWAP_DIP_PITCH + recoil * RECOIL_PITCH_KICK;
    const ryy = this.restRot.y + yaw;
    const rz = this.restRot.z + roll;

    this.lastPose = { position: vec(px, py, pz), rotation: vec(rx, ryy, rz) };
    this.applyPose();
  }

  /**
   * Current swap-timeline dip factor 0..1 (smoothed inside each segment).
   * @returns dip weight applied to position/pitch this frame
   */
  private swapDip(): number {
    if (!this.swapping) return 0;
    const t = this.swapElapsed;
    if (t <= SWAP_LOWER_TIME) {
      const u = clamp(t / SWAP_LOWER_TIME, 0, 1);
      return u * u * (3 - 2 * u);
    }
    if (t <= SWAP_LOWER_TIME + SWAP_PAUSE_TIME) return 1;
    const u = clamp((t - SWAP_LOWER_TIME - SWAP_PAUSE_TIME) / SWAP_RAISE_TIME, 0, 1);
    const eased = u * u * (3 - 2 * u);
    if (u >= 1) {
      this.swapping = false;
      return 0;
    }
    return 1 - eased;
  }

  /**
   * Fire the toggle recoil kick.
   * @param strength kick scale, clamped to 0..2 (default 1)
   */
  kick(strength = 1): void {
    this.recoilStrength = sane(strength, 1, 0, 2);
    this.recoilAge = 0;
  }

  /**
   * Start the battery-swap beat if one is not already playing.
   * @returns true when the swap started, false while one is in flight
   */
  beginSwap(): boolean {
    if (this.swapping) return false;
    this.swapping = true;
    this.swapElapsed = 0;
    return true;
  }

  /** True while the lower->pause->raise beat is on screen. */
  get isSwapping(): boolean {
    return this.swapping;
  }

  /** Seconds elapsed inside the current (or just-finished) swap. */
  get swapElapsedSeconds(): number {
    return this.swapElapsed;
  }

  /** Last computed pose; do not mutate. */
  get pose(): TorchPose {
    return this.lastPose;
  }

  /**
   * Lens point for the SpotLight mount: the local anchor carried by the
   * CURRENT pose, using the same Euler order as the mesh, so the light
   * follows the visible hand exactly.
   * @returns fresh world-of-camera anchor point
   */
  getLightAnchor(): Vec3Like {
    const off = rotateEulerYXZ(
      this.anchorLocal,
      this.lastPose.rotation.x,
      this.lastPose.rotation.y,
      this.lastPose.rotation.z,
    );
    return vec(
      this.lastPose.position.x + off.x,
      this.lastPose.position.y + off.y,
      this.lastPose.position.z + off.z,
    );
  }

  /** Push the current pose into the injected target. */
  private applyPose(): void {
    this.target.setPosition(
      this.lastPose.position.x,
      this.lastPose.position.y,
      this.lastPose.position.z,
    );
    this.target.setRotation(
      this.lastPose.rotation.x,
      this.lastPose.rotation.y,
      this.lastPose.rotation.z,
    );
  }
}
