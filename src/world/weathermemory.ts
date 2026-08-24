/**
 * F52 Weather with memory — last session's rain still drips in the same rooms.
 *
 * Rain sessions record a per-room drip-intensity ledger; any later session
 * replays decaying residue at the same room keys, so rooms that were rained
 * on keep dripping (faintly) long after the weather front has passed. The
 * model mirrors src/save/ledger.ts: pure logic over an injected
 * { get, set } storage pair (localStorage-like), so tests and callers can
 * back it with anything.
 *
 * Session semantics: every drip record is stamped with the ordinal of the
 * rain session that wrote it. Replaying at session S yields
 * intensity × decay^(S - recordedSession); a new rain session OVERWRITES
 * every key it touches (fresh intensity, fresh stamp) while keys it does
 * not touch keep decaying from their old stamp. Residue is floored at zero
 * and snapped to zero below RESIDUE_EPSILON — sub-visible drips vanish.
 *
 * A corrupt, foreign-version or throwing storage degrades to an empty
 * ledger on load; loading never throws. Writes fail loud (storage.set
 * failures propagate), matching the ledger convention. Random derivation
 * goes through src/core/rng.ts only.
 */
import { RNG, seedFromString } from '../core/rng';

/** Current payload version; bumps invalidate foreign memories. */
export const WEATHER_MEMORY_VERSION = 1;

/** Injected-storage key the weather memory is persisted under. */
export const WEATHER_MEMORY_STORAGE_KEY = 'bmb-weather-memory';

/**
 * Fraction of residue surviving one session without fresh rain.
 * 0.5 = half the drip is gone per intervening dry session.
 */
export const DRIP_DECAY_PER_SESSION = 0.5;

/** Residue below this intensity is floored to zero (sub-visible drip). */
export const RESIDUE_EPSILON = 1e-6;

/** Minimal persistence surface injected into the weather memory. */
export interface WeatherStorageLike {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** One room's remembered rain: how hard it dripped, in which session. */
export interface DripRecord {
  /** Drip intensity as written by its rain session (> 0, finite). */
  intensity: number;
  /** Ordinal of the rain session that wrote this record (integer ≥ 0). */
  session: number;
}

/** The full cross-session weather memory payload. */
export interface WeatherMemoryData {
  version: number;
  /** Drip records keyed by stable room key (caller-owned strings). */
  drips: Record<string, DripRecord>;
}

/** Fresh empty memory. */
export function createWeatherMemory(): WeatherMemoryData {
  return { version: WEATHER_MEMORY_VERSION, drips: {} };
}

function isValidRecord(r: unknown): r is DripRecord {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const v = r as Partial<DripRecord>;
  return (
    typeof v.intensity === 'number' &&
    Number.isFinite(v.intensity) &&
    v.intensity > 0 &&
    typeof v.session === 'number' &&
    Number.isInteger(v.session) &&
    v.session >= 0
  );
}

/**
 * Structural validation for payloads claiming to be a weather memory.
 * @returns The validated memory, or null when malformed/foreign-version.
 */
export function validateWeatherMemory(val: unknown): WeatherMemoryData | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const v = val as Partial<WeatherMemoryData>;
  if (v.version !== WEATHER_MEMORY_VERSION) return null;
  if (!v.drips || typeof v.drips !== 'object' || Array.isArray(v.drips)) return null;
  for (const record of Object.values(v.drips)) {
    if (!isValidRecord(record)) return null;
  }
  return { version: WEATHER_MEMORY_VERSION, drips: v.drips };
}

/**
 * Load the memory from injected storage.
 * @returns The validated memory, or an empty one when missing, corrupt,
 *   foreign-version or the storage throws. Never throws.
 */
export function loadWeatherMemory(storage: WeatherStorageLike): WeatherMemoryData {
  let raw: unknown;
  try {
    raw = storage.get(WEATHER_MEMORY_STORAGE_KEY);
  } catch {
    return createWeatherMemory();
  }
  if (raw === undefined || raw === null) return createWeatherMemory();
  try {
    let val: unknown = raw;
    if (typeof raw === 'string') {
      try {
        val = JSON.parse(raw);
      } catch {
        // Stored value was corrupted after write; treat like any junk.
        return createWeatherMemory();
      }
    }
    return validateWeatherMemory(val) ?? createWeatherMemory();
  } catch {
    // Validation cannot throw today; guard anyway so no storage payload
    // can ever take a session down through this path.
    return createWeatherMemory();
  }
}

/**
 * Persist the memory through injected storage.
 * @throws Propagates storage.set failures — writes fail loud.
 */
export function saveWeatherMemory(storage: WeatherStorageLike, memory: WeatherMemoryData): void {
  // Deep-clone so later mutation of caller state cannot alias storage.
  storage.set(WEATHER_MEMORY_STORAGE_KEY, JSON.parse(JSON.stringify(memory)));
}

/**
 * Record one rain session's drips into a NEW memory (input untouched).
 * Every key in `entries` is overwritten (fresh intensity + session stamp);
 * all other keys are carried over unchanged and keep their old stamps.
 * Invalid entries (non-finite or ≤ 0 intensity, non-integer or negative
 * session) are skipped rather than stored.
 * @param memory Memory to fold into.
 * @param entries Per-room drip intensities of this rain session.
 * @param session Ordinal of this rain session (integer ≥ 0).
 */
export function recordRainDrips(
  memory: WeatherMemoryData,
  entries: ReadonlyArray<{ roomKey: string; intensity: number }>,
  session: number,
): WeatherMemoryData {
  const next: WeatherMemoryData = {
    version: WEATHER_MEMORY_VERSION,
    drips: JSON.parse(JSON.stringify(memory.drips)),
  };
  if (!Number.isInteger(session) || session < 0) return next;
  for (const e of entries) {
    if (typeof e.roomKey !== 'string') continue;
    if (!(typeof e.intensity === 'number' && Number.isFinite(e.intensity) && e.intensity > 0)) {
      continue;
    }
    next.drips[e.roomKey] = { intensity: e.intensity, session };
  }
  return next;
}

/**
 * Exponential residue decay: `intensity × decay^sessionsSince`, floored at
 * zero and snapped to zero below RESIDUE_EPSILON. Negative sessionsSince
 * clamps to 0 (a future-stamped record replays at full intensity).
 */
export function decayResidue(
  intensity: number,
  sessionsSince: number,
  decay: number = DRIP_DECAY_PER_SESSION,
): number {
  if (!(intensity > 0)) return 0;
  const n = Math.max(0, sessionsSince);
  const raw = intensity * Math.pow(decay, n);
  return raw < RESIDUE_EPSILON ? 0 : raw;
}

/**
 * Replay one room's drip residue at session `currentSession`.
 * @param memory Memory to read (missing rooms drip nothing).
 * @param roomKey Stable room key the rain was recorded under.
 * @param currentSession Ordinal of the session asking.
 * @param decay Per-session survival fraction.
 */
export function roomDrip(
  memory: WeatherMemoryData,
  roomKey: string,
  currentSession: number,
  decay: number = DRIP_DECAY_PER_SESSION,
): number {
  const record = memory.drips[roomKey];
  if (!record) return 0;
  return decayResidue(record.intensity, currentSession - record.session, decay);
}

/**
 * Deterministic fresh-rain intensity for one room, in [0, 1).
 * Pure function of (roomKey, seed) via rng.ts — the same seed always rains
 * the same rooms equally hard, across instances and sessions.
 * @param roomKey Stable room key.
 * @param seed Master run seed.
 */
export function rollRoomDrip(roomKey: string, seed: number): number {
  const rr = new RNG((seedFromString(roomKey) ^ seed) >>> 0);
  return rr.next();
}
