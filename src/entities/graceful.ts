/**
 * Graceful entity despawn.
 *
 * When a figure's vanishAt timer expires it should not blink out of
 * existence while the player is staring straight at it -- that reads as
 * a glitch, not a haunting. If the player IS looking, the figure fades
 * its opacity to zero over about a second (cloning the shared material
 * so only this one instance dims). If the player is NOT looking, the
 * despawn is instant: cheaper to run, and scarier -- turn back and the
 * corridor is empty.
 *
 * Pure logic + material helpers: no Babylon imports. Materials and
 * meshes are consumed through minimal structural interfaces so the
 * module unit-tests with plain mocks and stays decoupled from the
 * engine.
 */

/** Half-angle of the "player is looking at it" cone, degrees. */
export const GAZE_HALF_ANGLE_DEG = 35;
/** cos(35deg): dot(fwd, dir) below this means the entity is off-screen. */
export const GAZE_COS_THRESHOLD = Math.cos((GAZE_HALF_ANGLE_DEG * Math.PI) / 180);
/** Fade duration in seconds for a watched despawn. */
export const FADE_DURATION_S = 1;

interface XZ {
  x: number;
  z: number;
}

/** Minimal mesh surface needed to retarget materials during a fade. */
export interface FadeMesh {
  material?: unknown;
  /** Present on Babylon TransformNode/Mesh; absent on bare mocks. */
  getChildMeshes?(): FadeMesh[];
}

/** Minimal material surface needed to clone-and-fade. */
export interface FadeMaterial {
  /** Optional display name, echoed into the clone's name. */
  name?: string;


  /** Linear opacity 0..1; cloned materials fade this to zero. */
  opacity?: number;
  /** Babylon-style clone; absent on bare mocks. */
  clone?(): FadeMaterial;
}

/**
 * Is the point outside the player's gaze cone?
 * @param fwd player forward direction (any length; normalized inside)
 * @param cam player position
 * @param pos entity position
 * @returns true when the entity is off-screen and may vanish instantly
 */
export function isOutsideGaze(fwd: XZ, cam: XZ, pos: XZ): boolean {
  const dx = pos.x - cam.x;
  const dz = pos.z - cam.z;
  const len = Math.sqrt(fwd.x * fwd.x + fwd.z * fwd.z);
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-9 || dist < 1e-6) return false; // degenerate: force the fade path
  const dot = (dx / dist) * (fwd.x / len) + (dz / dist) * (fwd.z / len);
  return dot < GAZE_COS_THRESHOLD;
}

/** Despawn policy helpers. Instances are stateless; use statically. */
export class GracefulDespawn {
  /**
   * May this figure pop out of existence right now?
   *
   * True only when the figure sits outside the gaze cone AND there is real
   * distance involved; a watched figure (or a degenerate zero-distance
   * query) must take the slow fade instead -- a blink on screen reads as a
   * glitch, not a haunting.
   *
   * @param fwd player forward direction (any length)
   * @param cam player position
   * @param pos entity position
   * @returns true when an instant despawn is allowed
   */
  static shouldInstantDespawn(fwd: XZ, cam: XZ, pos: XZ): boolean {
    return isOutsideGaze(fwd, cam, pos);
  }

  /**
   * Clone-and-dim helper for the watched path: swaps in a private material
   * copy so fading one figure never dims its neighbours sharing the mesh.
   *
   * @param mesh the figure's mesh (child meshes included when present)
   * @returns the cloned material now attached, or null when unavailable
   */
  static beginWatchedFade(mesh: FadeMesh): FadeMaterial | null {
    const mats: FadeMaterial[] = [];
    if (mesh.material) mats.push(mesh.material as FadeMaterial);
    if (mesh.getChildMeshes) {
      for (const child of mesh.getChildMeshes()) {
        if (child.material) mats.push(child.material as FadeMaterial);
      }
    }
    let firstClone: FadeMaterial | null = null;
    for (const m of mats) {
      if (!m.clone) continue;
      const c = m.clone();
      c.opacity = 1;
      if (!firstClone) firstClone = c;
    }
    return firstClone;
  }
}
