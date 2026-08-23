/**
 * perfmarks - zero-overhead performance instrumentation.
 *
 * Thin wrappers over the standard performance.mark()/measure() timeline APIs,
 * plus rolling per-section statistics (count, avg, min, max, p95) kept in a
 * fixed-size ring buffer so memory never grows unboundedly.
 *
 * Overhead contract: while FLAGS.ENABLED is false every public method is a
 * single boolean check and an immediate return - safe to leave call sites in
 * hot loops (chunk builds, lighting, humans, render frame).
 */

/** Number of recent samples retained per section for percentile math. */
const RING_CAPACITY = 100;

/**
 * Global kill switch. Flipping this off makes every mark/measure call a
 * single-boolean no-op. Starts disabled; profiling code should opt in.
 */
export const FLAGS = { ENABLED: false };

/** Convenience setter for the global flag. */
export function setEnabled(on: boolean): void {
  FLAGS.ENABLED = on;
}

/** Pre-defined tracked sections. Values are stable strings used as mark names. */
export const SECTION = {
  CHUNK_BUILD: 'chunk.build',
  LIGHTING_UPDATE: 'lighting.update',
  HUMANS_UPDATE: 'humans.update',
  MEM_TICK: 'mem.tick',
  INTERACTION: 'interaction',
  RENDER_FRAME: 'render.frame',
} as const;

export type SectionName = (typeof SECTION)[keyof typeof SECTION];

/** Rolling statistics for one section. */
export interface SectionStats {
  readonly name: string;
  /** Lifetime number of completed measures (never rolls off). */
  readonly count: number;
  /** Mean duration in ms over the retained sample window. */
  readonly avg: number;
  /** Slowest observed duration in ms (windowed). */
  readonly max: number;
  /** Fastest observed duration in ms (windowed). */
  readonly min: number;
  /** 95th-percentile duration in ms over the retained window. */
  readonly p95: number;
}

interface Ring {
  /** Fixed-capacity sample storage; oldest entries are overwritten. */
  samples: number[];
  head: number;
  filled: number;
  /** Lifetime completed-measure count. */
  count: number;
  /** Running sum over the current window (for cheap avg). */
  sum: number;
  min: number;
  max: number;
}

const rings = new Map<string, Ring>();

function ringFor(name: string): Ring {
  let r = rings.get(name);
  if (r === undefined) {
    r = { samples: new Array<number>(RING_CAPACITY), head: 0, filled: 0, count: 0, sum: 0, min: Infinity, max: 0 };
    rings.set(name, r);
  }
  return r;
}

function record(name: string, ms: number): void {
  const r = ringFor(name);
  if (r.filled === RING_CAPACITY) r.sum -= r.samples[r.head];
  r.samples[r.head] = ms;
  r.head = (r.head + 1) % RING_CAPACITY;
  if (r.filled < RING_CAPACITY) r.filled++;
  r.sum += ms;
  r.count++;
  if (ms < r.min) r.min = ms;
  if (ms > r.max) r.max = ms;
}

/**
 * Drop-in start marker. Returns a monotonic timestamp usable as the startMark
 * argument to measure(), or -1 when disabled.
 */
export function mark(name: string): number {
  if (!FLAGS.ENABLED) return -1;
  const t = performance.now();
  // Best-effort DevTools timeline entry; never let it break gameplay.
  try {
    performance.mark(name);
  } catch {
    /* ignore */
  }
  return t;
}

/**
 * Close a measurement started by mark(). Returns the elapsed time in
 * milliseconds and feeds the rolling stats. Accepts either the numeric
 * timestamp returned by mark() or the string name of a previously placed
 * mark. Returns -1 when disabled.
 */
export function measure(name: string, startMark: string | number): number {
  if (!FLAGS.ENABLED) return -1;
  let ms: number;
  if (typeof startMark === 'number') {
    ms = Math.max(0, performance.now() - startMark);
    try {
      performance.measure(name, { start: startMark });
    } catch {
      /* ignore */
    }
  } else {
    try {
      const m = performance.measure(name, startMark);
      ms = m.duration;
    } catch {
      return -1; // dangling start mark - nothing sensible to record
    }
  }
  record(name, ms);
  return ms;
}

/** Raw retained samples for a section (oldest first). Copy - caller-safe. */
export function samples(name: string): number[] {
  const r = rings.get(name);
  if (r === undefined || r.filled === 0) return [];
  const out: number[] = [];
  const start = r.filled < RING_CAPACITY ? 0 : r.head;
  for (let i = 0; i < r.filled; i++) out.push(r.samples[(start + i) % RING_CAPACITY]);
  return out;
}

/** Statistics for one section, or null when it has never been measured. */
export function statsFor(name: string): SectionStats | null {
  const r = rings.get(name);
  if (r === undefined || r.filled === 0) return null;
  const sorted = samples(name).slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return {
    name,
    count: r.count,
    avg: r.sum / r.filled,
    min: r.min,
    max: r.max,
    p95: sorted[idx],
  };
}

/** Statistics for every tracked section that has data. */
export function stats(): SectionStats[] {
  const out: SectionStats[] = [];
  for (const name of rings.keys()) {
    const s = statsFor(name);
    if (s !== null) out.push(s);
  }
  return out;
}

function fmt(ms: number): string {
  return ms.toFixed(3);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padL(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Human-readable table of all tracked sections. Empty-state friendly. */
export function report(): string {
  const rows = stats();
  if (rows.length === 0) return 'perfmarks: no samples collected';
  const header = pad('section', 18) + padL('count', 8) + padL('avg', 11) + padL('min', 11) + padL('max', 11) + padL('p95', 11);
  const lines = [header, '-'.repeat(header.length)];
  for (const s of rows) {
    lines.push(
      pad(s.name, 18) +
        padL(String(s.count), 8) +
        padL(fmt(s.avg) + 'ms', 11) +
        padL(fmt(s.min) + 'ms', 11) +
        padL(fmt(s.max) + 'ms', 11) +
        padL(fmt(s.p95) + 'ms', 11),
    );
  }
  return lines.join('\n');
}

/** Clear all marks, samples and statistics. Does not change ENABLED. */
export function reset(): void {
  rings.clear();
  try {
    performance.clearMarks();
    performance.clearMeasures();
  } catch {
    /* ignore */
  }
}


