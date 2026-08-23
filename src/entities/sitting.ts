/**
 * Sitting behavior.
 *
 * Sometimes a reconstructed human remembers benches. It walks to one,
 * turns to face the way the bench faces, and lowers itself to seated
 * height -- then sits for a minute or two, facing whatever pews face,
 * which is nothing. Believers feel this pull strongest near CHAPEL pews.
 *
 * Pure simulation logic: no Babylon imports. One SittingBehavior drives
 * one figure; update() consumes a timestep plus the figure's current
 * pose and returns whether it is sitting and where it should move.
 *
 * Seat claims live in a module-level registry so two figures can never
 * be steered onto the same bench, even across independent behavior
 * instances. Claims expire if their owner stops updating them.
 */
import { RNG } from '../core/rng';

/** A sittable spot on a bench/chair prop, fed in via setSeats(). */
export interface SeatPose {
  x: number;
  z: number;
  /** Direction the seat faces (radians). Figures align to this. */
  yaw: number;
  /** Tagged true for CHAPEL pews; believers strongly prefer these. */
  chapel?: boolean;
}

/** Minimal figure pose the behavior needs each tick. */
export interface SittingFigureState {
  x: number;
  z: number;
  yaw: number;
  /** Archetype name; 'believer' unlocks the CHAPEL preference. */
  type?: string;
}

/** What the caller should do with the figure this tick. */
export interface SittingResult {
  /** True from the moment the figure starts settling into the seat. */


