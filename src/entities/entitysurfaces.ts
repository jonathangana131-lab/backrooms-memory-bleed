/**
 * Entity footstep surface + pitch mapping.
 *
 * Entities share the player's surface model (see
 * src/player/surfacedetect.ts): a district number maps to a base
 * surface ('carpet' | 'tile' | 'metal') and proximity to a registered
 * puddle overrides it with 'splash'.
 *
 * Unlike the player detector, entity lookups are stateless per call —
 * many entities sample positions independently, so there is no shared
 * hysteresis state machine to corrupt. The splash override is already
 * immediate in the player model, and district transitions resolve on
 * the next step for a walking entity, which is perceptually identical.
 *
 * Each archetype gets a fixed playback-rate modifier so its footsteps
 * read as a distinct body:
 *   watcher   0.85  - pitched down 15%, heavier tread
 *   wanderer  1.00  - normal human gait
 *   believer  1.05  - slightly up, lighter/quicker tread
 *   double    1.00  - copies the player exactly (player rate)
 *
 * Pitch modifiers are computed once per type and cached.
 */

import {
  DISTRICT_MAZE,
  DISTRICT_OPEN_OFFICE,
  DISTRICT_HONEYCOMB,
  DISTRICT_CORRIDOR_GRID,
  DISTRICT_STORAGE,
  PUDDLE_RADIUS,
  type SurfaceKind,
} from '../player/surfacedetect';

/** World-space point, matching the puddle registration format. */
export interface Point2 {
  x: number;
  z: number;
}

/** Default district -> surface mapping. Unknown districts fall back to carpet. */
const DISTRICT_SURFACE: Record<number, 'carpet' | 'tile' | 'metal'> = {
  [DISTRICT_MAZE]: 'carpet',
  [DISTRICT_OPEN_OFFICE]: 'tile',
  [DISTRICT_HONEYCOMB]: 'tile',

(Showing lines 1-45 of 120. Use offset=46 to continue.)

