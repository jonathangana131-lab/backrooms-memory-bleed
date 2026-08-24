/**
 * Layout worker entry - BACKROOMS: MEMORY BLEED.
 *
 * Off-thread chunk layout generation behind src/workers/layoutPool.ts.
 * Speaks the pool's postMessage protocol exactly:
 *   receives  LayoutRequest      { id, seed, cx, cz }
 *   replies   LayoutResponse     { id, layout }
 *   or        LayoutErrorResponse { id, error }
 * Replies carry the same payload semantics as the main-thread path in
 * src/world/chunkManager.ts (a full generateLayout() result), so worker and
 * synchronous layouts are interchangeable at every call site.
 *
 * Determinism law compliance: generateLayout() is a pure function of
 * (seed, cx, cz) driven exclusively by rng.ts seeded hashing - no Date.now,
 * no Math.random, no mutable module state - so identical requests always
 * produce byte-identical layouts here and on the main thread
 * (test/worker-test.mjs proves the byte equality across the two paths).
 * Memory-field dressing stays on the calling thread; only the structural
 * layout is generated here.
 *
 * Dependency-light by design: imports only the pure generation pipeline
 * (architect + its data closure) - never game.ts or DOM code - so Vite can
 * bundle this file standalone through the worker-import-meta-url reference
 * in src/workers/layoutPool.ts.
 */
import { generateLayout } from '../world/architect';
import type { ChunkLayout } from '../world/architect';
import type { LayoutRequest } from './layoutPool';

/** Worker -> main success reply (mirrors layoutPool.LayoutResponse). */
interface LayoutResponse {
  /** Correlation id echoed from the request. */
  id: number;
  /** The generated layout. */
  layout: ChunkLayout;
}

/** Worker -> main failure reply (mirrors layoutPool.LayoutErrorResponse). */
interface LayoutErrorResponse {
  /** Correlation id echoed from the request. */
  id: number;
  /** Human-readable failure reason. */
  error: string;
}

/** The slice of the worker global this entry actually touches. */
type WorkerContext = {
  onmessage: ((ev: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(msg: LayoutResponse | LayoutErrorResponse): void;
};

const ctx = self as unknown as WorkerContext;

ctx.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const req = ev.data;
  try {
    const layout = generateLayout(req.seed, req.cx, req.cz);
    ctx.postMessage({ id: req.id, layout });
  } catch (e) {
    ctx.postMessage({
      id: req.id,
      error: e instanceof Error && e.stack ? e.stack : String(e),
    });
  }
};
