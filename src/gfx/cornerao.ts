/**
 * CornerAO: baked fake ambient occlusion at wall-wall junctions.
 *
 * Wherever SOLID wall edges meet at a grid vertex (an L corner, a T junction,
 * a cross, or a free wall end cap), we emit subtle darkening quads onto BOTH
 * wall faces that meet there:
 *
 *  - wall-floor corners: darkest at the carpet, fading out over AO_HEIGHT
 *    (0.6 m) of height,
 *  - wall-ceiling corners: darkest at the ceiling tile line, fading down over
 *    the same band.
 *
 * The darkening peaks at STRENGTH (0.25) right on the corner line and
 * feathers to zero over AO_WIDTH of wall run, so it reads as soft contact
 * shadow rather than painted stripe. Implemented as per-vertex color
 * multipliers on ordinary quads -- the same decal/tint pattern the mesher
 * already uses for baseboards, graffiti and landmark dressing -- so the
 * output drops straight into quad() plus a per-vertex tint pass without new
 * materials.
 *
 * Pure data in / pure data out: deterministic function of the ChunkLayout,
 * no Babylon dependencies, safe to call from workers or tests.
 */
import { CELL, CHUNK_CELLS, WALL_H, WALL_T, EdgeCode } from '../world/constants';
import type { ChunkLayout } from '../world/architect';

/** Vertical extent of the baked shadow band (metres up from floor / down from ceiling). */
export const AO_HEIGHT = 0.6;
/** How far along the wall run the shadow feathers out (metres). */
export const AO_WIDTH = 0.45;
/** Peak darkening factor right at the corner line (0..1; tint = 1 - strength). */
export const AO_STRENGTH = 0.25;
/** Gap keeping AO quads a hair proud of the wall face (no z-fighting). */
export const AO_OFFSET = 0.01;

/**
 * One baked darkening quad: four world-space corners (v0..v3), a surface
 * normal and per-corner RGB multipliers (white = untouched).
 *
 * Corner order matches the mesher's quad() convention: a, b, c, d
 * counter-clockwise seen from the normal side, with uvs implicitly
 * (0,0)(1,0)(1,1)(0,1). A consumer emits the quad then multiplies the four
 * fresh vertices' color channels by tints[v]*rgb -- exactly how
 * tintVerts/applyTint already work.
 */
export interface QuadInstance {
  /** 4 corners x 3 components, flat: [ax,ay,az, bx,by,bz, cx,cy,cz, dx,dy,dz]. */
  positions: number[];
  /** Surface normal shared by all four corners. */
  normal: [number, number, number];
  /** 4 corners x 3 components, flat per-vertex RGB multipliers (1 = neutral). */
  tints: number[];
}

export interface CornerAOOptions {
  /** Peak darkening at the corner line. Default AO_STRENGTH (0.25). */
  strength?: number;
  /** Feather distance along the wall run. Default AO_WIDTH. */
  width?: number;
  /** Shadow band height. Default AO_HEIGHT. */
  height?: number;
}

/** Build the flat tint array for one quad from four scalar brightnesses. */
function tints4(a: number, b: number, c: number, d: number): number[] {
  return [a, a, a, b, b, b, c, c, c, d, d, d];
}

function makeQuad(
  positions: number[],
  normal: [number, number, number],
  tints: number[],
): QuadInstance {
  return { positions, normal, tints };
}

/**
 * Generates baked corner-darkening quads for one chunk.
 *
 * Integrate-ready for the mesher: for each QuadInstance q, call quad(walls,
 * cornerA, cornerB, cornerC, cornerD, q.normal, ...standard uv quartet), then
 * multiply the four fresh vertices' color channels pairwise by q.tints.
 */
export class CornerAO {
  readonly strength: number;
  readonly width: number;
  readonly height: number;

  constructor(opts: CornerAOOptions = {}) {
    this.strength = Math.min(1, Math.max(0, opts.strength ?? AO_STRENGTH));
    this.width = Math.max(0.01, opts.width ?? AO_WIDTH);
    this.height = Math.max(0.01, opts.height ?? AO_HEIGHT);
  }

  /**
   * All AO quads for one chunk. Deterministic: identical layouts produce
   * identical quad lists.
   */
  generateForChunk(layout: ChunkLayout): QuadInstance[] {
    const out: QuadInstance[] = [];
    const N = CHUNK_CELLS;
    const off = WALL_T / 2 + AO_OFFSET;

    /** Floor + ceiling shadow quads on one wall face, anchored at s=anchor
     *  along the wall axis, extending dir units along the run. Horizontal
     *  wall: quads live in an x-y plane at fixed z; vertical wall: z-y plane
     *  at fixed x. faceSign gives the outward face direction. */
    const emitFace = (
      anchor: number,
      plane: number,
      dir: 1 | -1,
      horizontal: boolean,
      faceSign: 1 | -1,
    ): void => {
      const w = this.width * dir;
      const h = this.height;
      const dark = 1 - this.strength;
      const normal: [number, number, number] = horizontal
        ? [0, 0, faceSign]
        : [faceSign, 0, 0];
      // push builds one quad from four (s, y) pairs; s grows along the wall
      // away from the corner, y is height. Tints follow v0..v3 order.
      const push = (
        s0: number, y0: number, s1: number, y1: number,
        s2: number, y2: number, s3: number, y3: number,
        ta: number, tb: number, tc: number, td: number,
      ): void => {
        if (horizontal) {
          out.push(makeQuad(
            [s0, y0, plane, s1, y1, plane, s2, y2, plane, s3, y3, plane],


