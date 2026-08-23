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

(Showing lines 1-40 of 140. Use offset=41 to continue.)

