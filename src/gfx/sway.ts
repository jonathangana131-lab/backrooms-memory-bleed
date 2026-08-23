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
  /** previous frame's swing angle, for reversal detection. */
  prevAngle: number;
  /** light world position at register time; restored on unregister. */
  lightRest: { x: number; y: number; z: number } | null;
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


  /**
   * Start swaying a hanging fixture. `light` is the pooled PointLight that
   * hangs from the same mount (pass null/omit for headless fixtures). The
   * mount point and hang-arm vector are captured now; later frames only
   * re-derive positions from them.
   */
  register(node: TransformNode, light?: PointLight | null): void {
    const existing = this.entries.get(node);
    if (existing) {
      // Duplicate register: keep phase/mount state, refresh light binding.
      existing.light = light ?? null;
      existing.lightOffset = light
        ? new Vector3(
            light.position.x - existing.mount.x,
            light.position.y - existing.mount.y,
            light.position.z - existing.mount.z,
          )
        : null;
      if (light) {
        existing.lightRest = { x: light.position.x, y: light.position.y, z: light.position.z };
      }
      return;
    }
    const pos = node.position;
    const entry: SwayEntry = {
      node,
      light: light ?? null,
      baseRotZ: node.rotation.z,
      mount: new Vector3(pos.x, pos.y, pos.z),
      lightOffset: null,
      // Golden-angle phase spread desynchronises fixtures deterministically
      // by registration order without touching simulation RNG streams.
      phase: this.entries.size * 2.399963229728653,
      // Inline integer hash (this module stays free of runtime rng imports).
      freqHz: FREQ_HZ *
        (0.94 + 0.12 * (((Math.imul(this.entries.size * 0x9e37 + 1, 0x85ebca6b) >>> 20) % 1000) / 1000)),
      dirSign: 0,
      prevAngle: 0,
      lightRest: null,
    };
    if (light) {
      entry.lightOffset = new Vector3(
        light.position.x - pos.x,
        light.position.y - pos.y,
        light.position.z - pos.z,
      );
      entry.lightRest = { x: light.position.x, y: light.position.y, z: light.position.z };
    }
    this.entries.set(node, entry);
  }

  /**
   * Stop swaying a fixture. Any bound light is snapped back to its rest
   * position exactly as captured at register time.
   */
  unregister(node: TransformNode): void {
    const e = this.entries.get(node);
    if (!e) return;
    if (e.light && e.lightRest) {
      e.light.position.x = e.lightRest.x;
      e.light.position.y = e.lightRest.y;
      e.light.position.z = e.lightRest.z;
    }
    this.entries.delete(node);
  }

  /** Unregister every fixture (restoring bound lights). */
  clear(): void {
    for (const node of [...this.entries.keys()]) this.unregister(node);
  }

  /** Force a wind gust now (also re-arms the scheduler window). */
  triggerGust(): void {
    this.gustLeft = GUST_DUR;
    this.gustCountdown = GUST_MIN_IN + Math.random() * (GUST_MAX_IN - GUST_MIN_IN);
  }

  /**
   * Advance the sway clock one frame and write rotations/light positions.
   *
   * @param dt       frame delta in seconds (clamped; giant frames survive)
   * @param tension  director tension 0..1 widening the swing toward +/-3 deg
   */
  update(dt: number, tension: number): void {
    const step = Math.min(dt, 0.1);
    this.t += step;

    // Gust lifecycle: active burst drains, otherwise the scheduler counts
    // down to the next gust inside its 30-60 s window.
    if (this.gustLeft > 0) {
      this.gustLeft = Math.max(0, this.gustLeft - step);
    } else {
      this.gustCountdown -= step;
      if (this.gustCountdown <= 0) this.triggerGust();
    }

    // Smoothed envelope eases amplitude between baseline and GUST_MULT.
    const targetEnv = this.gustLeft > 0 ? GUST_MULT : 1;
    this.gustEnv += (targetEnv - this.gustEnv) * (1 - Math.exp(-step / GUST_ENV_TAU));

    const amp = (BASE_AMP + TENSION_AMP * tension) * this.gustEnv;
    const TWO_PI = Math.PI * 2;
    for (const e of this.entries.values()) {
      const angle = amp * Math.sin(TWO_PI * e.freqHz * this.t + e.phase);
      const delta = angle - e.prevAngle;
      // Fire the chain-creak hook exactly when motion reverses direction
      // (the pendulum peaks/troughs and the chain load flips).
      if (e.dirSign !== 0 && delta !== 0 && Math.sign(delta) !== e.dirSign && this.onSwayPeak) {
        this.onSwayPeak(e.node);
      }
      if (delta !== 0) {
        e.dirSign = Math.sign(delta);
        e.prevAngle = angle;
      }

      e.node.rotation.z = e.baseRotZ + angle;

      // The light hangs from the mount through the arm vector; rotating the
      // pendulum by `angle` around Z swings the arm with it (length kept).
      if (e.light && e.lightOffset) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        e.light.position.x = e.mount.x + e.lightOffset.x * cos - e.lightOffset.y * sin;
        e.light.position.y = e.mount.y + e.lightOffset.x * sin + e.lightOffset.y * cos;
        e.light.position.z = e.mount.z + e.lightOffset.z;
      }
    }
  }
}
