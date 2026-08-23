/**
 * Watcher approach footsteps for BACKROOMS: MEMORY BLEED.
 *
 * The watchers walk when you walk. Their footsteps are synced to your own
 * step cadence but offset by half a stride - mirror-steps - so what you
 * hear interleaves with your own feet and reads as an echo that shouldn't
 * be there. Everything about them is designed to be denied, then dreaded:
 *
 *   SYNC      they step at your rate, offset half a stride (you stop,
             they are mid-stride)
 *   SURFACE   each step uses the floor THEY stand on - a metallic ring
 *             means they are in the storage corridor, whatever you're on
 *   REALIZE   when you stop they take exactly two more steps, then
 *             silence. That gap is where the horror lives
 *   ENVELOPE  imperceptible far away, swelling as they close, and cut to
 *             dead silence inside 3 m - the hush right before contact
 *
 * Fully procedural Web Audio: filtered white-noise bursts following the
 * surfaces.ts conventions (carpet thud / tile click / metal ring /
 * splash slosh), pitched down and darkened so they never quite sound
 * like YOUR footsteps. No asset files.
 *
 * The AudioContext is optional at construction; without one the class
 * runs logic-only (step clock, trailing count, distance envelope) and
 * records what it would have played in 'fired' - which is how the
 * headless test exercises it.
 */

export type SurfaceKind = 'carpet' | 'tile' | 'metal' | 'splash';

const SURFACES: readonly string[] = ['carpet', 'tile', 'metal', 'splash'];

/** Walking cadence in seconds per step (the player's nominal stride). */
export const STEP_INTERVAL = 0.52;

/** Mirror-steps land halfway between the player's steps. */
export const MIRROR_OFFSET = STEP_INTERVAL / 2;

/** Steps the watcher takes after the player stops before going quiet. */
export const TRAIL_STEPS = 2;


