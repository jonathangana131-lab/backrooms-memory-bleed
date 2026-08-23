/**
 * Emergency wiring: bridges the streaming mesher's per-chunk fixture
 * announcements to the battery-backed EmergencyLights rig.
 *
 * Game code never constructs EmergencyLights directly - it owns one
 * EmergencyWiring for the whole session:
 *
 *   - LAZY construction: the adapter holds no scene reference until the
 *     first ensureLights(scene), so headless logic (tests, placement
 *     math) can accumulate fixtures long before any Babylon context
 *     exists;
 *   - fixture ACCUMULATION: every announced chunk's fixture list is kept
 *     keyed by (cx, cz); a re-meshed chunk REPLACES its previous list
 *     instead of duplicating units, and at most MAX_TRACKED_CHUNKS stay
 *     resident (oldest evicted first) so streaming through a city never
 *     grows unbounded memory;
 *   - blackout transitions are one forwarded call: frameUpdate(dt,
 *     blackout) reaches the rig whether it exists yet or not.
 *
 * Because unit selection is a pure hash of fixture coordinates, the same
 * chunk always wires exactly the same battery units.
 */

import type { Scene } from '@babylonjs/core/scene';
import { EmergencyLights } from './emergencylights';
import type { FixturePos } from './emergencylights';

/** Hard cap on simultaneously tracked chunks (oldest dropped past this). */
export const MAX_TRACKED_CHUNKS = 64;

/** Stable string key for a chunk coordinate pair. */
export function chunkKeyOf(cx: number, cz: number): string {
  return cx + ',' + cz;
}

export class EmergencyWiring {
  /** Chunk key -> that chunk's most recent ceiling-fixture positions. */
  private readonly chunks = new Map<string, readonly FixturePos[]>([]);

  /** Built on demand by ensureLights(); null until a scene shows up. */
  lights: EmergencyLights | null = null;

  /**
   * Every announced chunk's fixtures concatenated in arrival order
   * (oldest chunk first). This flat list feeds EmergencyLights.prepare,
   * whose deterministic stride picks the battery-backed subset.
   */
  private combinedFixtures(): FixturePos[] {
    const all: FixturePos[] = [];
    for (const fixtures of this.chunks.values()) {
      all.push(...fixtures);
    }
    return all;
  }

  /**
   * Construct the light pool against `scene` exactly once; later calls
   * are no-ops that keep the existing rig. Any fixtures announced before
   * a scene existed are applied here so nothing seen is ever lost.
   */
  ensureLights(scene: Scene): void {
    if (this.lights) return;
    this.lights = new EmergencyLights(scene);
    this.lights.prepare(this.combinedFixtures());
  }

  /**
   * Called by the mesher after chunk (cx, cz) produced its ceiling
   * fixtures. Stores (replacing any earlier list for the same chunk),
   * evicts the oldest chunk past MAX_TRACKED_CHUNKS, and re-binds the
   * live rig to the combined set so newly streamed areas carry backup
   * units too.
   */
  onChunkFixtures(cx: number, cz: number, fixtures: readonly FixturePos[]): void {
    this.chunks.set(chunkKeyOf(cx, cz), fixtures);
    while (this.chunks.size > MAX_TRACKED_CHUNKS) {
      const oldest = this.chunks.keys().next();
      if (oldest.done) break;
      this.chunks.delete(oldest.value);
    }
    this.lights?.prepare(this.combinedFixtures());
  }

  /**
   * Per-frame tick: drive the pulse during a blackout, park everything
   * dark outside one. Safe to call before any scene exists - it simply
   * does nothing until the rig has been ensured.
   */
  frameUpdate(dt: number, blackout: boolean): void {
    this.lights?.update(dt, blackout);
  }

  /**
   * Session teardown / level swap: forget every accumulated chunk and
   * hard-off the rig. The pool itself survives so the next ensure-less
   * cycle can reuse it.
   */
  reset(): void {
    this.chunks.clear();
    this.lights?.deactivate();
  }
}


