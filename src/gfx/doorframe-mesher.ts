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
import type { BoxSpec, Orientation, Tint } from './doorstyles';

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

(Showing lines 1-120 of 166. Use offset=121 to continue.)

