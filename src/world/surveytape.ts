/**
 * F83 — The Surveyor's Tape: a found tape measure whose readings are
 * wrong in a lawfully distorted way — the wrongness IS the signal.
 *
 * Pure reading model (mounting lives in game.ts, not here). The host
 * injects the true distance d and the local anomaly density a ∈ [0,1];
 * every reading is
 *
 *   reading = d × (1 + distortion(a, seeded jitter))
 *
 * where distortion grows linearly with anomaly density, its magnitude is
 * jittered per sample over [0.5, 1.5) × max, and its SIGN flips per
 * sample by a seeded parity bit. Zero density yields exactly d — an
 * undistorted tape is a clean corridor.
 *
 * Inversion: because the jitter factor averages to 1 and the sign is
 * discarded by |·|, `anomalyEstimate` recovers the local anomaly density
 * from repeated (trueDistance, reading) pairs as
 * mean(|reading/d − 1|) / TAPE_DISTORTION_MAX, clamped to [0,1].
 *
 * Determinism: all jitter/parity draws are pure hash functions of
 * (seed, sampleIndex) via src/core/rng.ts — identical inputs ⇒ identical
 * readings, and a serialized/deserialized tape resumes its sequence at
 * the exact sample index it stopped at.
 */

import { hash2i, rand2 } from '../core/rng';

/**
 * Maximum fractional distortion at full anomaly density before jitter:
 * |distortion| ≤ TAPE_DISTORTION_MAX × a × 1.5 with jitter included.
 */
export const TAPE_DISTORTION_MAX = 0.35;

/** Salt separating the magnitude-jitter stream from other seed streams. */
const JITTER_SALT_U32 = 0x7a9e11da >>> 0;

/** Salt separating the sign-parity stream from other seed streams. */
const PARITY_SALT_U32 = 0xbadc0de5 >>> 0;

/**
 * Signed fractional distortion for one sample. Magnitude grows linearly
 * with density; sign flips by seeded parity of (seed, sampleIndex); the
 * jitter factor (0.5 + u), u ∈ [0,1), averages exactly 1 so repeated
 * readings invert cleanly.
 *
 * @param anomalyDensity Local anomaly density a, clamped to [0,1].
 * @param seed Tape seed.
 * @param sampleIndex Monotonic reading counter within one tape.
 * @returns Fractional distortion in [-1.5×TAPE_DISTORTION_MAX, +1.5×…].
 */
export function distortionAt(anomalyDensity: number, seed: number, sampleIndex: number): number {
    const a = Math.min(1, Math.max(0, anomalyDensity));
    if (a === 0) return 0;
    const j = rand2(seed, sampleIndex, JITTER_SALT_U32);
    const parity = hash2i(seed, sampleIndex, PARITY_SALT_U32);
    const sign = (parity & 1) === 0 ? 1 : -1;
    return sign * TAPE_DISTORTION_MAX * a * (0.5 + j);
}

/**
 * One tape measurement. At zero density this returns EXACTLY
 * trueDistance (the multiplication is skipped on the exact-zero path).
 *
 * @param trueDistance True distance in meters (finite).
 * @param anomalyDensity Local anomaly density a ∈ [0,1].
 * @param seed Tape seed.
 * @param sampleIndex Monotonic reading counter within one tape.
 * @returns The (wrongly measured) displayed distance in meters.
 */
export function tapeReading(
    trueDistance: number,
    anomalyDensity: number,
    seed: number,
    sampleIndex: number,
): number {
    if (!(trueDistance > 0)) return trueDistance;
    const dist = distortionAt(anomalyDensity, seed, sampleIndex);
    if (dist === 0) return trueDistance;
    return trueDistance * (1 + dist);
}

/** One observed sample pair fed to the density estimator. */
export interface TapeSample {
    /** Known true distance in meters (> 0 to be counted). */
    d: number;
    /** The tape's displayed distance for that same span. */
    reading: number;
}

/**
 * Estimate local anomaly density from repeated readings. Averages the
 * absolute fractional error over samples with d > 0 (sign-flip and
 * jitter make signed averaging useless; absolute values invert cleanly),
 * divides out the model maximum, clamps to [0,1]. No valid samples ⇒ 0.
 *
 * @param samples Observed (true distance, displayed distance) pairs.
 * @returns Estimated anomaly density â ∈ [0,1].
 */
export function anomalyEstimate(samples: readonly TapeSample[]): number {
    let sum = 0;
    let n = 0;
    for (const s of samples) {
        if (!(s.d > 0)) continue;
        sum += Math.abs(s.reading / s.d - 1);
        n++;
    }
    if (n === 0) return 0;
    return Math.min(1, sum / n / TAPE_DISTORTION_MAX);
}

/**
 * Stateful found-tape instance: owns the seed and the monotonic sample
 * counter so successive measures draw fresh jitter/parity, and serializes
 * to a JSON envelope that restores both exactly.
 */
export class SurveyorsTape {
    /** Tape seed driving all jitter and parity draws. */
    readonly seed: number;

    private taken = 0;

    /**
     * @param seed Tape seed driving all jitter and parity draws.
     */
    constructor(seed: number) {
        this.seed = seed;
    }

    /** Number of measurements taken since construction/deserialization. */
    get samplesTaken(): number {
        return this.taken;
    }

    /**
     * Take the next reading. Uses the current sample index and advances
     * the counter, so consecutive measures never share jitter.
     *
     * @param trueDistance True distance in meters.
     * @param anomalyDensity Local anomaly density a ∈ [0,1].
     * @returns The displayed distance in meters.
     */
    measure(trueDistance: number, anomalyDensity: number): number {
        return tapeReading(trueDistance, anomalyDensity, this.seed, this.taken++);
    }

    /**
     * Serialize tape state (seed + sample counter) to JSON.
     *
     * @returns JSON string accepted by SurveyorsTape.deserialize.
     */
    serialize(): string {
        return JSON.stringify({ format: 'surveyors-tape', version: 1, seed: this.seed, taken: this.taken });
    }

    /**
     * Restore a tape from serialize() output. Throws on unknown formats
     * (misconfiguration fails loud) rather than guessing.
     *
     * @param json Output of a previous serialize().
     * @returns A tape resuming at the saved sample index.
     */
    static deserialize(json: string): SurveyorsTape {
        const raw: unknown = JSON.parse(json);
        if (
            typeof raw !== 'object' || raw === null ||
            (raw as { format?: unknown }).format !== 'surveyors-tape' ||
            (raw as { version?: unknown }).version !== 1
        ) {
            throw new Error('surveytape: unrecognized serialization envelope');
        }
        const env = raw as { seed: unknown; taken: unknown };
        if (typeof env.seed !== 'number' || typeof env.taken !== 'number') {
            throw new Error('surveytape: malformed serialization fields');
        }
        const tape = new SurveyorsTape(env.seed >>> 0);
        tape.taken = Math.max(0, Math.floor(env.taken));
        return tape;
    }
}
