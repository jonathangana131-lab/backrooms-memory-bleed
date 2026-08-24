/**
 * Vault/mantle crates (F13): pressing jump while holding forward against a
 * waist-high obstacle runs a short choreographed traversal — a C1-continuous
 * camera dip (down-up, total <= VAULT_DURATION = 0.55 s) plus a body lift that
 * carries the player over the obstacle and back down onto the far floor.
 *
 * Geometry contract (what makes the no-clip guarantee hold):
 *  - horizontal progress follows smoothstep(p / 0.9) * VAULT_DISTANCE, so the
 *    body barely moves while the lift ramps;
 *  - the lift reaches obstacle top + VAULT_CLEARANCE by p = 0.12, holds a
 *    plateau to p = 0.78, then eases back to the floor by p = 1; with the
 *    default reach/distance constants the circle is above obstacle-top height
 *    for the entire window in which its planar footprint overlaps a vaultable
 *    crate (verified per-frame in test/vault-test.mjs against a box fixture).
 *
 * Pure state machine - no Babylon deps. The world is an injected height
 * query; movement deltas are returned in world space so the caller decides
 * how they interact with moveCircle (vaulted props must be excluded from the
 * collider list during the crossing frames).
 */

/** Total choreography time (s); hard requirement is <= 0.6 s end-to-end. */
export const VAULT_DURATION = 0.55;
/** Camera dip depth at mid-vault (metres, applied downward). */
export const VAULT_DIP_DEPTH = 0.18;
/** Vertical clearance kept above the obstacle top while crossing (m). */
export const VAULT_CLEARANCE = 0.12;
/** Planar distance (m) covered start -> landing spot past the crate. */
export const VAULT_DISTANCE = 1.6;
/** Obstacles lower than this are stepped over, not vaulted (m). */
export const VAULT_MIN_TOP = 0.3;
/** Obstacles higher than this cannot be vaulted (waist-high ceiling, m). */
export const VAULT_MAX_TOP = 1.05;
/** Cooldown (s) after landing before another vault may start. */
export const VAULT_COOLDOWN = 0.25;

/** Height query consumed via injection (world/collision-style field). */
export interface VaultWorld {
  /**
   * Top surface height of the highest solid obstacle overlapping the point.
   * @param x World x to probe.
   * @param z World z to probe.
   * @returns Height in metres; 0 means only floor at this point.
   */
  obstacleTop(x: number, z: number): number;
}

export interface VaultTriggerInput {
  /** Forward movement key is held. */
  forward: boolean;
  /** Jump was pressed this frame (consumed edge, not a held state). */
  jumpPressed: boolean;
  /** Player yaw (radians); Babylon convention forward = (-sin, 0, -cos). */
  yaw: number;
  /** Player body x. */
  x: number;
  /** Player body z. */
  z: number;
}

/** Per-frame vault output; all fields are zero/no-op when idle. */
export interface VaultFrame {
  /** True while the traversal choreography is running. */
  active: boolean;
  /** World-space planar delta to apply to the body THIS frame (metres). */
  dx: number;
  dz: number;
  /** Body/eye lift above the floor (metres) for this frame. */
  eyeLift: number;
  /** Camera dip offset (metres, negative = below rest pose) for this frame. */
  camDip: number;
}

function smoothstep01(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return t * t * (3 - 2 * t);
}

/** Normalised horizontal progress s(p) in [0, 1] of VAULT_DISTANCE. */
function horizontalProgress(p: number): number {
  return smoothstep01(Math.min(1, p / 0.9));
}

/** Normalised body-lift profile y(p) in [0, 1]: rise [0,0.12], plateau, fall [0.78,1]. */
function liftProfile(p: number): number {
  if (p < 0.12) return smoothstep01(p / 0.12);
  if (p <= 0.78) return 1;
  return smoothstep01((1 - p) / 0.22);
}

/**
 * Trigger scan + traversal clock for crate vaults.
 */
export class VaultController {
  /** True while a vault traversal is running. */
  active = false;
  private p = 0;                 // normalised progress in [0, 1]
  private top = 0;               // locked obstacle height at trigger
  private dirX = 0;              // locked forward direction (unit)
  private dirZ = 0;
  private prevS = 0;             // previous-frame horizontal progress
  private cooldownLeft = 0;

  /**
   * Probe ahead of the player for a vaultable obstacle.
   * @returns The obstacle top height when a vault may start here, else -1.
   */
  probe(input: VaultTriggerInput, world: VaultWorld): number {
    if (!input.forward || !input.jumpPressed) return -1;
    const fx = -Math.sin(input.yaw), fz = -Math.cos(input.yaw);
    let bestTop = -1;
    // sample the approach corridor for the highest vaultable surface
    for (const d of [0.5, 0.75, 1.0]) {
      const t = world.obstacleTop(input.x + fx * d, input.z + fz * d);
      if (t >= VAULT_MIN_TOP && t <= VAULT_MAX_TOP && t > bestTop) bestTop = t;
    }
    if (bestTop < 0) return -1;
    // the landing spot past the obstacle must be clear floor
    const lx = input.x + fx * VAULT_DISTANCE, lz = input.z + fz * VAULT_DISTANCE;
    if (world.obstacleTop(lx, lz) > 0.05) return -1;
    return bestTop;
  }

  /**
   * Advance trigger + traversal one frame.
   * @param dt Frame time in seconds.
   * @param input Key/pose state for this frame (ignored while mid-vault).
   * @param world Injected height query used only on the trigger frame.
   * @returns The camera dip / translation output for this frame.
   */
  update(dt: number, input: VaultTriggerInput, world: VaultWorld): VaultFrame {
    this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);

    if (!this.active) {
      const top = this.probe(input, world);
      if (top >= 0 && this.cooldownLeft <= 0) {
        this.active = true;
        this.top = top;
        this.p = 0;
        this.prevS = 0;
        this.dirX = -Math.sin(input.yaw);
        this.dirZ = -Math.cos(input.yaw);
      }
      return { active: false, dx: 0, dz: 0, eyeLift: 0, camDip: 0 };
    }

    this.p += Math.max(0, Math.min(0.25, dt)) / VAULT_DURATION;
    const done = this.p >= 1;
    const pNow = Math.min(1, this.p);

    const s = horizontalProgress(pNow);
    const ds = s - this.prevS;
    this.prevS = s;
    const frame: VaultFrame = {
      active: !done,
      dx: this.dirX * ds * VAULT_DISTANCE,
      dz: this.dirZ * ds * VAULT_DISTANCE,
      eyeLift: (this.top + VAULT_CLEARANCE) * liftProfile(pNow),
      camDip: -VAULT_DIP_DEPTH * Math.sin(Math.PI * pNow) ** 2,
    };
    if (done) {
      this.active = false;
      this.cooldownLeft = VAULT_COOLDOWN;
    }
    return frame;
  }
}
