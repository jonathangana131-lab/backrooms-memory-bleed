/**
 * Wall cracks — activity-driven progressive damage decals.
 *
 * The Backrooms remember where you lingered. Cracks spread through chunks
 * the player haunted: the longer a chunk has been occupied (cumulative
 * seconds fed via addActivity), the more stress points split its walls.
 * Each crack starts life as a thin hairline and, on subsequent visits
 * after being away for CRACK_AWAY_MS, creeps one stage further — longer,
 * darker, hungrier — exactly like the graffiti-evolution escalation loop.
 *
 * Pure logic + localStorage only — no engine dependencies. Placement is a
 * pure function of (world seed, chunk, slot index, accumulated activity),
 * so any chunk regenerates identically at any time, in any order. The
 * renderer consumes CrackInstance decals ({x, z, rotY, stage}) directly
 * and can call buildCrackGeometry for the jagged trunk-and-branch
 * polylines (dark quads with tapering width) behind each decal.
 */
import { CHUNK_SIZE } from './constants';
import { hash2i, hash3i, RNG } from '../core/rng';

/** Salt so crack hashes never correlate with other hashed features. */
const CRACK_SALT = 0x63a;

/** localStorage bucket holding stages, last-visit times and dwell time. */
export const CRACK_STAGE_KEY = 'bmb-crack-stages';

/** Player must be away from a chunk this long before its cracks grow. */
export const CRACK_AWAY_MS = 5 * 60_000;

/** Cumulative seconds of dwell time that buy one additional crack. */
export const ACTIVITY_SECONDS_PER_CRACK = 45;

/** Hard cap on simultaneous cracks in one chunk (activity cannot exceed). */
export const MAX_CRACKS_PER_CHUNK = 8;

/** Chance an idle (never-visited) chunk shows a given ambient crack slot. */
export const AMBIENT_CRACK_CHANCE = 0.06;

/** Escalation ceiling: stages 0..MAX_STAGE. */
export const MAX_STAGE = 3;

/** Minimum inset of a stress point from the chunk border (metres). */
const EDGE_MARGIN = 1.5;

/** One decal anchored on a wall, compatible with existing decal patterns. */
export interface CrackInstance {
  /** World-space anchor of the stress point (metres). */
  x: number;
  z: number;
  /** Facing rotation around Y, snapped to wall-aligned quarter turns (radians). */
  rotY: number;
  /** Growth stage 0..MAX_STAGE; higher = longer and darker. */
  stage: number;
}

/** One dark quad of a crack polyline in the decal's local wall plane. */
export interface CrackSegment {
  /** Start/end in decal-local coordinates: u runs along the wall, v is height. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Quad half-width at the segment start (tapers toward the tip). */
  width: number;
  /** Darkness 0..1 — how opaque/black the quad renders. */
  dark: number;
}

export interface WallCracks {
  /**
   * All cracks currently visible in chunk (cx, cz) for the given world
   * seed. Deterministic: same inputs, same decals. Also registers the
   * visit and applies any pending stage growth (see CRACK_AWAY_MS).
   */
  generateForChunk(cx: number, cz: number, seed: number): CrackInstance[];
  /**
   * Feed dwell time. Call every tick with the frame delta (or once per
   * second with dt = 1). Time accrues to the chunk containing (x, z);
   * denser activity there means more cracks on the next query.
   */
  addActivity(x: number, z: number, dt?: number): void;
  /** Current cracks for a chunk, generating with a stable fallback seed
   *  if generateForChunk has not been called for it yet. */
  getCracks(cx: number, cz: number): CrackInstance[];
}

interface Persisted {
  v: 1;
  /** slot key '<cx>,<cz>:<index>' → growth stage */
  stages: Record<string, number>;
  /** chunkKey '<cx>,<cz>' → last query timestamp (ms) */
  visits: Record<string, number>;
  /** chunkKey → cumulative dwell seconds */
  activity: Record<string, number>;
}

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function emptyState(): Persisted {
  return { v: 1, stages: {}, visits: {}, activity: {} };
}

function loadState(storage: Storage | null): Persisted {
  try {
    const raw = storage?.getItem(CRACK_STAGE_KEY);
    if (!raw) return emptyState();
    const p = JSON.parse(raw) as Partial<Persisted>;
    const rec = (v: unknown): Record<string, number> =>
      v && typeof v === 'object' ? (v as Record<string, number>) : {};
    return { v: 1, stages: rec(p.stages), visits: rec(p.visits), activity: rec(p.activity) };
  } catch {
    return emptyState();
  }
}

function chunkKeyOf(cx: number, cz: number): string {
  return cx + ',' + cz;
}

function slotKeyOf(chunkKey: string, index: number): string {
  return chunkKey + ':' + index;
}

/** Deterministic per-slot sub-RNG (kept separate from presence hashing). */
function slotRng(cx: number, cz: number, i: number, seed: number): RNG {
  return new RNG(hash3i(cx, cz, i * 7919 + 1, (seed ^ CRACK_SALT) >>> 0));
}

/**
 * Jagged trunk-and-branch geometry for one crack decal, in its local wall
 * plane. Stage stretches the whole pattern (length scale 1 + 0.18/stage)
 * and darkens every quad (+0.12/stage), so revisited rooms visibly worsen.
 * Deterministic given (crack anchor, seed).
 */
export function buildCrackGeometry(crack: CrackInstance, seed = 0): CrackSegment[] {
  const stage = Math.max(0, Math.min(Math.floor(crack.stage), MAX_STAGE));
  const rng = new RNG(hash2i(Math.round(crack.x * 64), Math.round(crack.z * 64), seed ^ CRACK_SALT));
  const lenScale = 1 + 0.18 * stage;
  const dark = Math.min(0.95, 0.5 + 0.12 * stage);

  const segs: CrackSegment[] = [];

  // --- trunk: staggers down-and-sideways from the stress point -------------
  const trunkSteps = 6 + stage * 2;
  let u = 0;
  let v = 0.9; // starts roughly chest-height on the wall plane
  let heading = -Math.PI / 2 + rng.range(-0.35, 0.35); // mostly downward
  const stepLen = 0.22 * lenScale;
  let w = 0.05 * lenScale; // half-width tapers as the crack runs
  const branchAt: number[] = [];
  const branchCount = 2 + rng.int(0, 2); // 2-3 branches
  for (let b = 0; b < branchCount; b++) {
    branchAt.push(rng.range(0.2, 0.7) * trunkSteps);
  }
  branchAt.sort((a, b) => a - b);

  let bi = 0;
  for (let s = 0; s < trunkSteps; s++) {
    heading += rng.range(-0.5, 0.5);
    const nu = u + Math.cos(heading) * stepLen;
    const nv = v + Math.sin(heading) * stepLen;
    segs.push({ u0: u, v0: v, u1: nu, v1: nv, width: w, dark });
    u = nu;
    v = nv;
    w *= 0.88; // width taper toward the tip
    // spawn a branch partway along the trunk
    while (bi < branchAt.length && s === Math.floor(branchAt[bi])) {
      spawnBranch(segs, u, v, heading, rng, stage, lenScale, dark, w);
      bi++;
    }
  }
  return segs;
}

/** One side branch: shorter, thinner, veering off the trunk heading. */
function spawnBranch(
  segs: CrackSegment[],
  ou: number,
  ov: number,
  trunkHeading: number,
  rng: RNG,
  stage: number,
  lenScale: number,
  dark: number,
  trunkWidth: number,
): void {
  const steps = 3 + rng.int(0, 2 + stage);
  let u = ou;
  let v = ov;
  // branches leave at a sharp angle off the trunk heading
  let heading = trunkHeading + (rng.chance(0.5) ? 1 : -1) * rng.range(0.6, 1.2);
  let w = Math.max(0.008, trunkWidth * 0.65);
  const stepLen = 0.16 * lenScale;
  for (let s = 0; s < steps; s++) {
    heading += rng.range(-0.55, 0.55);
    const nu = u + Math.cos(heading) * stepLen;
    const nv = v + Math.sin(heading) * stepLen;
    segs.push({ u0: u, v0: v, u1: nu, v1: nv, width: w, dark });
    u = nu;
    v = nv;
    w *= 0.82;
  }
}

export function createWallCracks(
  now: () => number = () => Date.now(),
  storage: Storage | null = safeStorage(),
): WallCracks {
  const state = loadState(storage);
  let lastSave = 0;
  let dirty = false;

  function flush(force = false): void {
    if (!dirty) return;
    const t = now();
    if (!force && t - lastSave < 5_000) return; // throttle hot addActivity writes
    lastSave = t;
    dirty = false;
    try {
      storage?.setItem(CRACK_STAGE_KEY, JSON.stringify(state));
    } catch {
      // quota/private-mode: growth still works this session, just won't persist
    }
  }

  /**
   * Shared per-chunk entry: registers the visit, advances every slot's
   * stage when the player genuinely returned (away >= CRACK_AWAY_MS),
   * then returns the live crack list for the chunk.
   */
  function ensure(cx: number, cz: number, seed: number): CrackInstance[] {
    const chunkKey = chunkKeyOf(cx, cz);
    const t = now();
    const prev = state.visits[chunkKey];
    state.visits[chunkKey] = t;

    if (prev !== undefined && t - prev >= CRACK_AWAY_MS) {
      const prefix = chunkKey + ':';
      for (const k of Object.keys(state.stages)) {
        if (k.startsWith(prefix)) {
          state.stages[k] = Math.min((state.stages[k] ?? 0) + 1, MAX_STAGE);
        }
      }
      dirty = true;
    }

    const dwell = state.activity[chunkKey] ?? 0;
    const earned = Math.min(MAX_CRACKS_PER_CHUNK, Math.floor(dwell / ACTIVITY_SECONDS_PER_CRACK));

    const out: CrackInstance[] = [];
    for (let i = 0; i < MAX_CRACKS_PER_CHUNK; i++) {
      // ambient slots pepper quiet chunks sparsely; earned slots guarantee
      // density wherever the player actually spent time
      const ambient = hash3i(cx, cz, i, seed ^ CRACK_SALT) / 4294967296 < AMBIENT_CRACK_CHANCE;
      if (!ambient && i >= earned) continue;

      const r = slotRng(cx, cz, i, seed);
      const px = cx * CHUNK_SIZE + EDGE_MARGIN + r.next() * (CHUNK_SIZE - 2 * EDGE_MARGIN);
      const pz = cz * CHUNK_SIZE + EDGE_MARGIN + r.next() * (CHUNK_SIZE - 2 * EDGE_MARGIN);
      const rotY = r.int(0, 4) * (Math.PI / 2);

      const sk = slotKeyOf(chunkKey, i);
      let stage = state.stages[sk];
      if (stage === undefined) {
        stage = 0; // register the slot so future returns know what to deepen
        state.stages[sk] = stage;
        dirty = true;
      }
      out.push({ x: px, z: pz, rotY, stage });
    }
    flush();
    return out;
  }

  return {
    generateForChunk(cx: number, cz: number, seed: number): CrackInstance[] {
      return ensure(cx, cz, seed | 0);
    },

    addActivity(x: number, z: number, dt = 1): void {
      if (!(dt > 0)) return;
      const cx = Math.floor(x / CHUNK_SIZE);
      const cz = Math.floor(z / CHUNK_SIZE);
      const chunkKey = chunkKeyOf(cx, cz);
      state.activity[chunkKey] = (state.activity[chunkKey] ?? 0) + dt;
      dirty = true;
      flush(); // throttled internally
    },

    getCracks(cx: number, cz: number): CrackInstance[] {
      // stable fallback seed derived from the chunk itself, so queries
      // before any generateForChunk call still land on fixed stress points
      return ensure(cx, cz, hash2i(cx, cz, CRACK_SALT ^ 0x51ed));
    },
  };
}

/** Default instance backed by the real localStorage and clock. */
export const wallCracks: WallCracks = createWallCracks();


