/**
 * Colorblind anomaly signals for BACKROOMS: MEMORY BLEED (F99).
 *
 * Anomaly overlays must never rely on hue alone. Every severity class is
 * paired with a DISTINCT geometric pattern and a DISTINCT pulse rhythm, so
 * a colorblind player can read anomaly class from shape and tempo:
 *
 *   info     -> stripes (slow drift)      at 0.5 Hz
 *   warning  -> checker (steady blink)    at 2 Hz
 *   critical -> rings   (urgent throb)    at 6 Hz
 *
 * The pulse rhythms are separated by at least MIN_PULSE_SEPARATION (2x)
 * pairwise, which is the testable accessibility floor for tempo-only
 * discrimination.
 *
 * The model is a pure gate over injected colorblind mode: when the mode is
 * OFF the function passes through null and the game's existing color cues
 * stand unchanged; when ON every colored cue receives its paired pattern
 * descriptor {patternId, pulseHz} for overlay consumers. There is no
 * Date.now(), no Math.random(), and no state: identical calls replay
 * byte-identical results.
 *
 * Junk-safe contract: any falsy junk mode (0, '', NaN, null, undefined)
 * reads as OFF and returns null without consulting severity. A truthy junk
 * mode with a valid severity still yields the proper descriptor. A
 * non-string severity fails loud; an unknown string severity yields null
 * rather than inventing a cue for an unclassified anomaly.
 */

// ---------------------------------------------------------------------------
// Signal model
// ---------------------------------------------------------------------------

/** Anomaly severity classes recognized by the signal language. */
export type SeverityClass = 'info' | 'warning' | 'critical';

/** Geometric overlay patterns, one per severity class. */
export type PatternId = 'stripes' | 'checker' | 'rings';

/** Overlay-consumer descriptor pairing a pattern with its pulse rhythm. */
export interface AnomalySignalDescriptor {
  /** Geometric pattern drawn over the colored cue. */
  readonly patternId: PatternId;
  /** Pulse rhythm of the overlay, in hertz. */
  readonly pulseHz: number;
}

/**
 * Minimum pairwise separation between the three pulse rhythms, as a ratio.
 * Any two classes differ in tempo by at least this factor.
 */
export const MIN_PULSE_SEPARATION = 2;

/**
 * The full signal table: exactly one distinct (patternId, pulseHz) pair per
 * severity class. Frozen; consumers must not mutate it.
 */
export const SIGNAL_TABLE: Readonly<
  Record<SeverityClass, Readonly<AnomalySignalDescriptor>>
> = Object.freeze({
  info: Object.freeze({ patternId: 'stripes', pulseHz: 0.5 }),
  warning: Object.freeze({ patternId: 'checker', pulseHz: 2 }),
  critical: Object.freeze({ patternId: 'rings', pulseHz: 6 }),
});

/** All severity classes covered by the table, table order. */
export const SEVERITY_CLASSES: readonly SeverityClass[] = Object.freeze([
  'info',
  'warning',
  'critical',
]);

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Paired pattern/rhythm descriptor for one anomaly severity class.
 *
 * @param colorblindMode Injected accessibility toggle; any truthy value
 *   enables the pattern language, any falsy value keeps color-only cues.
 * @param severity Anomaly severity class to describe.
 * @returns The frozen descriptor from SIGNAL_TABLE when colorblind mode is
 *   on and the class is known; null when mode is off or the severity string
 *   is not a classified class (existing color cues stand alone).
 * @throws When severity is not a string while colorblind mode is on.
 */
export function anomalySignal(
  colorblindMode: unknown,
  severity: string,
): Readonly<AnomalySignalDescriptor> | null {
  if (!colorblindMode) return null;
  if (typeof severity !== 'string') {
    throw new Error('anomaly signal needs a string severity class');
  }
  return isSeverityClass(severity) ? SIGNAL_TABLE[severity] : null;
}

/**
 * Type guard for externally sourced severity strings.

 * @param value Candidate value.
 * @returns True when value is one of the three classified severity classes.
 */
export function isSeverityClass(value: unknown): value is SeverityClass {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SIGNAL_TABLE, value)
  );
}
