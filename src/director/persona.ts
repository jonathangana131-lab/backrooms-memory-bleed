/**
 * F48 — Director personalities: per-run temperament altering pacing curves.
 *
 * A pure mapping layer between the HorrorDirector's generic phase-duration
 * and intensity inputs and the run's selected temperament. The director
 * stays untouched: it draws its usual base values and passes them through
 * `adjustPhase` / `adjustIntensity` with its persistent pacing stream.
 *
 * Determinism: all randomness flows through the injected RNG (RNG law,
 * src/core/rng.ts). Same (seed, temperament) ⇒ identical adjusted curve.
 *
 * Temperaments:
 * - patient      — longer calm/build phases (×1.15–1.35), shorter peaks,
 *                  softened peak intensity, fewer anomaly windows.
 * - vindictive   — peaks run hotter (+30% intensity proxy), builds
 *                  compress further the longer the player has gone
 *                  without a peak (safety streak).
 * - theatrical   — wide multiplier variance everywhere and a strongly
 *                  raised window-event rate; swings instead of pressure.
 */

import { RNG, hash2i } from '../core/rng';
import type { Phase } from './director';

/** The three v1 temperaments, selectable per run. */
export type Temperament = 'patient' | 'vindictive' | 'theatrical';

/** All valid temperaments in canonical order (index = selection bucket). */
export const TEMPERAMENTS: readonly Temperament[] = ['patient', 'vindictive', 'theatrical'];

/** Documented fallback: an unrecognized temperament behaves as 'patient'. */
export const DEFAULT_TEMPERAMENT: Temperament = 'patient';

/** Salt separating the temperament-selection hash from other seed streams. */
const SELECTION_SALT = 0x7e3d12a4 >>> 0;

/** Salt separating the per-(seed,temperament) pacing stream from others. */
const PACING_SALT = 0x1d0c6f90 >>> 0;

/** Extra phase inputs beyond duration/intensity, all optional. */
export interface PhaseContext {
    /**
     * Consecutive director cycles the player has ended without experiencing
     * a peak. Vindictive builds shorten by 8% per streak step (floor ×0.5);
     * other temperaments ignore it.
     */
    safetyStreak?: number;
}

/**
 * Pick the run's temperament deterministically from the run seed.
 *
 * @param seed Run seed.
 * @returns One of the three temperaments, uniform across seeds.
 */
export function temperamentForRun(seed: number): Temperament {
    return TEMPERAMENTS[hash2i(seed, 0, SELECTION_SALT) % TEMPERAMENTS.length];
}

/**
 * Normalize an externally supplied temperament tag to a valid one.
 * Unknown or missing tags fall back to DEFAULT_TEMPERAMENT ('patient');
 * this is the documented behavior for out-of-table input (save data,
 * settings payloads) rather than throwing.
 *
 * @param t Tag to normalize; compared against the canonical table.
 * @returns The tag itself when valid, otherwise 'patient'.
 */
export function normalizeTemperament(t: string | undefined | null): Temperament {
    return TEMPERAMENTS.includes(t as Temperament) ? (t as Temperament) : DEFAULT_TEMPERAMENT;
}

/**
 * Derive the dedicated pacing stream for a run: one RNG instance per
 * (seed, temperament) pair, so replaying a run reproduces its exact
 * adjusted pacing curve while keeping streams distinct across runs.
 *
 * @param seed Run seed.
 * @param temperament Run temperament (normalized before use).
 * @returns A fresh deterministic RNG for adjustPhase/adjustIntensity draws.
 */
export function pacingRngFor(seed: number, temperament: Temperament): RNG {
    const t = normalizeTemperament(temperament);
    return new RNG(hash2i(seed, TEMPERAMENTS.indexOf(t), PACING_SALT));
}

/** Multiplier bounds [min,max) applied via rng.range for one phase. */
type Range = readonly [number, number];

/** Per-phase duration multiplier ranges keyed by temperament. */
const PHASE_MULT: Record<Temperament, Record<Phase, Range>> = {
    // Long waits, brief storms.
    patient: {
        calm: [1.15, 1.35],
        build: [1.15, 1.35],
        peak: [0.55, 0.75],
        release: [1.05, 1.2],
    },
    // Short fuse into hot peaks; recovery cut short too.
    vindictive: {
        calm: [0.75, 0.95],
        build: [0.7, 0.9],
        peak: [1.15, 1.35],
        release: [0.8, 1.0],
    },
    // Anything can run long or short: variance IS the temperament.
    theatrical: {
        calm: [0.5, 1.9],
        build: [0.5, 1.9],
        peak: [0.5, 1.9],
        release: [0.5, 1.9],
    },
};

/** Peak-intensity proxy multipliers keyed by temperament. */
const INTENSITY_MULT: Record<Temperament, Range> = {
    patient: [0.78, 0.82],       // softened
    vindictive: [1.3, 1.3],      // +30% intensity proxy, by design
    theatrical: [0.6, 1.4],      // swings both ways
};

/** Window-event (anomaly window open/close) chance multipliers. */
const WINDOW_RATE_MULT: Record<Temperament, number> = {
    patient: 0.7,
    vindictive: 0.85,
    theatrical: 1.5,
};

/**
 * Map one generic phase-duration input through the temperament modifier
 * table. Draws one multiplier from the temperament's range for the given
 * phase; vindictive additionally compresses builds as the player's safety
 * streak grows.
 *
 * @param phase Director phase being entered.
 * @param baseDurationSec Generic duration the director drew for the phase.
 * @param temperament Run temperament (normalized before use).
 * @param rng Persistent pacing stream; caller owns draw order.
 * @param context Optional extra inputs (safetyStreak).
 * @returns Adjusted duration in seconds (> 0), deterministic per inputs.
 */
export function adjustPhase(
    phase: Phase,
    baseDurationSec: number,
    temperament: Temperament,
    rng: RNG,
    context?: PhaseContext,
): number {
    const t = normalizeTemperament(temperament);
    let [lo, hi] = PHASE_MULT[t][phase];
    if (t === 'vindictive' && phase === 'build') {
        const streak = Math.max(0, Math.floor(context?.safetyStreak ?? 0));
        lo *= Math.max(0.5, 1 - 0.08 * streak);
        hi *= Math.max(0.5, 1 - 0.08 * streak);
    }
    return Math.max(1e-3, baseDurationSec * rng.range(lo, hi));
}

/**
 * Map one generic phase-intensity input through the temperament table.
 * Only meaningful for peaks today; calm/build/release pass through the
 * same table so callers need no phase special-casing. Result is clamped
 * to the 0..1 proxy range.
 *
 * @param baseIntensity Intensity proxy in 0..1 the director drew/computed.
 * @param phase Director phase the intensity belongs to.
 * @param temperament Run temperament (normalized before use).
 * @param rng Persistent pacing stream; caller owns draw order.
 * @returns Adjusted intensity clamped to [0, 1].
 */
export function adjustIntensity(
    baseIntensity: number,
    phase: Phase,
    temperament: Temperament,
    rng: RNG,
): number {
    void phase;
    const t = normalizeTemperament(temperament);
    const [lo, hi] = INTENSITY_MULT[t];
    return Math.min(1, Math.max(0, baseIntensity * rng.range(lo, hi)));
}

/**
 * Scale an anomaly window-event chance (per-second probability, as fed to
 * RNG.chance by the director) by the temperament's window-rate appetite:
 * theatrical raises it, patient suppresses it.
 *
 * @param baseChancePerSec Base per-second window-event probability.
 * @param temperament Run temperament (normalized before use).
 * @returns Scaled per-second probability clamped to [0, 1].
 */
export function windowEventChance(baseChancePerSec: number, temperament: Temperament): number {
    const t = normalizeTemperament(temperament);
    return Math.min(1, Math.max(0, baseChancePerSec * WINDOW_RATE_MULT[t]));
}
