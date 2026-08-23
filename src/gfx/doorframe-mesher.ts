/**
 * Door-frame mesher adapter: converts DoorStyles BoxSpec[] output into
 * mesher.addBox() emissions so district door frame styles reach the mesh.
 *
 * doorstyles.generateForDoorway() returns axis-aligned trim boxes in world
 * space: { x, z, w, h, tint, y? } where x/z is the box CENTER, w its size
 * ALONG THE WALL RUN and h its height above y (default floor). The mesher's
 * addBox signature is addBox(m, x, z, y0, y1, w, d), so this adapter owns
 * three conversions:
 *
 *   1. Vertical span    y0 = spec.y ?? 0, y1 = y0 + spec.h
 *   2. Across-wall span BoxSpec leaves the depth across the wall implied;
 *      consumers expand it symmetrically around the wall plane exactly like
 *      mesher.doorFrame(). We emit d = acrossDepth (default WALL_T plus the
 *      deepest jamb protrusion in the doorstyles tables, 0.08, on each face)
 *      for BOTH orientations, swapping which addBox argument receives the
 *      wall-run width.
 *   3. Orientation      orientation 0 = wall runs along X: spec.w maps to
 *      addBox's w (X extent) and acrossDepth to d (Z extent). Orientation 1 =
 *      wall runs along Z: the two are swapped.
 *
 * Tints propagate through the same vertex-color pass the mesher uses
 * internally (record the vertex count before the box, multiply after):
 * pass optional { vertCount, tint } hooks mirroring positions.length/3 and
 * tintVerts().
 *
 * INTEGRATION SPEC - exact call site in src/world/mesher.ts
 * ---------------------------------------------------------
 * buildChunkGeometry flow today:
 *
 *     addFloor -> addCeiling -> addCeilingGrid ->
 *     addWalls            <-- generic doorFrame() emitted here (lines ~583/~603)
 *     addBaseboards
 *     addFixtures
 *     addProps            <-- props dressing
 *
 * Insert ONE shared adapter instance between addWalls and addProps, i.e.
 * AFTER doorway emission and BEFORE props:
 *
 *     import { DoorFrameMesher } from '../gfx/doorframe-mesher';
 *     import { DoorStyles } from '../gfx/doorstyles';
 *     // ...
 *     addWalls(g, layout);
 *     // District door frame styles: one emission per doorway edge, into the
 *     // walls group so they share the wall material (same as doorFrame()).
 *     const dfMesher = new DoorFrameMesher();
 *     for (const d of layout.doors) {          // see note below
 *       dfMesher.setOrientation(d.orientation);
 *       dfMesher.emit(
 *         DoorStyles.generateForDoorway(d.gx, d.gz, d.orientation, layout.district),
 *         addBox, g.walls,
 *         { vertCount: (m) => m.positions.length / 3, tint: tintVerts },
 *       );
 *     }
 *     addBaseboards(g, layout);
 *     // ...
 *
 * If ChunkLayout gains no explicit doors list, walk the edge arrays exactly
 * like addWalls does: any hEdges/vEdges code that is neither OPEN nor SOLID
 * is a doorway; orientation is 0 for h-edge cells and 1 for v-edge cells,
 * with grid coords gx/gz taken from the same baseX/baseZ + lx/lz walk. The
 * per-doorway emit can equivalently be dropped inline right after the
 * existing doorFrame(...) calls inside addWalls (mesher.ts lines 583 and
 * 603) - the adapter is stateless between emit() calls apart from
 * orientation/acrossDepth, both of which setOrientation()/the constructor
 * control explicitly.
 *
 * Pure logic - no engine dependencies, deterministic, allocation-light.
 */
import { WALL_T } from '../world/constants';
/** Wall-run orientation for a doorway: 0 = along X, 1 = along Z. */
export type Orientation = 0 | 1;

/** RGB tint multiplier triple applied through vertex colors. */
export type Tint = [number, number, number];

/** One frame box emitted by DoorStyles.generateForDoorway(), doorway-centered. */
export interface BoxSpec {
  /** Center column X in meters. */
  x: number;
  /** Center column Z in meters. */
  z: number;
  /** FULL along-wall extent in meters. */
  w: number;
  /** Vertical span in meters, starting at {@link BoxSpec.y}. */
  h: number;
  /** Bottom height above the floor; defaults to 0. */
  y?: number;
  /** Per-box RGB multipliers for the vertex-color pass. */
  tint: Tint;
}

/** Deepest jambOut in the doorstyles family tables (storage angle-iron). */
export const MAX_JAMB_OUT = 0.08;

/** Minimal slice of MeshArrays this module touches. */
export interface MeshLike {
  positions: number[];
}

/** Argument-compatible with mesher.addBox(m, x, z, y0, y1, w, d). */
export type AddBoxFn<M> = (
  mesh: M, x: number, z: number, y0: number, y1: number, w: number, d: number,
) => void;

/** Optional per-box tint hooks mirroring the mesher's tintVerts pattern. */
export interface TintHooks<M> {
  /** Vertex count BEFORE the next emission (positions.length / 3). */
  vertCount: (mesh: M) => number;
  /** Multiply RGB tint into vertices [fromVert, currentEnd). */
  tint: (mesh: M, fromVert: number, r: number, g: number, b: number) => void;
}

export interface DoorFrameMesherOptions {
  /** Wall-run orientation used by emit(); 0 = along X, 1 = along Z. */
  orientation?: Orientation;
  /** Total across-wall depth of every emitted box. */
  acrossDepth?: number;
}

/**
 * Converts BoxSpec[] door frame styles into addBox calls (+optional vertex
 * tints). One instance can serve a whole chunk; setOrientation() switches
 * between X-running and Z-running walls between emissions.
 */
export class DoorFrameMesher {
  private orientation: Orientation;
  private across: number;

  constructor(opts: DoorFrameMesherOptions = {}) {
    this.orientation = opts.orientation ?? 0;
    // Wall thickness plus the deepest jamb protrusion on each face keeps
    // every style (even heavy industrial jambs) clear of the wall plane.
    this.across = opts.acrossDepth ?? WALL_T + 2 * MAX_JAMB_OUT;
  }

  /** Wall-run orientation for subsequent emit() calls. */
  setOrientation(o: Orientation): this {
    this.orientation = o;
    return this;
  }

  /** Across-wall depth override for subsequent emit() calls. */
  setAcrossDepth(depth: number): this {
    this.across = depth;
    return this;
  }

  /**
   * Emit one doorway's frame boxes through an addBox callback.
   *
   * Each BoxSpec's along-wall width lands in addBox's wall-run slot and the
   * instance's across-depth in the other, per the current orientation. When
   * tint hooks are supplied, every box's vertices are multiplied by the
   * spec's RGB tint, mirroring how mesher.tintVerts colors its own frames.
   *
   * @param specs  frame boxes from DoorStyles.generateForDoorway()
   * @param addBox argument-compatible with mesher.addBox
   * @param mesh   target mesh arrays (positions at minimum)
   * @param hooks  optional vertCount/tint pair enabling vertex colors
   */
  emit<M extends MeshLike>(
    specs: readonly BoxSpec[],
    addBox: AddBoxFn<M>,
    mesh: M,
    hooks?: TintHooks<M>,
  ): void {
    for (const spec of specs) {
      const y0 = spec.y ?? 0;
      const y1 = y0 + spec.h;
      const fromVert = hooks ? hooks.vertCount(mesh) : 0;
      if (this.orientation === 0) {
        // Wall runs along X: spec.w is the X extent, across fills Z.
        addBox(mesh, spec.x, spec.z, y0, y1, spec.w, this.across);
      } else {
        // Wall runs along Z: swap the two horizontal extents.
        addBox(mesh, spec.x, spec.z, y0, y1, this.across, spec.w);
      }
      if (hooks) {
        const toVert = hooks.vertCount(mesh);
        if (toVert > fromVert && spec.tint) {
          hooks.tint(mesh, fromVert, spec.tint[0], spec.tint[1], spec.tint[2]);
        }
      }
    }
  }
}
