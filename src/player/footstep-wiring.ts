/**
 * Footstep wiring - BACKROOMS: MEMORY BLEED.
 *
 * Bridges the player controller and the footsteps synth: every footfall
 * reported at world position (x, z) is resolved to a floor material by
 * the SurfaceDetector (district base surface + puddle splash override,
 * with travel hysteresis) and played on the SurfaceFootsteps synth.
 *
 * The adapter also rate-limits calls so a chatty game loop cannot
 * machine-gun the synth: steps closer together than MIN_STEP_GAP_MS are
 * dropped no matter what.
 *
 * NOTE (integration plan R-2): game.ts currently wires its inline
 * detector + synth pair; this module is the extracted form kept
 * behavior-compatible with that wiring.
 */
import { SurfaceFootsteps } from '../audio/surfaces';
import type { SurfaceDetector } from './surfacedetect';
import type { SurfaceKind } from './surfacedetect';

/** Absolute dedup floor: never emit two steps within 150 ms. */
const MIN_STEP_GAP_MS = 150;

export class FootstepWiring {
  private readonly detector: SurfaceDetector;
  private readonly footsteps: SurfaceFootsteps;

  /** Timestamp (ms, monotonic host clock) of the last emitted step. */
  private lastStepMs = -Infinity;

  constructor(detector: SurfaceDetector, footsteps: SurfaceFootsteps) {
    this.detector = detector;
    this.footsteps = footsteps;
  }

  /**
   * Report one footfall at world position (x, z) in `district`. Detects
   * the surface underfoot and plays it on the footsteps synth with the
   * sprint modifier applied.
   *
   * @returns true when a step was played; false when it was deduped away
   *          as too soon after the previous emitted step.
   */
  onStep(x: number, z: number, district: number, sprinting = false): boolean {
    const nowMs = this.nowMs();
    if (nowMs - this.lastStepMs < MIN_STEP_GAP_MS) return false;

    const surface: SurfaceKind = this.detector.detect(x, z, district);
    this.footsteps.play(surface, sprinting);
    this.lastStepMs = nowMs;

    return true;
  }

  /**
   * Time source. Uses the monotonic host clock; Date.now is only a
   * fallback for environments without performance (not a randomness or
   * simulation-time source).
   */
  private nowMs(): number {
    return typeof performance !== 'undefined'
      ? performance.now()
      : Date.now();
  }
}
