/**
 * Wake cinematic run-start mount for BACKROOMS: MEMORY BLEED (F91).
 *
 * Headless driver that mounts the staged wake cinematic
 * (src/story/wakecinematic.ts) into a run start: it owns playback state and
 * emits one world-space camera pose per tick through an injected host, so a
 * renderer host can drive the real camera while this module stays free of
 * Babylon, DOM, and wall-clock dependencies — pure sim code, safe to unit
 * test in bare Node.
 *
 * Every emitted pose is a SPAWN-ANCHORED OFFSET around the bed anchor passed
 * to the constructor: camera x/z stay within POSE_BOUNDS.positionXZ (+/-1.2)
 * of the anchor on both axes, y within [positionYMin, positionYMax], the
 * look-at target within its own bounds likewise offset by the anchor.
 *
 * Determinism law compliance: all sequencing comes from stageWakeCinematic's
 * seeded RNG; this module performs no PRNG calls, no wall-clock reads, and no
 * frame-time sources of its own — time enters only through the injected
 * tick(dtMs) deltas.
 */

import {
  POSE_BOUNDS,
  WakeCinematicPlayer,
  stageWakeCinematic,
} from './wakecinematic';
import type { WakeCameraPose, WakeStaging } from './wakecinematic';

// ---------------------------------------------------------------------------
// Host contract
// ---------------------------------------------------------------------------

/** World-space camera pose for one frame of the sequence (spawn-anchored). */
export interface WakePose {
  /** Camera position x, anchor-relative plus anchorX. */
  px: number;
  /** Camera position y (absolute; bed-head height band). */
  py: number;
  /** Camera position z, anchor-relative plus anchorZ. */
  pz: number;
  /** Look-at target x, anchored like px. */
  tx: number;
  /** Look-at target y (absolute). */
  ty: number;
  /** Look-at target z, anchored like pz. */
  tz: number;
  /** Vertical FOV in degrees. */
  fovDeg: number;
}

/** Injection point through which the mount drives a renderer's camera. */
export interface WakeMountHost {
  /** Apply this frame's pose to the render camera. */
  applyPose(pose: WakePose): void;
  /**
   * Called exactly once when the sequence finishes naturally or is ended by
   * skip(); never called after abort().
   */
  onFinish(): void;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Playback owner for one run's wake cinematic: stages the sequence from the
 * run seed, advances it with injected deltas, and hands spawn-anchored camera
 * poses to the injected host until the staging's totalMs is consumed, the
 * player skips, or the caller aborts.
 */
export class WakeMount {
  private readonly staging: WakeStaging;

  private readonly player: WakeCinematicPlayer;

  private readonly anchorX: number;

  private readonly anchorZ: number;

  private readonly host: WakeMountHost;

  /** True until natural finish, skip-end, or abort; never true again. */
  private playingNow = true;

  /** Double-finish guard: onFinish must fire at most once per instance. */
  private finishNotified = false;

  /**
   * @param seed Run seed; junk seeds are canonicalized inside
   *   stageWakeCinematic.
   * @param anchorX World x of the bed anchor every pose is offset around.
   * @param anchorZ World z of the bed anchor every pose is offset around.
   * @param host Renderer injection point receiving poses and the finish
   *   callback.
   */
  constructor(seed: number, anchorX: number, anchorZ: number, host: WakeMountHost) {
    this.anchorX = anchorX;
    this.anchorZ = anchorZ;
    this.host = host;
    this.staging = stageWakeCinematic(seed);
    this.player = new WakeCinematicPlayer(this.staging);
  }

  /** True while the sequence is still driving the camera. */
  get playing(): boolean {
    return this.playingNow;
  }

  /**
   * Advance playback by an injected frame delta and emit this frame's pose.
   * The pose is applied even on the finishing tick — apply THEN finish — so
   * the closing framing is on screen before control returns to gameplay.
   *
   * @param dtMs Frame delta in ms; non-finite or negative values are ignored.
   */
  tick(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs < 0) return;
    if (!this.playingNow) return;
    this.player.update(dtMs);
    const shot = this.player.activeShot;
    this.host.applyPose(this.buildPose(shot.pose));
    if (this.player.remainingMs <= 0) {
      this.playingNow = false;
      this.notifyFinish();
    }
  }

  /**
   * Injected skip press: first press fast-forwards to the closing shot and
   * immediately shows its framing; second press (already on the last shot)
   * ends the sequence. Two presses always end it.
   */
  skip(): void {
    if (!this.playingNow) return;
    if (this.player.activeIndex < this.staging.shots.length - 1) {
      this.player.skip();
      this.host.applyPose(this.buildPose(this.player.activeShot.pose));
      return;
    }
    this.playingNow = false;
    this.notifyFinish();
  }

  /**
   * Silent teardown: stops playback without ever calling onFinish. Safe to
   * call repeatedly and after any other state.
   */
  abort(): void {
    this.playingNow = false;
  }

  /**
   * Fire onFinish exactly once per instance, however the sequence ends.
   */
  private notifyFinish(): void {
    if (this.finishNotified) return;
    this.finishNotified = true;
    this.host.onFinish();
  }

  /**
   * Anchor a staged shot pose into world space around the bed anchor.
   *
   * @param pose Staged shot pose (anchor-relative offsets inside POSE_BOUNDS).
   * @returns World-space pose with px/pz and tx/tz translated by the anchor.
   */
  private buildPose(pose: WakeCameraPose): WakePose {
    return {
      px: this.anchorX + pose.position[0],
      py: pose.position[1],
      pz: this.anchorZ + pose.position[2],
      tx: this.anchorX + pose.target[0],
      ty: pose.target[1],
      tz: this.anchorZ + pose.target[2],
      fovDeg: pose.fovDeg,
    };
  }
}
