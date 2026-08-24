/**
 * F18 Time Slippage — inside saturation zones, clocks stop agreeing.
 *
 * Three registered clocks (wallclock / camcorder / session) each accumulate a
 * deterministic offset while the player stands in a memory-saturated zone.
 * Offsets derive from RNG keyed by (seed, zoneSeed, clock id), grow
 * monotonically with saturation s ∈ [0,1], are bounded by SLIP_MAX_DRIFT_SEC,
 * and are exactly zero at s = 0. The same zone seed fed through two instances
 * yields byte-identical readings, so a camcorder that disagreed with the wall
 * clock once disagrees the same way every run. Pure simulation core — no
 * Babylon, no game imports; the mount feeds zone entries and saturations.
 */
import { RNG, hash2i, seedFromString } from '../core/rng';

/** Clocks the player can read; they drift apart inside saturated zones. */
export type ClockId = 'wallclock' | 'camcorder' | 'session';

export const CLOCK_IDS: readonly ClockId[] = ['wallclock', 'camcorder', 'session'];

/** Hard bound on any single clock's slippage magnitude, in seconds. */
export const SLIP_MAX_DRIFT_SEC = 137;

const ZONE_SALT = 0x71ae;
const CLOCK_SALT = 0xc10c;

function clockOrdinal(id: ClockId): number {
  return CLOCK_IDS.indexOf(id);
}

function clamp01(s: number): number {
  return Math.max(0, Math.min(1, s));
}

/** Deterministic per-zone seed for any zone key under this master seed. */
export function slippageZoneSeed(seed: number, zoneKey: string): number {
  return hash2i(seedFromString(zoneKey), seed ^ ZONE_SALT);
}

/**
 * Fixed drift character of one clock inside one zone: direction of slip, how
 * much of the bound it uses at full saturation, and the ease-in exponent.
 */
export interface SlipProfile {
  /** true when the clock runs fast, false when it runs slow */
  forward: boolean;
  /** fraction of SLIP_MAX_DRIFT_SEC reached at s = 1 (0.12..1) */
  rate: number;
  /** monotone ease-in exponent applied to saturation (>= 1) */
  ease: number;
}

/** Deterministic profile for (seed, zoneSeed, clock); stable across instances. */
export function slipProfile(seed: number, clockId: ClockId, zoneSeed: number): SlipProfile {
  const rng = new RNG(hash2i(zoneSeed, clockOrdinal(clockId), seed ^ CLOCK_SALT));
  return { forward: rng.chance(0.62), rate: rng.range(0.12, 1), ease: rng.range(1.4, 2.4) };
}

/**
 * Offset in seconds that `clockId` shows versus true time inside a zone with
 * `zoneSeed` at memory `saturation` s ∈ [0,1]. Zero at s = 0; |offset| grows
 * monotonically with s and never exceeds SLIP_MAX_DRIFT_SEC.
 */
export function slipOffsetSec(
  seed: number,
  clockId: ClockId,
  zoneSeed: number,
  saturation: number,
): number {
  const s = clamp01(saturation);
  if (s === 0) return 0;
  const p = slipProfile(seed, clockId, zoneSeed);
  const mag = SLIP_MAX_DRIFT_SEC * p.rate * Math.pow(s, p.ease);
  return p.forward ? mag : -mag;
}

/** Max pairwise disagreement between any two clocks in the same zone state. */
export function slipSpreadSec(seed: number, zoneSeed: number, saturation: number): number {
  let min = Infinity;
  let max = -Infinity;
  for (const id of CLOCK_IDS) {
    const o = slipOffsetSec(seed, id, zoneSeed, saturation);
    if (o < min) min = o;
    if (o > max) max = o;
  }
  return max - min;
}

/**
 * Session-facing tracker: the mount registers zones, reports which zone the
 * player is in and its current saturation, then reads clocks each frame.
 */
export class TimeSlippage {
  private zoneSeeds = new Map<string, number>();
  private zoneKey: string | null = null;
  private saturation = 0;

  constructor(
    public readonly seed: number,
    public readonly clocks: readonly ClockId[] = CLOCK_IDS,
  ) {}

  /**
   * Pins an explicit zone seed (e.g. persisted per chunk). Unpinned keys use
   * {@link slippageZoneSeed}, itself stable across instances.
   * @param zoneSeed any int; folded through hash2i so all values are safe
   */
  registerZone(zoneKey: string, zoneSeed: number): void {
    this.zoneSeeds.set(zoneKey, hash2i(zoneSeed, this.seed ^ ZONE_SALT));
  }

  /** Effective zone seed for a key, honoring registerZone overrides. */
  zoneSeedOf(zoneKey: string): number {
    const pinned = this.zoneSeeds.get(zoneKey);
    return pinned !== undefined ? pinned : slippageZoneSeed(this.seed, zoneKey);
  }

  /**
   * Sets the occupied zone and its memory saturation.
   * @param saturation s ∈ [0,1]; values outside clamp silently
   */
  enterZone(zoneKey: string, saturation: number): void {
    this.zoneKey = zoneKey;
    this.saturation = clamp01(saturation);
  }

  /** Updates saturation for the currently occupied zone without re-entering. */
  setSaturation(saturation: number): void {
    this.saturation = clamp01(saturation);
  }

  /** Zone key passed to the last enterZone, or null before the first entry. */
  get currentZone(): string | null {
    return this.zoneKey;
  }

  /** Current slippage offset (seconds) for one registered clock. */
  offset(clockId: ClockId): number {
    if (!this.zoneKey || !this.clocks.includes(clockId)) return 0;
    return slipOffsetSec(this.seed, clockId, this.zoneSeedOf(this.zoneKey), this.saturation);
  }

  /** Offsets for every registered clock at the current zone/saturation. */
  offsets(): Record<ClockId, number> {
    const out = {} as Record<ClockId, number>;
    for (const id of this.clocks) out[id] = this.offset(id);
    return out;
  }

  /**
   * A clock's displayed elapsed time given true elapsed session seconds —
   * true time plus the clock's current offset.
   */
  reading(clockId: ClockId, sessionSec: number): number {
    return sessionSec + this.offset(clockId);
  }

  /** Max pairwise disagreement among registered clocks right now, in seconds. */
  disagreementSec(): number {
    if (!this.zoneKey) return 0;
    const zs = this.zoneSeedOf(this.zoneKey);
    let min = Infinity;
    let max = -Infinity;
    for (const id of this.clocks) {
      const o = slipOffsetSec(this.seed, id, zs, this.saturation);
      if (o < min) min = o;
      if (o > max) max = o;
    }
    return max - min;
  }
}
