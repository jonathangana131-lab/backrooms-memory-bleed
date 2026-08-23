/**
 * Main-thread layout cache - BACKROOMS: MEMORY BLEED.
 *
 * Memoizes ChunkLayouts produced by generateLayout()/the layout workers so
 * repeated requests for the same (seed, cx, cz) never pay generation cost
 * twice. Every payload is validated before it enters the map:
 *
 * - isValidLayout rejects structurally non-conforming layouts (a crashed
 *   or mid-reseed worker can post garbage);
 * - verifyRoundTrip proves the payload survives a structured clone, the
 *   same transfer path workers use, before we trust it as cacheable.
 *
 * Rejected writes are warnings, never throws: the worst case is that an
 * uncached layout regenerates.
 *
 * NOTE: reconstruction — the read/maintenance surface below
 * (INVENTED:get, has, invalidate, clear, size, maxEntries) was rebuilt
 * without slice evidence around the surviving put()/singleton fragments.
 */
import type { ChunkLayout } from '../world/architect';
import { CHUNK_CELLS } from '../world/constants';

/** Horizontal wall-edge samples per chunk: (CHUNK_CELLS + 1) rows x CHUNK_CELLS cols. */
const H_LEN = (CHUNK_CELLS + 1) * CHUNK_CELLS;

/** Vertical wall-edge samples per chunk: CHUNK_CELLS rows x (CHUNK_CELLS + 1) cols. */
const V_LEN = CHUNK_CELLS * (CHUNK_CELLS + 1);

/** Cache-entry ceiling so marathon sessions cannot grow the map unbounded. */
const MAX_ENTRIES = 512;

/** Canonical map key for one generated chunk under one seed. */
function cacheKey(seed: number, cx: number, cz: number): string {
  return seed + ':' + cx + ',' + cz;
}

function warn(msg: string): void {
  console.warn('[layout-cache] ' + msg);
}

/** True when `arr` is exactly `len` bytes of Uint8Array. */
function isByteArray(arr: unknown, len: number): arr is Uint8Array {
  return arr instanceof Uint8Array && arr.length === len;
}

/**
 * Structural conformance check mirroring the ChunkLayout contract. Only
 * fields the mesher reads unconditionally are enforced; optional dressing
 * fields are accepted in any state.
 */
function isValidLayout(layout: unknown): layout is ChunkLayout {
  if (typeof layout !== 'object' || layout === null) return false;
  const l = layout as Partial<ChunkLayout>;
  if (typeof l.cx !== 'number' || !Number.isFinite(l.cx)) return false;
  if (typeof l.cz !== 'number' || !Number.isFinite(l.cz)) return false;
  if (typeof l.district !== 'number') return false;
  if (!isByteArray(l.hEdges, H_LEN)) return false;
  if (!isByteArray(l.vEdges, V_LEN)) return false;
  const listFields = ['lights', 'props', 'signs', 'notes', 'puddles', 'wires', 'stains', 'graffiti'] as const;
  for (const f of listFields) {
    if (!Array.isArray(l[f])) return false;
  }
  if (typeof l.memKind !== 'number') return false;
  if (typeof l.memIntensity !== 'number' || !Number.isFinite(l.memIntensity)) return false;
  return true;
}

/** True when both sides are byte-identical Uint8Arrays of the same length. */
function sameBytes(a: unknown, b: unknown): boolean {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Prove the payload survives the structured-clone transfer every worker
 * message goes through; a layout that corrupts in transit would poison
 * every later cache hit.
 */
function verifyRoundTrip(layout: ChunkLayout): boolean {
  try {
    const copy = structuredClone(layout);
    return copy.cx === layout.cx
      && copy.cz === layout.cz
      && sameBytes(copy.hEdges, layout.hEdges)
      && sameBytes(copy.vEdges, layout.vEdges);
  } catch {
    // structuredClone refused the payload (non-cloneable field): the write
    // cannot be trusted, and regeneration is always safe.
    return false;
  }
}

export class LayoutCache {
  /** Active seed; entries generated under other seeds stay addressable. */
  seed: number;

  /** 'seed:cx,cz' -> completed layout */
  private entries = new Map<string, ChunkLayout>();

  constructor(seed?: number) {
    this.seed = typeof seed === 'number' && Number.isFinite(seed) ? seed : NaN;
  }

  /**
   * Completed layout for a chunk under `seed` (default: the active seed),
   * or undefined when that chunk has never been cached.
   */
  get(cx: number, cz: number, seed?: number): ChunkLayout | undefined {
    const s = seed ?? this.seed;
    if (typeof s !== 'number' || !Number.isFinite(s)) return undefined;
    return this.entries.get(cacheKey(s, cx, cz));
  }

  /** True when a completed layout is already cached for the chunk. */
  has(cx: number, cz: number, seed?: number): boolean {
    return this.get(cx, cz, seed) !== undefined;
  }

  /** Drop one chunk's cached layout (e.g. after an edit dirties it). */
  invalidate(cx: number, cz: number, seed?: number): void {
    const s = seed ?? this.seed;
    if (typeof s !== 'number' || !Number.isFinite(s)) return;
    this.entries.delete(cacheKey(s, cx, cz));
  }

  /** Drop every cached layout (e.g. on world reseed). */
  clear(): void {
    this.entries.clear();
  }

  /** Number of cached layouts across all seeds. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Store one generated layout under its chunk coordinates. Validation
   * failures downgrade to warnings and skip the write: a rejected payload
   * only costs regeneration time, and when a caller races a reseed such
   * that an uncached layout regenerates, it must not crash the caller.
   *
   * @throws only when no seed is available from either argument or
   *         constructor - a seedless write could never be addressed.
   */
  async put(layout: ChunkLayout, seed?: number): Promise<void> {
    const s = seed ?? this.seed;
    if (typeof s !== 'number' || !Number.isFinite(s)) {
      throw new Error("layout-cache: put() needs a seed (argument or constructor)");
    }
    if (!isValidLayout(layout)) {
      const bad = layout as Partial<ChunkLayout> | undefined;
      warn("put(): rejected non-conforming layout for " + cacheKey(s, bad?.cx ?? NaN, bad?.cz ?? NaN));
      return;
    }
    if (!verifyRoundTrip(layout)) {
      warn("put(): structured-clone round-trip mismatch, skipping cache write");
      return;
    }
    this.entries.set(cacheKey(s, layout.cx, layout.cz), layout);
    // FIFO eviction off the Map's insertion order keeps the footprint flat.
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/** Shared singleton, created lazily so importing the module is side-effect free. */
let shared: LayoutCache | null = null;

export function getLayoutCache(seed?: number): LayoutCache {
  if (!shared) shared = new LayoutCache(seed);
  else if (seed !== undefined) shared.seed = seed;
  return shared;
}
