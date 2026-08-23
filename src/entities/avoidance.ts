/**
 * Entity prop avoidance steering.
 *
 * Entities should flow around furniture instead of ghosting through it.
 * The world feeds us nearby prop circles (setObstacles) whenever the
 * local room changes; steer() takes an entity's desired velocity and
 * returns a corrected one that bends around anything solid within a
 * small margin of its body.
 *
 * Pure simulation logic: no Babylon imports, no engine deps.
 *
 * Design notes:
 *  - Only obstacles within CHECK_RANGE metres are even considered; the
 *    pre-filter runs on squared distances so no sqrt happens until we
 *    already know a prop is close enough to matter.
 *  - Repulsion blends with the desired direction at a fixed 60/40
 *    weight, so entities keep most of their intent while sliding along
 *    prop edges rather than fighting them.
 *  - The blend can never fully reverse travel: after blending we clamp
 *    the component along the desired direction to stay forward-facing,
 *    so an entity squeezed against a table drifts sideways, not back.
 */

export interface PropCircle {
  /** World-space centre X of the prop footprint. */
  x: number;
  /** World-space centre Z of the prop footprint. */
  z: number;
  /** Radius of the prop footprint in metres. */
  radius: number;
}

/** Extra clearance kept between entity and prop edge (metres). */
const MARGIN = 0.3;

/** Obstacles farther than this are ignored outright (metres). */
const CHECK_RANGE = 8;

/** Weight of the desired direction in the steering blend. */
const WEIGHT_DESIRED = 0.6;


