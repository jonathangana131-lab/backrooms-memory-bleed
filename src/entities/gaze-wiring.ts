/**
 * Per-figure gaze coordination.
 *
 * The human manager owns one GazeController per reconstructed human but
 * should not have to know about update order or cached results. This
 * layer batches the per-frame work: attach/detach controllers by figure
 * id, drive them all from one updateAll() call with the shared player
 * position, and hand back the latest head yaw offset on demand.
 *
 * Pure coordination over a plain Map -- no Babylon deps, matching the
 * GazeController contract it wraps.
 */

import type { GazeController } from "./gaze";

export class GazeWiring {
  private readonly entries = new Map<string, GazeController>();
  /** Latest offset returned by each controller's last update(). */
  private readonly offsets = new Map<string, number>();

  /** Register (or replace) the controller for one figure id. */
  attach(id: string, controller: GazeController): void {
    this.entries.set(id, controller);
    this.offsets.delete(id);
  }

  /** Remove a figure's controller and its cached offset. */
  detach(id: string): void {
    this.entries.delete(id);
    this.offsets.delete(id);
  }

  /**
   * Advance every attached controller one frame against the player at
   * (px, pz). Returns the id -> offset map for this frame; callers may
   * iterate or use getOffset afterwards -- both reflect the same values.
   */
  updateAll(dt: number, px: number, pz: number): Map<string, number> {
    const results = new Map<string, number>();
    for (const [id, controller] of this.entries) {
      // Figure position and body yaw are baked into each controller's
      // owner; the wiring only supplies the shared timestep + player.
      const offset = controller.update(dt, px, pz, 0, 0, 0);
      this.offsets.set(id, offset);
      results.set(id, offset);
    }
    return results;
  }

  /**
   * Latest offset stored for a figure, in radians relative to its body
   * yaw. Undefined until the first updateAll() after attach, and after
   * detach.
   */
  getOffset(id: string): number | undefined {
    return this.offsets.get(id);
  }

  /** Drop every attached controller and cached offset. */
  dispose(): void {
    this.entries.clear();
    this.offsets.clear();
  }
}


