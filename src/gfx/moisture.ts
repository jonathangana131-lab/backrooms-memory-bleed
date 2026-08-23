/**
 * Wall moisture — progressive reflective sheen near registered leaks.
 *
 * Wherever a leak is registered (registerLeak), nearby walls slowly grow a
 * subtle damp sheen: a slightly lighter tint quad on the lower half of the
 * wall, rendered at SHEEN_ALPHA (0.06) so it reads as faint specular film
 * rather than paint. The wet radius starts at MIN_RADIUS (0.5 m) and creeps
 * outward to MAX_RADIUS (2 m) across play sessions: every time the player
 * genuinely returns to a chunk after being away for MOISTURE_AWAY_MS, all
 * known leaks soak one stage further — the same away-then-return escalation
 * loop the crack system uses.
 *
 * Persistence mirrors cracks.ts: stages + last-visit timestamps live in the
 * 'bmb-moisture' localStorage bucket, saved throttled and degrading
 * gracefully when storage is unavailable.
 *
 * Pure logic + localStorage only — no engine dependencies. Placement is a
 * pure function of hashed leak coordinates plus the persisted stage, so any
 * chunk regenerates identically at any time, in any order. The renderer
 * consumes QuadInstance decals ({positions, normal, tints}) exactly like
 * CornerAO output: emit quad() from positions/normal, then multiply the four
 * fresh vertices' color channels by tints (>1 values brighten = "lighter").
 */
import { CHUNK_SIZE } from '../world/constants';
import { hash2i, RNG } from '../core/rng';
import type { QuadInstance } from './cornerao';

/** Salt so moisture hashes never correlate with other hashed features. */
const MOISTURE_SALT = 0x6d01;

/** localStorage bucket holding leak growth stages and visit times. */
export const MOISTURE_KEY = 'bmb-moisture';

/** Walls within this distance of a leak develop sheen (metres). */
export const SHEEN_RANGE = 3;

/** Wet radius on first sight of a leak (metres). */
export const MIN_RADIUS = 0.5;
/** Fully soaked radius after MAX_STAGE returns (metres). */
export const MAX_RADIUS = 2;

/** Render alpha of one sheen quad (subtle by contract). */
export const SHEEN_ALPHA = 0.06;

/** Peak brightness lift at the wettest point (tint = 1 + SHEEN_LIFT). */
export const SHEEN_LIFT = 0.08;

/** Vertical extent of the sheen band on the lower wall half (metres). */
export const SHEEN_HEIGHT = 1.3;

/** Player must be away this long before leaks spread further. */
export const MOISTURE_AWAY_MS = 5 * 60_000;

/** Escalation ceiling: stages 0..MAX_STAGE; radius lerps MIN..MAX over it. */
export const MAX_STAGE = 4;

/** Deterministic sheen panels emitted per leak per affected ring slot. */
export const QUADS_PER_LEAK = 4;

/** Gap keeping sheen quads a hair proud of the wall face (no z-fighting). */
const FACE_OFFSET = 0.01;

/**
 * One sheen quad: identical shape to CornerAO's QuadInstance — four
 * world-space corners (a,b,c,d counter-clockwise seen from the normal),
 * shared surface normal, flat per-corner RGB multipliers (values >1
 * brighten; the consumer renders the quad at alpha SHEEN_ALPHA).
 */
export type SheenQuad = QuadInstance;

interface Persisted {
  v: 1;
  /** leak key '<x*100>,<z*100>' -> growth stage */
  stages: Record<string, number>;
  /** chunkKey '<cx>,<cz>' -> last entry timestamp (ms) */
  visits: Record<string, number>;
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
  return { v: 1, stages: {}, visits: {} };
}

function loadState(storage: Storage | null): Persisted {
  try {
    const raw = storage?.getItem(MOISTURE_KEY);
    if (!raw) return emptyState();
    const p = JSON.parse(raw) as Partial<Persisted>;
    const rec = (v: unknown): Record<string, number> =>
      v && typeof v === 'object' ? (v as Record<string, number>) : {};
    return { v: 1, stages: rec(p.stages), visits: rec(p.visits) };
  } catch {
    return emptyState();
  }
}

function leakKeyOf(x: number, z: number): string {
  // quantise to centimetres so float noise never splits one leak in two
  return Math.round(x * 100) + ',' + Math.round(z * 100);
}

function parseLeakKey(key: string): { x: number; z: number } {
  const i = key.indexOf(',');
  return { x: Number(key.slice(0, i)) / 100, z: Number(key.slice(i + 1)) / 100 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Current wet radius for a growth stage (deterministic lerp). */
export function radiusForStage(stage: number): number {
  const s = Math.max(0, Math.min(Math.floor(stage), MAX_STAGE));
  return MIN_RADIUS + ((MAX_RADIUS - MIN_RADIUS) * s) / MAX_STAGE;
}

/**
 * All API surface: register leaks, note chunk entries so leaks spread
 * across sessions, and query the sheen quads that land in one chunk.
 */
export interface WallMoisture {
  /** Declare a leak at world position (x, z). Idempotent per position. */
  registerLeak(x: number, z: number): void;
  /**
   * All sheen quads whose anchor falls inside chunk (cx, cz). Deterministic:
   * same leaks + same persisted stages, same quads.
   */
  getSheensForChunk(cx: number, cz: number): SheenQuad[];
  /**
   * Register the player entering chunkKey ('<cx>,<cz>'). If they were away
   * at least MOISTURE_AWAY_MS, every known leak soaks one stage further.
   */
  noteChunkEntry(chunkKey: string): void;
}

/**
 * Build one vertical wall-plane quad (u along the wall run at angle yaw,
 * y up, n the face normal); corners ordered a,b,c,d CCW from the normal side.
 */
function buildQuad(
  cxw: number,
  czw: number,
  yaw: number,
  width: number,
  y0: number,
  y1: number,
  liftBottom: number,
  liftTop: number,
): SheenQuad {
  const ux = Math.cos(yaw);
  const uz = Math.sin(yaw);
  const nx = -uz;
  const nz = ux;
  const hw = width / 2;
  // push the quad off the wall plane along its normal so it never z-fights
  const ox = nx * FACE_OFFSET;
  const oz = nz * FACE_OFFSET;
  const positions = [
    cxw - ux * hw + ox, y0, czw - uz * hw + oz, // a bottom-left
    cxw + ux * hw + ox, y0, czw + uz * hw + oz, // b bottom-right
    cxw + ux * hw + ox, y1, czw + uz * hw + oz, // c top-right
    cxw - ux * hw + ox, y1, czw - uz * hw + oz, // d top-left
  ];
  // brighter toward the carpet where water collects, feathering upward
  const tint = [1 + liftBottom, 1 + liftBottom, 1 + liftBottom,
                1 + liftTop, 1 + liftTop, 1 + liftTop];
  return { positions, normal: [nx, 0, nz], tints: [...tint, ...tint] };
}

export function createWallMoisture(
  now: () => number = () => Date.now(),
  storage: Storage | null = safeStorage(),
): WallMoisture {
  const state = loadState(storage);
  let lastSave = 0;
  let dirty = false;

  function flush(force = false): void {
    if (!dirty) return;
    const t = now();
    if (!force && t - lastSave < 5_000) return; // throttle hot writes
    lastSave = t;
    dirty = false;
    try {
      storage?.setItem(MOISTURE_KEY, JSON.stringify(state));
    } catch {
      // quota/private-mode: spread still works this session, just won't persist
    }
  }

  return {
    registerLeak(x: number, z: number): void {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const k = leakKeyOf(x, z);
      if (state.stages[k] === undefined) {
        state.stages[k] = 0;
        dirty = true;
        flush();
      }
    },

    noteChunkEntry(chunkKey: string): void {
      const t = now();
      const prev = state.visits[chunkKey];
      state.visits[chunkKey] = t;
      if (prev !== undefined && t - prev >= MOISTURE_AWAY_MS) {
        for (const k of Object.keys(state.stages)) {
          state.stages[k] = Math.min((state.stages[k] ?? 0) + 1, MAX_STAGE);
        }
        dirty = true;
      }


