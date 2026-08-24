/**
 * Seasonal bleed rooms (F57): one landmark room per session is stuck in
 * another season.
 *
 * Pure model, no Babylon imports. Every landmark room carries an intrinsic
 * season-bleed score derived only from (seed, roomId); the session's bleed
 * room is the highest-scoring landmark the session knows about, so the
 * winner is stable within a session no matter which order rooms stream in,
 * while varying across seeds. The winning room's foreign season - summer,
 * winter, monsoon, or bloom - comes from a second independent hash and
 * selects a frozen descriptor: a packed tint plus a particle descriptor a
 * renderer folds into its ambient pass.
 *
 * All randomness derives from src/core/rng.ts hashes, so assignments replay
 * byte-identically per seed.
 */
import { hash2i, seedFromString } from '../core/rng';

/** Salt so season-score draws never correlate with any other feature. */
const SCORE_SALT = 0x5e40;

/** Salt so the foreign-season pick never correlates with the score draw. */
const PICK_SALT = 0x57c0;

/** Seasons a room can bleed in from. */
export type SeasonId = 'summer' | 'winter' | 'monsoon' | 'bloom';

/** All seasons, fixed order used by the pick hash. */
export const SEASON_IDS = ['summer', 'winter', 'monsoon', 'bloom'] as const;

/** Ambient particle behaviour a renderer folds into its ambient pass. */
export interface ParticleDescriptor {
  /** Renderer particle archetype key ('heatmote'|'snowfall'|'rainstroke'|'petaldrift'). */
  readonly kind: string;
  /** Particles per cubic metre of room volume. */
  readonly densityPerM3: number;
  /** Vertical speed in m/s; negative falls, positive rises. */
  readonly fallSpeedMps: number;
  /** Horizontal sway frequency in Hz. */
  readonly swayHz: number;
  /** Packed particle tint 0xRRGGBB. */
  readonly rgb: number;
}

/**
 * Everything downstream needs to render one seasonal bleed: a packed
 * ambient tint plus the room's particle behaviour.
 */
export interface SeasonDescriptor {
  /** Which foreign season bled into the room. */
  readonly season: SeasonId;
  /** Packed ambient light tint 0xRRGGBB applied inside the room. */
  readonly tint: number;
  /** Ambient particle behaviour for the room volume. */
  readonly particle: ParticleDescriptor;
}

const CATALOG: Readonly<Record<SeasonId, SeasonDescriptor>> = Object.freeze({
  summer: Object.freeze({
    season: 'summer',
    tint: 0xffc46b,
    particle: Object.freeze({ kind: 'heatmote', densityPerM3: 0.8, fallSpeedMps: 0.35, swayHz: 2.1, rgb: 0xffe2a8 }),
  }),
  winter: Object.freeze({
    season: 'winter',
    tint: 0xbfd8ff,
    particle: Object.freeze({ kind: 'snowfall', densityPerM3: 1.6, fallSpeedMps: -0.9, swayHz: 0.7, rgb: 0xeef4ff }),
  }),
  monsoon: Object.freeze({
    season: 'monsoon',
    tint: 0x7fa8a0,
    particle: Object.freeze({ kind: 'rainstroke', densityPerM3: 3.2, fallSpeedMps: -6.5, swayHz: 0.2, rgb: 0xa8ccc4 }),
  }),
  bloom: Object.freeze({
    season: 'bloom',
    tint: 0xe8a8c8,
    particle: Object.freeze({ kind: 'petaldrift', densityPerM3: 1.1, fallSpeedMps: -0.5, swayHz: 1.3, rgb: 0xf6c6dd }),
  }),
});

/**
 * Frozen catalog of every seasonal bleed descriptor, keyed by season.
 * @returns The shared frozen record; mutating it throws.
 */
export function seasonCatalog(): Readonly<Record<SeasonId, SeasonDescriptor>> {
  return CATALOG;
}

/**
 * Intrinsic season-bleed score of one landmark room for a session.
 * Pure function of (seed, roomId): comparing scores across a room set is
 * what elects the single bleed room, so each room can be scored the moment
 * it streams in without knowing the rest of the session.
 * @param seed Master run seed.
 * @param roomId Stable room identity (ChunkDeltas.key idiom or any
 *   non-empty unique string).
 * @returns Unsigned 32-bit score.
 * @throws When roomId is empty.
 */
export function seasonScore(seed: number, roomId: string): number {
  if (roomId.length === 0) throw new Error('seasonrooms: roomId must be non-empty');
  return hash2i(seedFromString(roomId), seed, SCORE_SALT);
}

/**
 * Elect the session's single seasonal bleed room.
 * Deterministic order-independent argmax of seasonScore over `roomIds`;
 * a full-score tie (astronomically unlikely) breaks to the
 * lexicographically smallest roomId so the winner stays a pure function of
 * the room set.
 * @param seed Master run seed.
 * @param roomIds Landmark room ids known this session; no duplicates.
 * @returns The elected roomId, or null when the session knows no landmarks.
 * @throws On duplicate room ids.
 */
export function pickBleedRoom(seed: number, roomIds: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = -1;
  const seen = new Set<string>();
  for (const id of roomIds) {
    if (seen.has(id)) throw new Error(`seasonrooms: duplicate roomId ${id}`);
    seen.add(id);
    const s = seasonScore(seed, id);
    if (s > bestScore || (s === bestScore && id < best!)) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

/**
 * Foreign season assigned to a bleed room.
 * Pure function of (seed, roomId), drawn independently of seasonScore, so
 * the season varies across seeds even when the elected room repeats.
 * @param seed Master run seed.
 * @param roomId The session's elected bleed-room id.
 * @returns One of the four seasons.
 */
export function foreignSeason(seed: number, roomId: string): SeasonId {
  return SEASON_IDS[hash2i(seedFromString(roomId), seed, PICK_SALT) % SEASON_IDS.length];
}

/**
 * Full seasonal-bleed assignment for a session's landmark set: exactly one
 * entry - the elected room mapped to its frozen SeasonDescriptor - or an
 * empty map when the session has no landmark rooms.
 * @param seed Master run seed.
 * @param roomIds Landmark room ids known this session; no duplicates.
 * @returns A fresh map with 0 or 1 entries.
 * @throws On duplicate room ids (via pickBleedRoom).
 */
export function sessionSeasonBleeds(
  seed: number,
  roomIds: readonly string[],
): ReadonlyMap<string, SeasonDescriptor> {
  const out = new Map<string, SeasonDescriptor>();
  const winner = pickBleedRoom(seed, roomIds);
  if (winner !== null) out.set(winner, CATALOG[foreignSeason(seed, winner)]);
  return out;
}
