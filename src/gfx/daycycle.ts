/**
 * Time-of-day color drift.
 *
 * The Backrooms have no windows, but something keeps time anyway.
 * Across a long session the lighting temperature drifts through a
 * slow 20-minute cycle - as if hours pass differently here:
 *
 *   neutral -> warm gold ("afternoon") -> deep amber ("dusk")
 *           -> cold blue-gray ("night") -> pale gray ("dawn") -> neutral
 *
 * Design rules:
 *  - Pure logic. Emits r,g,b MULTIPLIERS only; the caller applies
 *    them to fog, hemisphere light and fixture emissive colors.
 *  - Non-linear: every phase transition eases through smoothstep,
 *    never a linear ramp, never a hard step.
 *  - The Backrooms linger at dusk: the amber phase runs longer
 *    than any other stretch of the cycle.
 *  - Blackouts freeze the cycle mid-phase - whatever hour it was,
 *    it stays that way until the lights return.
 */

/** A color expressed as multipliers on an existing base color. */
type RGB = [number, number, number];

export type DayPhaseName =
  | 'neutral'
  | 'afternoon'
  | 'dusk'
  | 'night'
  | 'dawn';

interface PhaseDef {
  name: DayPhaseName;
  /** seconds this phase occupies inside one full cycle */
  dur: number;
  /** the color this phase settles on (multipliers on the base palette) */
  color: RGB;
}

/** Full cycle length in seconds: 20 minutes of drifting light. */
export const DAYCYCLE_LENGTH = 1200;

const NEUTRAL: RGB = [1, 1, 1];

/**
 * Phase table. Durations deliberately uneven - dusk owns the largest
 * slice because this place lingers at dusk.
 */
const PHASES: PhaseDef[] = [
  { name: 'neutral',   dur: 300, color: [1.00, 1.00, 1.00] }, // fluorescent flatline
  { name: 'afternoon', dur: 250, color: [1.14, 0.99, 0.80] }, // warm gold
  { name: 'dusk',      dur: 350, color: [1.08, 0.70, 0.44] }, // deep amber - the longest stretch
  { name: 'night',     dur: 200, color: [0.60, 0.69, 0.90] }, // cold blue-gray
  { name: 'dawn',      dur: 100, color: [0.93, 0.93, 0.97] }, // pale gray
];

/** Cumulative start offset of each phase within the cycle. */
const STARTS: number[] = (() => {
  const acc: number[] = [];
  let t = 0;
  for (const p of PHASES) {
    acc.push(t);
    t += p.dur;
  }
  return acc;
})();

function phaseAt(cycleTime: number): number {
  let idx = PHASES.length - 1;
  for (let i = 0; i < PHASES.length; i++) {
    if (cycleTime < STARTS[i] + PHASES[i].dur) {
      idx = i;
      break;
    }
  }
  return idx;
}

/** Hermite ease: 0 -> 0, 1 -> 1, flat tangents at both ends. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return u * u * (3 - 2 * u);
}

/** Serializable state: position within the drifting cycle. */
export interface DayCycleState {
  /** accumulated lit-clock seconds (wraps modulo DAYCYCLE_LENGTH) */
  clock: number;
}

/** Fraction of a phase spent easing out of the PREVIOUS color into ours. */
const RAMP_FRACTION = 0.5;

/**
 * Pure time-of-day drift system. Feed it dt and the blackout flag;
 * read back multipliers and paint your own scene with them.
 */
export class DayCycle {
  /** lit-clock seconds accumulated inside the current cycle */
  private clock = 0;

  /**
   * Advance the cycle. During a blackout the drift pauses entirely -
   * the hour freezes wherever it was.
   */
  update(dt: number, blackout: boolean): void {
    if (blackout || !(dt > 0)) return;
    this.clock = (this.clock + dt) % DAYCYCLE_LENGTH;
  }

  /**
   * Global fog-tint multiplier for the current instant.
   * Multiply the scene fog color by this.
   */
  currentTint(): RGB {
    return this.blend(PHASES[phaseAt(this.clock)].color);
  }

  /**
   * Hemispheric light-color multiplier. Tracks the same drift but
   * leans further into the phase character than the fog does.
   */
  currentHemiTint(): RGB {
    const p = PHASES[phaseAt(this.clock)];
    return this.blend([
      1 + (p.color[0] - 1) * 1.35,
      1 + (p.color[1] - 1) * 1.35,
      1 + (p.color[2] - 1) * 1.35,
    ]);
  }

  /**
   * Fixture emissive warmth: 1 at neutral, above 1 when the air runs
   * gold or amber, below 1 under the cold night wash.
   */
  currentFixtureWarmth(): number {
    const c = this.currentTint();
    // (r+1)/(b+1) is exactly 1 for the neutral palette and swings
    // smoothly warm under gold/amber, cold under the night wash.
    return (c[0] + 1) / (c[2] + 1);
  }

  /** Human-readable phase label for the current instant. */
  currentPhase(): string {
    return PHASES[phaseAt(this.clock)].name;
  }

  /** Seconds left before the current phase hands over to the next. */
  phaseRemaining(): number {
    const i = phaseAt(this.clock);
    return STARTS[i] + PHASES[i].dur - this.clock;
  }

  serialize(): DayCycleState {
    return { clock: this.clock };
  }

  deserialize(state: DayCycleState): void {
    if (state && typeof state.clock === 'number' && isFinite(state.clock)) {
      this.clock = ((state.clock % DAYCYCLE_LENGTH) + DAYCYCLE_LENGTH) % DAYCYCLE_LENGTH;
    }
  }

  /**
   * Blend from the previous phase's settled color into this phase's
   * color across the first half of the phase, eased by smoothstep;
   * hold the settled color for the rest.
   */
  private blend(target: RGB): RGB {
    const i = phaseAt(this.clock);
    const local = this.clock - STARTS[i];
    const rampLen = PHASES[i].dur * RAMP_FRACTION;
    const from = PHASES[(i + PHASES.length - 1) % PHASES.length].color;
    const k = smoothstep(0, rampLen, local);
    return [
      from[0] + (target[0] - from[0]) * k,
      from[1] + (target[1] - from[1]) * k,
      from[2] + (target[2] - from[2]) * k,
    ];
  }
}


