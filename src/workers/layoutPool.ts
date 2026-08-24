/**
 * LayoutPool: a fixed pool of layout workers behind a promise API.
 *
 * - Spawns WORKER_COUNT module workers (Vite bundles them via the
 *   new Worker(new URL(...), { type: 'module' }) syntax).
 * - requestLayout(seed, cx, cz) resolves with a ChunkLayout.
 * - Requests are dispatched round-robin so two chunks generate in parallel.
 * - Completed layouts are cached by the 'cx,cz' key; repeat requests are
 *   served synchronously from cache without touching a worker.
 *
 * NOTE: cached instances are returned by reference. Treat received layouts
 * as read-only (the mesher/collision readers already do), or copy before
 * mutating.
 */
import type { ChunkLayout } from '../world/architect';
/**
 * Worker postMessage protocol of src/workers/layout.worker.ts. The worker
 * module itself is bundled separately (Vite / esbuild) and is not imported
 * here, so its message types are declared on the pool side.
 */

/** Main -> worker request: generate one chunk layout. */
export interface LayoutRequest {
  /** Correlation id, unique per worker slot. */
  id: number;
  /** World seed driving generation. */
  seed: number;
  /** Chunk X coordinate. */
  cx: number;
  /** Chunk Z coordinate. */
  cz: number;
}

/** Worker -> main success reply. */
export interface LayoutResponse {
  /** Correlation id echoed from the request. */
  id: number;
  /** The generated layout. */
  layout: ChunkLayout;
}

/** Worker -> main failure reply. */
export interface LayoutErrorResponse {
  /** Correlation id echoed from the request. */
  id: number;
  /** Human-readable failure reason. */
  error: string;
}

export const WORKER_COUNT = 2;

interface PendingRequest {
  /** Cache key ('cx,cz') of the originating request, written on resolve. */
  key: string;
  resolve: (layout: ChunkLayout) => void;
  reject: (err: Error) => void;
}

export class LayoutPool {
  private workers: Worker[] = [];
  private nextWorker = 0;
  private nextId = 1;
  /** per-worker correlation id -> pending promise */
  private pending = new Map<number, Map<number, PendingRequest>>();
  /** 'cx,cz' -> completed layout */
  private cache = new Map<string, ChunkLayout>();

  constructor(workerCount: number = WORKER_COUNT) {
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(
        new URL('./layout.worker.ts', import.meta.url),
        { type: 'module' },
      );
      const slots = new Map<number, PendingRequest>();
      this.pending.set(i, slots);
      worker.onmessage = (ev: MessageEvent<LayoutResponse | LayoutErrorResponse>) => {
        const { id } = ev.data;
        const req = slots.get(id);
        if (!req) return;
        slots.delete(id);
        if ('error' in ev.data) req.reject(new Error('layout worker: ' + ev.data.error));
        else {
          // Completed layouts are cached by the request's 'cx,cz' key (see
          // class doc): repeat requests are then served without touching a
          // worker. Cached instances are shared by reference.
          this.cache.set(req.key, ev.data.layout);
          req.resolve(ev.data.layout);
        }
      };
      worker.onerror = (ev: ErrorEvent) => {
        // Worker-level failure (bundle load error, uncaught throw outside a
        // request): fail every outstanding request routed to this worker.
        const err = new Error('layout worker crashed: ' + ev.message);
        for (const req of slots.values()) req.reject(err);
        slots.clear();
      };
      this.workers.push(worker);
    }
  }

  /** Number of live workers in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /**
   * Generate (or fetch from cache) the deterministic layout of one chunk.
   * Resolves off the main thread's generation cost entirely.
   */
  requestLayout(seed: number, cx: number, cz: number): Promise<ChunkLayout> {
    const key = cx + ',' + cz;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);

    // Round-robin across the pool; ids are scoped per worker.
    const workerIndex = this.nextWorker % this.workers.length;
    this.nextWorker++;
    const worker = this.workers[workerIndex];
    const id = this.nextId++;

    return new Promise<ChunkLayout>((resolve, reject) => {
      this.pending.get(workerIndex)!.set(id, { key, resolve, reject });
      const msg: LayoutRequest = { id, seed, cx, cz };
      worker.postMessage(msg);
    });
  }

  /** Cached layout for a chunk, if one has already been generated. */
  peek(cx: number, cz: number): ChunkLayout | undefined {
    return this.cache.get(cx + ',' + cz);
  }

  /** Drop all cached layouts (e.g. on world reseed). Workers stay alive. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Reject everything still in flight and terminate the workers. */
  dispose(): void {
    for (let i = 0; i < this.workers.length; i++) {
      const slots = this.pending.get(i)!;
      for (const req of slots.values()) req.reject(new Error('layout pool disposed'));
      slots.clear();
      this.workers[i].terminate();
    }
    this.workers = [];
    this.cache.clear();
  }
}

/** Shared singleton, created lazily so importing the module is side-effect free. */
let sharedPool: LayoutPool | null = null;

export function getLayoutPool(): LayoutPool {
  if (!sharedPool) sharedPool = new LayoutPool();
  return sharedPool;
}


