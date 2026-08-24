/**
 * Injury limp (F77).
 *
 * Injected fall-impact events whose severity exceeds FALL_IMPACT_THRESHOLD
 * put the player into a limp: a stride asymmetry factor plus a speed
 * penalty starting at BASE_SPEED_PENALTY. Repeated hard falls accumulate
 * severity and deepen both outputs monotonically up to their caps
 * (MAX_SPEED_PENALTY ~12%); an injected firstaid event clears the limp
 * exactly, restoring stride 0 and full speed.
 *
 * Pure simulation logic: no Babylon imports, no randomness — the state
 * machine is a deterministic function of the injected event stream, so
 * any replay of the same events is byte-identical. game.ts feeds
 * onFallImpact/onFirstaid from the controller's hardfall path and reads
 * strideAsymmetry/speedPenalty in its movement solve; serialize/load
 * carry the state through the save system unchanged.
 */

/** Impact severity at or below which a fall leaves no mark. */
export const FALL_IMPACT_THRESHOLD = 25;
/** Speed fraction lost the moment a limp engages. */
export const BASE_SPEED_PENALTY = 0.06;
/** Hard cap on the speed loss of a fully worsened limp (~12%). */
export const MAX_SPEED_PENALTY = 0.12;
/** Stride asymmetry factor the moment a limp engages, in [0, 1]. */
export const ASYMMETRY_BASE = 0.2;
/** Hard cap on the stride asymmetry factor of a fully worsened limp. */
export const ASYMMETRY_MAX = 0.6;
/** Severity units needed to walk the penalty from base to max. */
export const SEVERITY_PER_FULL_PENALTY = 50;

/** One injected fall impact. */
export interface FallImpactEvent {
  /** Severity in arbitrary units; only values > FALL_IMPACT_THRESHOLD bite. */
  severity: number;
}

/** Durable limp state for the save system. */
export interface LimpSaveState {
  /** Whether a limp is currently active. */
  limping: boolean;
  /** Accumulated excess severity above the threshold across hard falls. */
  accumulatedSeverity: number;
}

/**
 * Excess severity contributed by one impact: 0 at or below the
 * threshold, the amount above it otherwise.
 *
 * @param severity Injected fall-impact severity.
 */
export function excessSeverity(severity: number): number {
  return severity > FALL_IMPACT_THRESHOLD ? severity - FALL_IMPACT_THRESHOLD : 0;
}

/**
 * Drives the limp across one session: impacts beyond the threshold
 * engage and worsen it, firstaid clears it exactly, and the whole
 * state round-trips through serialize()/load() for save persistence.
 * Sub-threshold falls and firstaid while healthy change nothing.
 */
export class InjuryLimp {
  private limping_ = false;
  private accumulatedSeverity_ = 0;

  constructor(saved?: LimpSaveState) {
    if (saved) this.load(saved);
  }

  /**
   * Feed one injected fall impact. Strictly beyond-threshold severities
   * engage the limp (if not already active) and add their excess to the
   * accumulated severity; everything else is ignored.
   */
  onFallImpact(event: FallImpactEvent): void {
    const excess = excessSeverity(event.severity);
    if (excess === 0) return;
    this.limping_ = true;
    this.accumulatedSeverity_ += excess;
  }

  /**
   * Feed one injected firstaid event. Clears an active limp exactly;
   * while healthy this is a no-op.
   */
  onFirstaid(): void {
    if (!this.limping_) return;
    this.limping_ = false;
    this.accumulatedSeverity_ = 0;
  }

  /** Whether a limp is currently altering the gait. */
  get limping(): boolean {
    return this.limping_;
  }

  /** Accumulated excess severity above the threshold since last clear. */
  get accumulatedSeverity(): number {
    return this.accumulatedSeverity_;
  }

  /**
   * Current stride asymmetry factor in [ASYMMETRY_BASE, ASYMMETRY_MAX]
   * while limping, monotone non-decreasing in accumulated severity;
   * exactly 0 when healthy.
   */
  strideAsymmetry(): number {
    if (!this.limping_) return 0;
    const t = Math.min(1, this.accumulatedSeverity_ / SEVERITY_PER_FULL_PENALTY);
    return ASYMMETRY_BASE + (ASYMMETRY_MAX - ASYMMETRY_BASE) * t;
  }

  /**
   * Current speed penalty fraction in [BASE_SPEED_PENALTY,
   * MAX_SPEED_PENALTY] while limping, monotone non-decreasing in
   * accumulated severity; exactly 0 when healthy.
   */
  speedPenalty(): number {
    if (!this.limping_) return 0;
    const t = Math.min(1, this.accumulatedSeverity_ / SEVERITY_PER_FULL_PENALTY);
    return BASE_SPEED_PENALTY + (MAX_SPEED_PENALTY - BASE_SPEED_PENALTY) * t;
  }

  /** Snapshot for the save system. */
  serialize(): LimpSaveState {
    return { limping: this.limping_, accumulatedSeverity: this.accumulatedSeverity_ };
  }

  /**
   * Restore a snapshot taken by serialize(); replaces the live state
   * wholesale so a loaded session resumes the exact limp.
   */
  load(state: LimpSaveState): void {
    this.limping_ = state.limping === true;
    this.accumulatedSeverity_ = Number.isFinite(state.accumulatedSeverity)
      && state.accumulatedSeverity > 0 ? state.accumulatedSeverity : 0;
  }
}
