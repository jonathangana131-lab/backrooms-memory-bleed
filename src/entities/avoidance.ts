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

/** Corrected velocity returned by steer(). */
export interface SteeredVelocity {
  vx: number;
  vz: number;
}

/**
 * One instance per figure. Holds the snapshot of nearby prop circles and
 * turns raw intent into intent-that-flows-around-furniture.
 */
export class PropAvoidance {
  /** Private copy: later mutation of the caller's array cannot leak in. */
  private obstacles: PropCircle[] = [];

  /**
   * Replace the working obstacle set.
   * @param props prop footprints near this entity (copied internally)
   */
  setObstacles(props: readonly PropCircle[]): void {
    this.obstacles = props.map((p) => ({ x: p.x, z: p.z, radius: p.radius }));
  }

  /**
   * Bend a desired velocity around the current obstacle snapshot.
   *
   * Obstacles outside CHECK_RANGE are ignored; obstacles whose influence
   * zone (radius + MARGIN) does not reach the entity change nothing. Each
   * contributing obstacle pushes perpendicular to the desired direction,
   * on the side away from its centre, weighted by how deep inside the
   * zone the entity stands; the summed push is capped at unit strength
   * and blended against the intent at the documented 60/40 weights. The
   * result is re-normalised to the intent's original speed, so steering
   * redirects without accelerating, and its forward component is clamped
   * positive so an entity never reverses travel.
   *
   * @param desiredVx intended velocity X (m/s)
   * @param desiredVz intended velocity Z (m/s)
   * @param x entity world X
   * @param z entity world Z
   * @returns corrected velocity of the same speed as the intent
   */
  steer(desiredVx: number, desiredVz: number, x: number, z: number): SteeredVelocity {
    const speed = Math.hypot(desiredVx, desiredVz);
    if (speed < 1e-9 || this.obstacles.length === 0) {
      return { vx: desiredVx, vz: desiredVz };
    }

    const rangeSq = CHECK_RANGE * CHECK_RANGE;
    let pushX = 0;
    let pushZ = 0;
    let influenced = false;

    for (const o of this.obstacles) {
      const dx = x - o.x;
      const dz = z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > rangeSq) continue; // pre-filter on squared distance

      const influence = o.radius + MARGIN;
      if (d2 >= influence * influence) continue; // zone not reached

      // Depth inside the influence zone: 0 at the rim .. 1 at the centre.
      const d = Math.sqrt(d2);
      const depth = 1 - d / influence;

      // Escape direction: mostly away from the prop centre, tilted toward
      // a fixed perpendicular of the intent so clustered props push the
      // figure consistently to one side instead of cancelling out.
      const ix = desiredVx / speed;
      const iz = desiredVz / speed;
      const invD = 1 / (d || 1);
      const radX = dx * invD;          // centre -> entity
      const radZ = dz * invD;
      let ex = radX + 0.75 * (-iz);
      let ez = radZ + 0.75 * (ix);
      const em = Math.hypot(ex, ez) || 1;
      ex /= em; ez /= em;
      pushX += ex * depth;
      pushZ += ez * depth;
      influenced = true;
    }

    if (!influenced) return { vx: desiredVx, vz: desiredVz };

    // Cap the summed push at unit strength so stacked props cannot fling.
    const pm = Math.hypot(pushX, pushZ);
    if (pm > 1) { pushX /= pm; pushZ /= pm; }

    // 60/40 blend in velocity space, then restore the intent's speed.
    // Pushes are strictly perpendicular to the intent, so the blended
    // forward component is always WEIGHT_DESIRED * speed >= 0: steering
    // can slow lateral progress but never reverse travel.
    let vx = WEIGHT_DESIRED * desiredVx + (1 - WEIGHT_DESIRED) * pushX * speed;
    let vz = WEIGHT_DESIRED * desiredVz + (1 - WEIGHT_DESIRED) * pushZ * speed;

    // Re-normalise to the intent's original speed.
    const outMag = Math.hypot(vx, vz);
    if (outMag < 1e-9) return { vx: desiredVx, vz: desiredVz };
    return { vx: (vx / outMag) * speed, vz: (vz / outMag) * speed };
  }
}
