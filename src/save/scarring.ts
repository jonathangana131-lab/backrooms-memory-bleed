/**
 * F44 Save-file scarring — phantom cracks shaped like the routes a save
 * actually walked.
 *
 * A mesher/render pass consumes ScarCrack descriptors from this pure
 * module; nothing here touches Babylon, storage or game state. Inputs are
 * injected: the save id, a route-history sample list ({x,z,t}) and an age
 * metric (session count + playtime). All randomness flows through
 * src/core/rng.ts hashes, so the same inputs regenerate byte-identical
 * scars at any time.
 *
 * Prefix stability: the route is cut into fixed-size batches and each
 * batch's cracks depend ONLY on that batch's samples plus its index. The
 * trailing partial batch produces nothing until it closes, so appending a
 * suffix to the route never mutates an existing crack - the suffix can
 * only ADD new ones. Density scales monotonically with the age metric:
 * a global crack budget grows with sessions/playtime and fills batch
 * slots in order, so older saves simply have more (and deeper) scars,
 * capped hard by MAX_SCAR_CRACKS.
 */
import { RNG, hash2i, hash3i, seedFromString } from '../core/rng';

/** Salt so scar draws never correlate with any other hashed feature. */
export const SCAR_SALT = 0x5ca2;

/** World-space size of one visited cell a crack may thread through (metres). */
export const SCAR_CELL = 6;

/** Route samples per closed batch; only closed batches scar. */
export const ROUTE_BATCH = 24;

/** Global ceiling on cracks per save - scarring is bounded no matter what. */
export const MAX_SCAR_CRACKS = 256;

/** Most cracks a single batch may carry. */
export const MAX_CRACKS_PER_BATCH = 4;

/** Most polyline vertices a single crack may have. */
export const MAX_POLYLINE_POINTS = 12;

/** Sessions that buy one extra crack in the global budget. */
export const SESSIONS_PER_CRACK = 2;

/** Seconds of playtime that buy one extra crack in the global budget. */
export const SECONDS_PER_CRACK = 300;

/** Max perpendicular jitter of a vertex off its cell centre (metres). */
export const SCAR_JITTER_MAX = SCAR_CELL * 0.35;

/** One sampled point of the player's route history. */
export interface RouteSample {
  x: number;
  z: number;
  /** Sample timestamp (ms); ordering defines the walk direction. */
  t: number;
}

/** Age metric of a save; larger values mean more (and deeper) scarring. */
export interface SaveAge {
  /** Completed expedition count recorded for the save. */
  sessions: number;
  /** Cumulative playtime in seconds. */
  playtimeSec: number;
}

/** One phantom crack: a polyline through visited cells with seeded jitter. */
export interface ScarCrack {
  /** Stable id, derived from (saveIdSeed, batchIndex, slotIndex). */
  id: string;
  /** Chunk-space cell coordinates of the anchor vertex. */
  cellX: number;
  cellZ: number;
  /** World-space polyline vertices in route order (x/z metres). */
  points: { x: number; z: number }[];
  /** Relative line width 0..1 for the consuming mesher. */
  width: number;
  /** Visual depth 0..1; grows with the save's age metric. */
  depth: number;
}

/** Clamp to [lo, hi] without surprising NaN behaviour (NaN -> lo). */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Drop unusable samples so hostile/partial save payloads cannot poison
 * generation; order is otherwise preserved.
 */
function sanitizeRoute(route: readonly RouteSample[]): RouteSample[] {
  return route.filter(
    (s) =>
      Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.t),
  );
}

/**
 * Global crack budget as a pure function of the age metric. Monotone
 * nondecreasing in both inputs; 0 for a fresh save.
 */
export function scarBudget(age: SaveAge): number {
  const fromSessions = Math.floor(
    Math.max(0, age.sessions) / SESSIONS_PER_CRACK,
  );
  const fromPlaytime = Math.floor(
    Math.max(0, age.playtimeSec) / SECONDS_PER_CRACK,
  );
  return Math.min(MAX_SCAR_CRACKS, fromSessions + fromPlaytime);
}

/** Cracks assigned to batch `batchIndex` given the global budget. */
function cracksForBatch(budget: number, batchIndex: number): number {
  return clamp(budget - batchIndex * MAX_CRACKS_PER_BATCH, 0, MAX_CRACKS_PER_BATCH);
}

/** Round to millimetres so serialized descriptors stay compact and stable. */
function mm(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Derive all scars for a save. Pure function of
 * (saveId, sanitized route batches, age): identical inputs produce deep-
 * identical output; a longer route with the same prefix keeps every prior
 * crack bit-identical and can only append new ones.
 * @param saveId Stable save identifier (keys every hash).
 * @param route Route-history samples in chronological order.
 * @param age Save age metric driving crack density and depth.
 */
export function computeScars(
  saveId: string,
  route: readonly RouteSample[],
  age: SaveAge,
): ScarCrack[] {
  const clean = sanitizeRoute(route);
  const saveIdSeed = seedFromString(saveId);
  const budget = scarBudget(age);
  const scars: ScarCrack[] = [];
  const batches = Math.floor(clean.length / ROUTE_BATCH);
  for (let b = 0; b < batches; b++) {
    const count = cracksForBatch(budget, b);
    if (count <= 0) continue;
    const batch = clean.slice(b * ROUTE_BATCH, (b + 1) * ROUTE_BATCH);
    for (let j = 0; j < count; j++) {
      // Every draw keys on (batch, slot) only - never on other batches,
      // total route length, or anything a suffix could alter.
      const seed = hash3i(b, j, (saveIdSeed ^ SCAR_SALT) >>> 0);
      const rr = new RNG(seed);
      const anchorIdx = seed % batch.length;
      const points: { x: number; z: number }[] = [];
      let prevCellX = NaN;
      let prevCellZ = NaN;
      for (let k = anchorIdx; k < batch.length && points.length < MAX_POLYLINE_POINTS; k++) {
        const s = batch[k];
        const cellX = Math.floor(s.x / SCAR_CELL);
        const cellZ = Math.floor(s.z / SCAR_CELL);
        if (cellX === prevCellX && cellZ === prevCellZ) continue;
        prevCellX = cellX;
        prevCellZ = cellZ;
        // Per-vertex jitter keyed on (seed, sample index) stays stable
        // even when the same cell is revisited later in the batch.
        const jr = new RNG(hash2i(seed, k));
        points.push({
          x: mm(cellX * SCAR_CELL + SCAR_CELL / 2 + (jr.next() - 0.5) * 2 * SCAR_JITTER_MAX),
          z: mm(cellZ * SCAR_CELL + SCAR_CELL / 2 + (jr.next() - 0.5) * 2 * SCAR_JITTER_MAX),
        });
      }
      if (points.length === 1) {
        // Single-cell haunts still scar: emit a short hairline inside
        // the cell so the mesher always receives a segment.
        points.push({
          x: mm(points[0].x + (rr.next() - 0.5) * SCAR_JITTER_MAX),
          z: mm(points[0].z + (rr.next() - 0.5) * SCAR_JITTER_MAX),
        });
      }
      scars.push({
        id: 'scar-' + b + '-' + j,
        cellX: Math.floor(batch[anchorIdx].x / SCAR_CELL),
        cellZ: Math.floor(batch[anchorIdx].z / SCAR_CELL),
        points,
        width: mm(0.3 + rr.next() * 0.7),
        depth: mm(clamp(0.15 + (budget / MAX_SCAR_CRACKS) * 0.85, 0, 1)),
      });
    }
  }
  return scars;
}

/**
 * Serialize a scar list to JSON. Round-trips through parseScars into a
 * deep-identical list.
 */
export function serializeScars(scars: readonly ScarCrack[]): string {
  return JSON.stringify({ version: 1, scars });
}

/**
 * Parse a payload produced by serializeScars.
 * @returns The scar list, or null when the payload is unparseable or not
 *   a version-1 archive - callers decide whether to regenerate instead.
 */
export function parseScars(json: unknown): ScarCrack[] | null {
  let val: unknown = json;
  if (typeof json === 'string') {
    try {
      val = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  const obj = val as { version?: unknown; scars?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.scars)) return null;
  return obj.scars as ScarCrack[];
}
