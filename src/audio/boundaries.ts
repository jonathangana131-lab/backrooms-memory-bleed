/**
 * Chunk-boundary crossing cues for BACKROOMS: MEMORY BLEED.
 *
 * Stepping across a chunk seam should feel like the air itself changing,
 * not like an event horn. Fully procedural, no asset files:
 *
 *   WHOOSH    bandpass-filtered noise swept down 300 -> 100 Hz over
 *             250 ms at volume 0.02 — a breath of displaced air.
 *   ACCENTS   crossing INTO STORAGE adds a faint metallic ring overtone
 *             (hoarded metal settling), INTO HONEYCOMB a hollow tonal
 *             pulse (empty hexagonal cells answering back).
 *   PACING    never more than one cue per 4 s, and none at all while
 *             the director is in its peak phase — too much is already
 *             happening for a whisper of air to register.
 */

/** District.STORAGE ordinal in world/constants.ts (kept numeric so the
 *  const enum stays out of the runtime path). */
const DISTRICT_STORAGE = 4;
/** District.HONEYCOMB ordinal in world/constants.ts. */
const DISTRICT_HONEYCOMB = 2;

/** Minimum seconds between crossing cues. */
const COOLDOWN_SECONDS = 4;

export class BoundaryCue {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;

  /** Seconds until another cue may fire; drained by update(). */
  private cooldown = 0;
  /** Director phase name from the most recent update(); 'peak' mutes everything. */
  private phase = 'calm';
  /** Shared white-noise buffer, built lazily on first cue. */
  private noiseBuf: AudioBuffer | null = null;

  // ---- test hooks ----
  private whooshCount = 0;
  private accentCount = 0;
  private lastAccentDistrict = -1;

(Showing lines 1-40 of 177. Use offset=41 to continue.)

