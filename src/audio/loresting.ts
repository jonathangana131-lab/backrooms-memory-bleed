/**
 * Lore discovery stingers for BACKROOMS: MEMORY BLEED.
 *
 * Short procedural Web Audio motifs that reward narrative interaction —
 * reading a note, completing a memory cluster, locking a beacon radio.
 * No asset files; every sting is built from oscillators and envelopes.
 *
 *   noteRead       : soft two-note sine motif, A4 -> C5, 200 ms each,
 *                    gentle swell/release envelope (~400 ms total)
 *   clusterComplete: resolved three-note A-minor phrase
 *                    A4 - C5 - E5 - A5, 180 ms notes with a slight
 *                    overlap so the resolution blooms instead of plodding
 *   radioLock      : warm triangle-wave glissando sweeping 300 -> 600 Hz
 *                    over 250 ms — clearly distinct from the radio's
 *                    existing tuning ping
 *
 * Stage darkening: the story stage (0-4) closes a per-sting lowpass
 * from 8 kHz down to 3 kHz, so late-game discoveries sound more
 * muffled and heavy — the world is literally closing in on the audio.
 */

/** Highest story stage accepted by the darkening curve. */
export const MAX_STAGE = 4;

const DARK_OPEN_HZ = 8000;   // stage 0 cutoff
const DARK_CLOSED_HZ = 3000; // stage 4 cutoff

/**
 * Lowpass cutoff for a story stage: stage 0-4 maps 8000 -> 3000 Hz,
 * clamped outside that range so weird saves still behave.
 */
export function stageCutoff(stage: number): number {
  const s = Math.max(0, Math.min(MAX_STAGE, stage));
  return DARK_OPEN_HZ + ((DARK_CLOSED_HZ - DARK_OPEN_HZ) * s) / MAX_STAGE;
}

/** One scheduled oscillator voice inside a sting. */
interface ToneSpec {
  readonly type: OscillatorType;
  /** frequency in Hz */


