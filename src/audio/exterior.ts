/**
 * Exterior bleed for BACKROOMS: MEMORY BLEED.
 *
 * There is no outside. But sometimes you hear one through the walls:
 * fragments of a world that should not be adjacent to here, arriving
 * pre-muffled as if through half a metre of wet concrete. Fully
 * procedural, no assets:
 *
 *   BIRDSONG   2-4 chirp sweeps (sine 2-4 kHz with a fast vibrato),
 *              lowpassed at 1200 Hz so only their ghost survives.
 *              Every 45-120 s of calm; tension chases the birds away.
 *   TRAFFIC    a whoosh passing on some impossible road: looped noise
 *              through a bandpass that sweeps up and back down while a
 *              pan drifts across stereo - approach, pass, recede.
 *              Rare: every 3-7 min.
 *   CHILDREN   very rare high calls - formant-babble fragments pitched
 *              up like a voice heard from a yard two walls away, then
 *              crushed under an extra lowpass. Once per 10-15 min.
 *   RAIN       during wet weather fronts a continuous patter layer of
 *              dense filtered noise swells in; when the front dries out
 *              it fades away over seconds.
 *
 * Everything routes through per-voice muffle filters at quiet levels -
 * these sounds never belong to this place, they only leak in.
 */

const TWO_PI = Math.PI * 2;

/**
 * How much of the outside each memory zone lets through. Domestic and
 * schoolyard memories remember windows; offices and hospitals remember
 * none. Unknown kinds default to a faint leak.
 */
const BLEED_BY_ZONE: Record<number, number> = {
  0: 0.55, // NONE      - the pure backrooms admit almost nothing
  1: 1.0,  // RESIDENCE - a home remembers its garden
  2: 0.6,  // OFFICE    - sealed plate glass
  3: 0.5,  // HOSPITAL  - hermetic wings
  4: 0.95, // SCHOOL    - a playground over the fence
  5: 0.75, // MALL      - skylights somewhere


