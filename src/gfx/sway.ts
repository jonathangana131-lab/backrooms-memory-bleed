/**
 * Hanging fixture sway: pendulum motion for suspended fluorescent fixtures.
 *
 * Fixtures hang from ceiling mounts, so they sway gently like pendulums:
 * rotation.z oscillates +/-1.5 deg at ~0.4 Hz with a per-fixture phase
 * offset. During the director's peak phase (`tension` -> 1) the swing
 * widens toward +/-3 deg, and occasional wind gusts double the amplitude
 * for ~2 s every 30-60 s.
 *
 * The PointLight bound to a fixture hangs from the same mount point, so its
 * position is re-derived each frame from the rotated hang offset - the glow
 * tracks the swing instead of floating static in mid-air.
 *
 * NOTE (integration order): LightingRig.update() stamps pool-light
 * positions absolutely every frame. Call FixtureSway.update() AFTER
 * lighting.update() in the frame loop so the sway offset wins.
 */

import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { PointLight } from '@babylonjs/core/Lights/pointLight';

/** Rest swing frequency in Hz (~2.5 s per full period). */
const FREQ_HZ = 0.4;
/** Base swing half-amplitude in radians (+/-1.5 deg). */
const BASE_AMP = (1.5 * Math.PI) / 180;
/** Extra swing at full director tension: total becomes +/-3 deg. */
const TENSION_AMP = (1.5 * Math.PI) / 180;
/** Wind gust multiplies the current amplitude by this factor. */
export const GUST_MULT = 2;
/** Wind gust duration in seconds. */
export const GUST_DUR = 2;
/** Gust scheduling window in seconds (uniform inside). */
export const GUST_MIN_IN = 30;
export const GUST_MAX_IN = 60;
/** Envelope attack/release time constant for gust ramps (seconds). */
const GUST_ENV_TAU = 0.35;

interface SwayEntry {
  node: TransformNode;
  light: PointLight | null;
  /** rotation.z captured at register time (fixtures may ship pre-tilted). */
  baseRotZ: number;
  /** node position at register time = the hang/mount point. */
  mount: Vector3;
  /** light position minus mount point at register time (hang arm vector). */
  lightOffset: Vector3 | null;
  /** per-fixture phase offset so fixtures never swing in lockstep. */
  phase: number;
  /** slight per-fixture frequency jitter (still ~0.4 Hz). */
  freqHz: number;
  /** last observed direction of motion; used to detect reversals. */
  dirSign: number;
}

/**
 * Drives pendulum sway for every registered hanging fixture.
 * Register each fixture mesh (and optionally its PointLight), then call
 * update(dt, tension) once per frame after LightingRig.update().
 */
export class FixtureSway {
  private entries = new Map<TransformNode, SwayEntry>();
  /** Sway clock in seconds, advanced by update(). */
  private t = 0;
  /** Seconds until the next wind gust. */
  private gustCountdown = GUST_MIN_IN + Math.random() * (GUST_MAX_IN - GUST_MIN_IN);
  /** Seconds left in the active gust (0 = none). */
  private gustLeft = 0;
  /** Smoothed gust multiplier, eases between 1 and GUST_MULT. */
  private gustEnv = 1;

  /**
   * Chain-creak audio hook: fired whenever a fixture's swing reverses
   * direction (the pendulum peaks and the chain load flips). Receives the
   * swaying node so positional audio can pan to it.
   */
  onSwayPeak: ((node: TransformNode) => void) | null = null;

  /** True while a wind gust is boosting amplitude. */
  get gustActive(): boolean {
    return this.gustLeft > 0;
  }

  /** Number of registered fixtures. */
  get count(): number {
    return this.entries.size;
  }

  /**
   * Start swaying a hanging fixture. `light` is the pooled PointLight that

(Showing lines 1-90 of 200. Use offset=91 to continue.)

