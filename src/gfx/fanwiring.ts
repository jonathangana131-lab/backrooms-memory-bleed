/**
 * Fan wiring: bridges chunk-built notifications to ceiling-fan placement.
 *
 * The mesher announces every finished chunk; FanWiring runs the
 * deterministic placement lottery for that chunk (see ceilingfan.tryPlace),
 * builds the merged fan mesh when the chunk wins, and owns the resulting
 * fans for the rest of their life:
 *
 *   - bounded population: at most MAX_FANS tracked at once, oldest evicted
 *     first so streaming through a city never accumulates unbounded props;
 *   - one-shot batched animation via updateAll(dt);
 *   - distance-based retirement via clearFar(px, pz): anything farther than
 *     CLEAR_RADIUS meters from the player is disposed back to the scene.
 *
 * Because placement is a pure hash of (cx, cz, district), re-visiting a
 * cleared chunk rebuilds exactly the same fan.
 */

import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { CeilingFan, tryPlace } from './ceilingfan';

/** Hard cap on simultaneously tracked fans (oldest disposed past this). */
export const MAX_FANS = 20;

/** Fans farther than this many meters from the player are disposed. */
export const CLEAR_RADIUS = 100;

interface TrackedFan {
  fan: CeilingFan;
  /** Chunk that produced this fan (informational; placement is idempotent). */
  cx: number;
  cz: number;
}

export class FanWiring {
  private readonly scene: Scene;
  private readonly tracked: TrackedFan[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** Number of currently tracked (live) fans. */
  get count(): number {
    return this.tracked.length;
  }

  /** Read-only view of tracked fans (tests/audio coupling). */
  get fans(): readonly CeilingFan[] {
    return this.tracked.map((t) => t.fan);
  }

  /**
   * Called by the mesher after chunk (cx, cz) built as `district`.
   * Runs the deterministic placement gate; when the chunk wins, creates
   * the fan's merged mesh in the scene, tracks it (evicting the oldest
   * beyond MAX_FANS) and returns the mesh. Returns null when the chunk
   * hosts nothing.
   */
  onChunkBuilt(cx: number, cz: number, district: number): Mesh | null {
    const spot = tryPlace(cx, cz, district);
    if (!spot) return null;

    const fan = new CeilingFan(spot.x, spot.z);
    const mesh = fan.createMesh(this.scene);

    this.tracked.push({ fan, cx, cz });
    if (this.tracked.length > MAX_FANS) {
      const oldest = this.tracked.shift();
      if (oldest) {
        oldest.fan.dispose();
      }
    }
    return mesh;
  }

  /**
   * Advance every tracked fan by `dt` seconds. `phase` forwards to each
   * fan's autonomous misbehaviour gate ('calm'|'build'|'peak'|'release').
   */
  updateAll(dt: number, phase?: string): void {
    for (const t of this.tracked) {
      t.fan.update(dt, phase);
    }
  }

  /**
   * Dispose every fan whose mount point lies farther than CLEAR_RADIUS
   * meters from (px, pz); survivors keep animating. Returns how many
   * fans were retired.
   */
  clearFar(px: number, pz: number): number {
    let removed = 0;
    for (let i = this.tracked.length - 1; i >= 0; i--) {
      const t = this.tracked[i];
      const dx = t.fan.x - px;
      const dz = t.fan.z - pz;
      if (dx * dx + dz * dz > CLEAR_RADIUS * CLEAR_RADIUS) {
        t.fan.dispose();
        this.tracked.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** Dispose all tracked fans (scene teardown). */
  disposeAll(): void {
    for (const t of this.tracked) t.fan.dispose();
    this.tracked.length = 0;
  }
}


