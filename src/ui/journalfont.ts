/**
 * Evolving journal font for BACKROOMS: MEMORY BLEED (F96).
 *
 * The player's handwritten journal degrades as the run worsens: deeper
 * anomaly stages and lower sanity make the hand less steady. A single
 * degradation index folds both injected inputs together,
 *
 *   index = clamp(stage * 0.2 + (1 - sanity) * 0.3, 0, 1)
 *
 * with stage in [0, 4] and sanity in [0, 1]. The index maps onto a render
 * font descriptor {slantDeg, jitterAmpPx, strokeWeight, glyphBreakProbability}
 * whose fields worsen monotonically with the index and hit exact healthy
 * defaults at index 0.
 *
 * Individual journal entries carry seeded variation of at most +/-10% on the
 * degradation amount (the effective index is scaled by a draw in
 * [0.9, 1.1]), so one page's handwriting wobbles against the next without
 * ever looking healthier than the rest state. Draws come from
 * src/core/rng.ts keyed by (entryId, index); there is no Date.now() and no
 * Math.random() anywhere in this module.
 *
 * Junk inputs never throw from the numeric paths: non-finite stage collapses
 * to 0, non-finite sanity to 1 (both are the rest state), and out-of-range
 * values clamp. Only a non-string entryId fails loud.
 */

import { RNG, seedFromString } from '../core/rng';

// ---------------------------------------------------------------------------
// Descriptor model
// ---------------------------------------------------------------------------

/** Render-facing description of the journal handwriting at one moment. */
export interface JournalFontState {
  /** Italic slant away from vertical, in degrees. */
  slantDeg: number;
  /** Peak positional wobble of a glyph from its baseline cell, in pixels. */
  jitterAmpPx: number;
  /** Stroke thickness multiplier; 1 is the healthy pen pressure. */
  strokeWeight: number;
  /** Probability that any single glyph renders as a broken scrawl. */
  glyphBreakProbability: number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Slant at full degradation, in degrees. */
export const FONT_SLANT_MAX_DEG = 14;

/** Jitter amplitude at full degradation, in pixels. */
export const FONT_JITTER_MAX_PX = 3;

/** Stroke-weight multiplier at full degradation. */
export const FONT_STROKE_MAX_WEIGHT = 2.4;

/** Glyph-break probability at full degradation. */
export const FONT_BREAK_MAX_PROBABILITY = 0.35;

/**
 * Half-width of the per-entry seeded variation band: the effective index is
 * the true index scaled by a draw in [1 - ENTRY_VARIATION, 1 + ENTRY_VARIATION].
 */
export const ENTRY_VARIATION = 0.1;

/** Exact healthy handwriting: the descriptor at index 0. */
export const REST_FONT: Readonly<JournalFontState> = Object.freeze({
  slantDeg: 0,
  jitterAmpPx: 0,
  strokeWeight: 1,
  glyphBreakProbability: 0,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Fold injected stage and sanity into one degradation index.

 * @param stage Anomaly stage, expected 0..4; clamped, non-finite reads as 0.
 * @param sanity Sanity, expected 0..1; clamped, non-finite reads as 1.
 * @returns Degradation index in [0, 1]: 0 at rest, 1 fully degraded.
 */
export function degradationIndex(stage: number, sanity: number): number {
  const s = Number.isFinite(stage) ? Math.min(4, Math.max(0, stage)) : 0;
  const q = Number.isFinite(sanity) ? Math.min(1, Math.max(0, sanity)) : 1;
  return Math.min(1, Math.max(0, s * 0.2 + (1 - q) * 0.3));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Font descriptor for a degradation index. Every field is a linear ramp
 * from its healthy default (index 0) to its tunable maximum (index 1), so
 * worsening is monotone by construction.

 * @param index Degradation index in [0, 1]; junk clamps to 0.
 * @returns The descriptor; contains only finite values.
 */
export function journalFont(index: number): JournalFontState {
  const i = clamp01(index);
  return {
    slantDeg: FONT_SLANT_MAX_DEG * i,
    jitterAmpPx: FONT_JITTER_MAX_PX * i,
    strokeWeight: 1 + (FONT_STROKE_MAX_WEIGHT - 1) * i,
    glyphBreakProbability: FONT_BREAK_MAX_PROBABILITY * i,
  };
}

/**
 * Font descriptor for one journal entry: the shared index plus seeded
 * per-entry variation. The entry's draw scales the degradation amount by
 * up to +/-10%, so an entry never renders healthier than the rest state
 * and never exceeds the full-degradation descriptor.

 * @param index Degradation index in [0, 1]; junk clamps to 0.
 * @param entryId Stable per-entry identity (e.g. note id) seeding the draw.
 * @returns The descriptor; deterministic per (entryId, index).
 * @throws When entryId is missing or not a string.
 */
export function entryJournalFont(index: number, entryId: string): JournalFontState {
  if (typeof entryId !== 'string' || entryId === '') {
    throw new Error('journal entry needs a non-empty string entryId');
  }
  const i = clamp01(index);
  const rng = new RNG((seedFromString(entryId) ^ Math.round(i * 4096)) >>> 0 || 0x9e3779b9);
  const factor = 1 - ENTRY_VARIATION + rng.next() * 2 * ENTRY_VARIATION;
  return journalFont(i * factor);
}
