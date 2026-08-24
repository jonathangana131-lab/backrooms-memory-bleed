/**
 * F34 Self-tuning radio — broadcasts that know what you found.
 *
 * A band-scan receiver whose stations are grown from the player's own
 * discovery feed and equipment loadout. Every real discovery seeds one
 * grounded station; a handful of decoy stations reference entries that
 * do not exist. Each station carries a script assembled deterministically
 * from (run seed, referenced entry ids), so the same discoveries always
 * tune into the same words.
 *
 * Grounding model: a station's selection weight is its grounding score
 * (how many of its referenced entries actually exist right now) times a
 * drift-time ramp. Decoy scores are always zero, so within RAMP_SECONDS
 * every real-discovery station outranks every decoy and the dial pulls
 * monotonically toward the strongest one. With an empty feed nothing has
 * weight: the dial holds still and the receiver is silent.
 *
 * This module is the tuning/selection MODEL only (headless-testable);
 * Web Audio presentation layers on top of it elsewhere.
 */

import { hash32, seedFromString } from '../core/rng';

/** One logged player discovery feeding the radio's grounding model. */
export interface FeedEntry {
  /** Stable discovery id (journal ids work as-is). */
  readonly id: string;
  /** Discovery category; selects the script body pool ('note' etc.). */
  readonly kind: string;
  /** Deterministic wording seed; same seed, same spoken designation. */
  readonly textSeed: string;
}

/** Reads the live discovery feed. Called once per update tick. */
export type FeedProvider = () => readonly FeedEntry[];

/** Reads the player's current loadout descriptor ids. */
export type LoadoutProvider = () => readonly string[];

/** Band edges in MHz. */
export const BAND_MIN_MHZ = 88.0;
export const BAND_MAX_MHZ = 108.0;

/** Seconds until the grounding ramp reaches full strength (~2 minutes). */
export const RAMP_SECONDS = 120;

/** Dial travel toward the dominant station, MHz per second at full ramp. */
export const DRIFT_RATE_MHZ = 0.4;

/** Maximum grounded stations kept from the feed head. */
export const MAX_GROUNDED_STATIONS = 6;
/** Maximum loadout-grounded stations kept. */
export const MAX_LOADOUT_STATIONS = 4;
/** Fixed number of decoy stations mixed into the band. */
export const DECOY_COUNT = 4;

/** A scan-band station: either grounded in real discoveries or a decoy. */
export interface RadioStation {
  /** Stable station key ('discovery:<id>', 'loadout:<id>', 'decoy:<n>'). */
  readonly key: string;
  /** Carrier frequency in MHz, deterministic per (seed, key). */
  readonly freq: number;
  /** Feed entry ids this station claims to describe. */
  readonly entryRefs: readonly string[];
  /** Loadout descriptor ids this station claims to describe. */
  readonly loadoutRefs: readonly string[];
  /** True when the station references entries that never exist. */
  readonly decoy: boolean;
}

/**
 * Hash a station key together with the run seed into a 32-bit seed.
 *
 * @param seed - Run seed string.
 * @param key - Station key.
 * @returns Deterministic 32-bit station seed.
 */
function stationSeed(seed: string, key: string): number {
  return hash32(seedFromString(seed) ^ seedFromString(key));
}

/**
 * Carrier frequency for a station: inside the padded band, one decimal,
 * identical for identical (seed, key).
 *
 * @param seed - Run seed string.
 * @param key - Station key.
 * @returns Frequency in MHz between BAND_MIN_MHZ+1 and BAND_MAX_MHZ-1.
 */
export function stationFreqFor(seed: string, key: string): number {
  const s = stationSeed(seed, key);
  const span = BAND_MAX_MHZ - BAND_MIN_MHZ - 2;
  return Math.round((BAND_MIN_MHZ + 1 + (s / 4294967296) * span) * 10) / 10;
}

/**
 * Build the station list for the current feed/loadout: one grounded
 * station per capped feed entry, one per capped loadout descriptor, plus
 * DECOY_COUNT decoys citing absent entry ids.
 *
 * @param seed - Run seed string.
 * @param feed - Current discovery feed (head entries win the cap).
 * @param loadout - Current loadout descriptor ids (head wins the cap).
 * @returns Stations ordered grounded-feed, grounded-loadout, decoys.
 */
export function buildStations(
  seed: string,
  feed: readonly FeedEntry[],
  loadout: readonly string[],
): RadioStation[] {
  const stations: RadioStation[] = [];
  for (const entry of feed.slice(0, MAX_GROUNDED_STATIONS)) {
    const key = `discovery:${entry.id}`;
    stations.push({
      key,
      freq: stationFreqFor(seed, key),
      entryRefs: [entry.id],
      loadoutRefs: [],
      decoy: false,
    });
  }
  for (const item of loadout.slice(0, MAX_LOADOUT_STATIONS)) {
    const key = `loadout:${item}`;
    stations.push({
      key,
      freq: stationFreqFor(seed, key),
      entryRefs: [],
      loadoutRefs: [item],
      decoy: false,
    });
  }
  for (let i = 0; i < DECOY_COUNT; i++) {
    // Decoys cite plausible-but-absent ids so their scripts read real
    // while never grounding against an actual feed.
    const key = `decoy:${i}`;
    stations.push({
      key,
      freq: stationFreqFor(seed, key),
      entryRefs: [`absent-${stationSeed(seed, key).toString(16)}`],
      loadoutRefs: [],
      decoy: true,
    });
  }
  return stations;
}

/**
 * How strongly a station grounds in the live discovery state: the count
 * of its referenced feed entries and loadout descriptors that actually
 * exist. Decoys always score zero because their refs are absent by
 * construction.
 *
 * @param station - Station to score.
 * @param feedIds - Set of live feed entry ids.
 * @param loadoutIds - Set of live loadout descriptor ids.
 * @returns Non-negative grounding hit count.
 */
export function groundingScore(
  station: RadioStation,
  feedIds: ReadonlySet<string>,
  loadoutIds: ReadonlySet<string>,
): number {
  let hits = 0;
  for (const id of station.entryRefs) if (feedIds.has(id)) hits++;
  for (const id of station.loadoutRefs) if (loadoutIds.has(id)) hits++;
  return hits;
}

/**
 * Deterministic on-air designation code derived from a text seed, used
 * as the {code} placeholder inside script bodies.
 *
 * @param textSeed - Entry wording seed (or any stable string).
 * @returns Short uppercase code such as 'SIGNAL-3FA2'.
 */
export function designationFor(textSeed: string): string {
  return `SIGNAL-${hash32(seedFromString(textSeed)).toString(16)
    .slice(0, 4)
    .toUpperCase()}`;
}

/** Script openers, chosen per station. */
const OPENERS: readonly string[] = [
  'You are listening to the only signal left in the building.',
  'This frequency finds you. It always finds you.',
  'Stay tuned. The walls repeat everything worth repeating.',
];

/** Per-kind script bodies; kinds without a pool fall back to GENERIC_BODIES.
 *  Every body speaks the {code}, so each broadcast grounds in its entry. */
const BODIES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  note: [
    'The note you folded into your pocket reads differently out loud, {code}.',
    'Someone transcribed your finding word for word before you wrote it, {code}.',
    '{code} confirms the handwriting on that page is your own.',
  ],
  landmark: [
    'The room you stood in has been on this frequency for years, {code}.',
    '{code} logs your footsteps in that chamber as a repeat broadcast.',
    'That corner keeps broadcasting, {code}, to whoever stands where you stood.',
  ],
  anomaly: [
    'What you witnessed was scheduled, {code}. You simply attended.',
    '{code} apologizes for the geometry. It has been corrected around you.',
    'Report the irregularity again, {code}. It enjoys the attention.',
  ],
};

/** Fallback bodies for discovery kinds without a dedicated pool. */
const GENERIC_BODIES: readonly string[] = [
  '{code} thanks you for documenting what it already knew.',
  'Your discovery is being rebroadcast to every empty room, {code}.',
  'Keep the recording, {code}. The place already kept its copy.',
];

/** Script closers, chosen independently of the opener. */
const CLOSERS: readonly string[] = [
  'We return to your findings shortly.',
  'Remain where the signal is strongest.',
  'This has been a recording of something you did.',
];

/**
 * Pick one element deterministically from a non-empty pool.
 *
 * @param pool - Candidate strings; must not be empty.
 * @param s - 32-bit selection seed.
 * @returns One element of the pool.
 */
function pick(pool: readonly string[], s: number): string {
  return pool[s % pool.length];
}

/**
 * Assemble a station's broadcast script from its referenced entries.
 * Identical (seed, referenced entry ids/kinds/textSeeds) always yield
 * identical lines; decoys are equally deterministic off their absent
 * ref hashes. The body pool follows the first referenced feed entry's
 * kind when it exists, otherwise the generic pool.
 *
 * @param seed - Run seed string.
 * @param station - Station to script.
 * @param feed - Live feed entries supplying kinds and textSeeds; may be
 *   empty (decoy scripting).
 * @returns Three-line script: opener, body, closer.
 */
export function assembleScript(
  seed: string,
  station: RadioStation,
  feed: readonly FeedEntry[],
): readonly string[] {
  let h = stationSeed(seed, station.key);
  for (const id of station.entryRefs) h = hash32(h ^ seedFromString(id));
  for (const id of station.loadoutRefs) h = hash32(h ^ seedFromString(id));

  const byId = new Map(feed.map((e) => [e.id, e]));
  const firstRefId = station.entryRefs[0];
  const firstRef = firstRefId !== undefined ? byId.get(firstRefId) : undefined;
  const bodies =
    firstRef !== undefined ? BODIES_BY_KIND[firstRef.kind] ?? GENERIC_BODIES : GENERIC_BODIES;

  const codeSource = firstRef?.textSeed ?? firstRefId ?? station.key;
  const body = pick(bodies, hash32(h ^ 0x1f123bb5)).replaceAll('{code}', designationFor(codeSource));
  return [
    pick(OPENERS, hash32(h ^ 0x5bd1f99d)),
    body,
    pick(CLOSERS, hash32(h ^ 0x51ed270b)),
  ];
}

/**
 * Self-tuning receiver model. Each update() refreshes the live feed,
 * ramps grounding weights with drift time, and eases the dial toward
 * the dominant station. With no grounded station the dial holds still
 * and the receiver reports silence instead of a broadcast.
 */
export class SelfRadio {
  private readonly seed: string;
  private readonly getFeed: FeedProvider;
  private readonly getLoadout: LoadoutProvider;

  private dial = BAND_MIN_MHZ + 1;
  private driftTime = 0;
  private stations: RadioStation[] = [];
  private readonly weightsByKey = new Map<string, number>();
  private stopped = false;

  /**
   * @param opts.seed - Run seed string.
   * @param opts.getFeed - Live discovery feed provider.
   * @param opts.getLoadout - Live loadout descriptor provider.
   */
  constructor(opts: {
    seed: string;
    getFeed: FeedProvider;
    getLoadout: LoadoutProvider;
  }) {
    this.seed = opts.seed;
    this.getFeed = opts.getFeed;
    this.getLoadout = opts.getLoadout;
  }

  /** Current dial position in MHz. */
  get dialMhz(): number {
    return this.dial;
  }

  /** Accumulated drift time in seconds (drives the grounding ramp). */
  get driftSeconds(): number {
    return this.driftTime;
  }

  /**
   * Advance the tuner. Non-positive dt leaves state untouched. Refreshes
   * stations/weights from the providers, then moves the dial monotonically
   * toward the dominant station while any station has weight.
   *
   * @param dtSec - Elapsed seconds this frame.
   */
  update(dtSec: number): void {
    if (this.stopped || !(dtSec > 0)) return;
    this.driftTime += dtSec;

    const feed = this.getFeed();
    const loadout = this.getLoadout();
    this.stations = buildStations(this.seed, feed, loadout);
    const feedIds = new Set(feed.map((e) => e.id));
    const loadoutIds = new Set(loadout);

    const ramp = Math.min(1, this.driftTime / RAMP_SECONDS);
    this.weightsByKey.clear();
    let best: RadioStation | null = null;
    let bestWeight = 0;
    for (const st of this.stations) {
      // Weight rises only while the script grounds in live state; decoys
      // stay pinned at zero forever.
      const score = groundingScore(st, feedIds, loadoutIds);
      const w = score * ramp;
      this.weightsByKey.set(st.key, w);
      if (w > bestWeight) {
        bestWeight = w;
        best = st;
      }
    }

    if (!best) return; // silence-safe: nothing grounded, dial frozen
    const dist = best.freq - this.dial;
    if (Math.abs(dist) <= 0.001) return;
    const step = Math.min(Math.abs(dist), DRIFT_RATE_MHZ * dtSec * Math.max(ramp, 0.05));
    this.dial += Math.sign(dist) * step;
  }

  /**
   * Selection weights keyed by station key from the last update().
   *
   * @returns Read-only view of current weights (empty before first update).
   */
  weights(): ReadonlyMap<string, number> {
    return this.weightsByKey;
  }

  /**
   * The dominant grounded station, or null when nothing grounds (which
   * includes an empty feed: the receiver stays silent rather than
   * locking onto a decoy).
   *
   * @returns Best-weighted station or null.
   */
  bestStation(): RadioStation | null {
    let best: RadioStation | null = null;
    let bestWeight = 0;
    for (const st of this.stations) {
      const w = this.weightsByKey.get(st.key) ?? 0;
      if (w > bestWeight) {
        bestWeight = w;
        best = st;
      }
    }
    return best;
  }

  /**
   * What is on air right now: the dominant station with its deterministic
   * script and a clarity value following the grounding ramp, or null
   * while silent.
   *
   * @returns Broadcast snapshot or null.
   */
  onAir(): { station: RadioStation; script: readonly string[]; clarity: number } | null {
    const best = this.bestStation();
    if (!best) return null;
    const w = this.weightsByKey.get(best.key) ?? 0;
    return {
      station: best,
      script: assembleScript(this.seed, best, this.getFeed()),
      clarity: Math.min(1, w),
    };
  }

  /** Halt the tuner permanently; later updates are ignored. */
  stop(): void {
    this.stopped = true;
  }
}
