/**
 * ChunkDeltas: a reversible per-chunk mutation ledger.
 *
 * Anomaly phenomena (see director/anomalies.ts) may not rewrite generated
 * layouts directly - regeneration from (seed, cx, cz) must stay canonical.
 * Instead they bump a per-chunk drift counter here; chunk builds fold that
 * counter into their decor RNG, so every rebuild of a drifted chunk shows
 * the SAME drifted decor while revertAll() restores the canonical world on
 * the next rebuild. The counter is the only extra input to generation.
 */
import { RNG, hash2i } from '../core/rng';
import type { PropInstance } from './architect';

/** Salt so drift draws never correlate with any other per-chunk feature. */
const DRIFT_SALT = 0x61d7;

/** Furniture the drift is allowed to shuffle (matches landmark rearranging). */
const MOVABLE = new Set<string>([
  'desk', 'chair', 'bench', 'crate', 'stacked_chairs', 'gurney',
  'cabinet', 'sofa', 'bed', 'locker', 'planter', 'tv', 'cooler', 'shelf',
]);

/** Furthest a single drift step may slide one prop (metres). */
export const DRIFT_SLIDE_MAX = 0.45;
export class ChunkDeltas {
  private steps = new Map<string, number>();

  static key(cx: number, cz: number): string {
    return cx + ',' + cz;
  }

  /** Current drift step for a chunk (0 = canonical). */
  step(cx: number, cz: number): number {
    return this.steps.get(ChunkDeltas.key(cx, cz)) ?? 0;
  }

  /** Advance a chunk's drift by one and report the new step. */
  bump(cx: number, cz: number): number {
    const next = this.step(cx, cz) + 1;
    this.steps.set(ChunkDeltas.key(cx, cz), next);
    return next;
  }

  /**
   * Clear every mutation; subsequent rebuilds regenerate canonically.
   * Returns how many chunks were drifted.
   */
  revertAll(): number {
    const n = this.steps.size;
    this.steps.clear();
    return n;
  }

  get size(): number {
    return this.steps.size;
  }
}
/**
 * Re-seed a layout's movable decor deterministically for drift step.
 * Pure function of (props, cx, cz, seed, step): rebuilding a chunk with
 * the same drift always produces the same drifted decor. Returns how many
 * props moved; a step of zero is a no-op, so reverting needs no snapshot.
 */
export function applyDecorDrift(
  props: PropInstance[],
  cx: number,
  cz: number,
  seed: number,
  step: number,
): number {
  if (step <= 0) return 0;
  const rr = new RNG(hash2i(cx, cz, (seed ^ DRIFT_SALT) + Math.imul(step, 0x9e37)));
  let moved = 0;
  for (const p of props) {
    if (!MOVABLE.has(p.kind)) continue;
    p.rot = ((p.rot + rr.int(0, 4)) % 4) as PropInstance['rot'];
    p.variant = (p.variant + rr.int(1, 4)) % 4;
    p.x += (rr.next() - 0.5) * 2 * DRIFT_SLIDE_MAX;
    p.z += (rr.next() - 0.5) * 2 * DRIFT_SLIDE_MAX;
    moved++;
  }
  return moved;
}
