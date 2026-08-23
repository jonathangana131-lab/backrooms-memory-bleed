/**
 * Ceiling inspection details: what you only see when you look UP.
 *
 * Most players never raise their view in the Backrooms -- so the ceiling is
 * where the level talks back. Two rare dressing features:
 *
 *   1. MISSING TILES -- one suspended-ceiling tile gone, showing a pure black
 *      recessed void 0.1 m above the plane. The grid grooves drawn by the
 *      mesher (addCeilingGrid) bound each tile, so the hole reads as exactly
 *      one groove-bounded cell.
 *
 *   2. WRITING ON TILES -- rare handwritten scrawl on a single tile ("THEY
 *      COUNT", "42", "DON'T"...), rendered at runtime through a canvas
 *      texture (writingCanvasSpec gives the renderer everything it needs).
 *
 * PLACEMENT / PITCH HEURISTIC
 * A camera only pitches up while standing still mid-room -- hugging walls,
 * people look forward along them. So details only generate near the CHUNK
 * CENTER in fully open runs of cells: every edge bounding the host cell must
 * be OPEN or DOORWAY (never SOLID), and no live light fixture may sit inside
 * the upward sight line. Chunks whose center band is walled get nothing.
 *
 * DETERMINISM
 * Hash-based like every other dressing pass: ~8% of chunks win exactly ONE
 * detail; the type (missing vs writing) varies by a second hash draw, with
 * writing deliberately rarer. The same (layout, seed) always produces the
 * same array, and repeated calls replace rather than append.
 *
 * Pure data + logic -- no Babylon dependency (mirrors neonsign.ts). The
 * mesher consumes CeilingDetailInstance directly in its ceiling pass:
 * missing tiles emit a downward-facing black quad recessed VOID_DEPTH below
 * the ceiling plane; writing tiles emit a downward-facing textured quad just
 * beneath the grooves. Both face DOWN ([0,-1,0]) because that is the side
 * you inspect.
 */

import type { ChunkLayout } from './architect';

// --- mirrored constants (keeps the module dependency-free for tests) --------
/** Grid cell size in meters (mirrors constants.CELL). */
const CELL = 2.5;
/** Cells per chunk side (mirrors constants.CHUNK_CELLS). */
const CHUNK_CELLS = 12;
/** Floor(0) to ceiling height (mirrors constants.WALL_H). */
export const WALL_H = 3.05;
/** EdgeCode.SOLID (mirrors constants.EdgeCode). */
const EDGE_SOLID = 1;

/** Private salt so ceiling details never correlate with any other feature. */
export const CEILING_DETAIL_SALT = 0xce11;

/** How far the void floor of a missing tile sits below the ceiling plane. */
export const VOID_DEPTH = 0.1;
/** Writing quads hang a hair below the ceiling so they never z-fight. */
export const WRITING_DROP = 0.006;
/** Half-width of the mesher's recessed grid lines (mesher.GRID_HALF_W). */
const GRID_HALF_W = 0.016;

/** Roughly this percent of chunks carry exactly one ceiling detail. */
export const DETAIL_CHUNK_RATE = 8;
/** Of those, this percent are writing; the rest are missing tiles. */
export const WRITING_SHARE = 30;

/** Handwritten messages found overhead. */
export const WRITING_TEXTS: readonly string[] = [
  'THEY COUNT',
  '42',
  "DON'T",
  'NOT EMPTY',
  'LOOK UP',
];

/** One missing ceiling tile: a pure black quad recessed into the void. */
export interface MissingTileDetail {
  kind: 'missing';
  /** world-space center of the opening */
  x: number;
  z: number;
  /** height of the void floor: WALL_H - VOID_DEPTH */
  y: number;
  /** full span of the tile opening (one groove-bounded cell) */
  size: number;
}

/** Handwritten scrawl rendered onto a single tile via canvas texture. */
export interface WritingTileDetail {
  kind: 'writing';
  /** world-space center of the written tile */
  x: number;
  z: number;
  /** quad height just below the ceiling plane: WALL_H - WRITING_DROP */
  y: number;
  /** quad size in meters (kept inside one tile) */
  width: number;
  height: number;
  text: string;
  /** per-instance seed for hand-jitter in the canvas renderer */
  seed: number;
  /** slight tilt (radians) so the hand looks human */
  tilt: number;
}

export type CeilingDetailInstance = MissingTileDetail | WritingTileDetail;

/**
 * Attach ceiling inspection data to a chunk layout. The mesher's ceiling
 * pass reads layout.ceilingDetails alongside stains/grid geometry.
 */
declare module './architect' {
  export interface ChunkLayout {
    /** ceiling inspection details generated for this chunk (0 or 1 items) */
    ceilingDetails?: CeilingDetailInstance[];
  }
}

// --- deterministic hashing (local copies so the module stays dependency-free)

function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(a: number, b: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(a | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(b | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

function frac(h: number): number {
  return h / 4294967296;
}

/** Is the given local cell open on all four sides (pitch-sightable)? */
function cellIsOpen(layout: ChunkLayout, lx: number, lz: number): boolean {
  const N = CHUNK_CELLS;
  const he = layout.hEdges, ve = layout.vEdges;
  if (!he || !ve) return false;
  if (he[lz * N + lx] === EDGE_SOLID) return false;             // north
  if (he[(lz + 1) * N + lx] === EDGE_SOLID) return false;       // south
  if (ve[lz * (N + 1) + lx] === EDGE_SOLID) return false;       // west
  if (ve[lz * (N + 1) + lx + 1] === EDGE_SOLID) return false;   // east
  return true;
}

/** No fixture hanging inside the upward sight cone of the cell center. */
function sightLineClear(layout: ChunkLayout, wx: number, wz: number): boolean {
  for (const l of layout.lights ?? []) {
    if (Math.hypot(l.x - wx, l.z - wz) < 1.35) return false;
  }
  return true;
}

/**
 * Pick the host cell for this chunk's ceiling detail, or null.
 * Central band only (players stand mid-room to look up), openness-gated,
 * ranked deterministically by hash so ties never flip between builds.
 */
function pickHostCell(
  layout: ChunkLayout, cx: number, cz: number, seed: number,
): { lx: number; lz: number } | null {
  const N = CHUNK_CELLS;
  // central band: cells whose centers lie in the middle third of the chunk
  const lo = Math.ceil(N * 0.32);
  const hi = Math.floor(N * 0.68);
  const rank = hash2(cx, cz, seed ^ (CEILING_DETAIL_SALT << 1)) >>> 4;
  let best: { lx: number; lz: number; score: number } | null = null;
  for (let lz = lo; lz < hi; lz++) {
    for (let lx = lo; lx < hi; lx++) {
      if (!cellIsOpen(layout, lx, lz)) continue;
      const wx = (cx * N + lx + 0.5) * CELL;
      const wz = (cz * N + lz + 0.5) * CELL;
      if (!sightLineClear(layout, wx, wz)) continue;
      // prefer cells nearest the chunk center; hash breaks exact ties
      const dc = (lx + 0.5 - N / 2) ** 2 + (lz + 0.5 - N / 2) ** 2;
      const score = dc * 1024 + ((rank >> ((lz * N + lx) % 12)) & 15);
      if (!best || score < best.score) best = { lx, lz, score };
    }
  }
  return best ? { lx: best.lx, lz: best.lz } : null;
}

/**
 * Compute the single ceiling detail for one chunk (or null).
 * Pure function of (layout geometry, seed, chunk coords).
 */
export function ceilingDetailFor(
  layout: ChunkLayout, seed: number,
): CeilingDetailInstance | null {
  const cx = layout.cx, cz = layout.cz;
  const gate = hash2(cx, cz, seed ^ CEILING_DETAIL_SALT) % 100;
  if (gate >= DETAIL_CHUNK_RATE) return null;

  const host = pickHostCell(layout, cx, cz, seed);
  if (!host) return null;
  const N = CHUNK_CELLS;

  // deterministic sub-cell jitter, kept off the grooves
  const jx = 0.3 + frac(hash2(cx * 31 + host.lx, cz * 17 + host.lz, seed ^ 0x7e11)) * 0.4;
  const jz = 0.3 + frac(hash2(cx * 13 + host.lz, cz * 29 + host.lx, seed ^ 0x7e12)) * 0.4;
  const x = (cx * N + host.lx + jx) * CELL;
  const z = (cz * N + host.lz + jz) * CELL;

  const typeDraw = hash2(cx, cz, seed ^ (CEILING_DETAIL_SALT | 0x77)) % 100;
  if (typeDraw < WRITING_SHARE) {
    const wi = hash2(cx, cz, seed ^ 0x4041) % WRITING_TEXTS.length;
    const text = WRITING_TEXTS[wi];
    const width = Math.min(1.9, text.length * 0.17 + 0.28);
    return {
      kind: 'writing',
      x, z,
      y: WALL_H - WRITING_DROP,
      width,
      height: 0.52,
      text,
      seed: hash2(cx, cz, seed ^ 0xb00c),
      tilt: (frac(hash2(cx, cz, seed ^ 0x71)) - 0.5) * 0.12,
    };
  }

  // missing tile: exactly one groove-bounded cell of ceiling is gone
  return {
    kind: 'missing',
    x, z,
    y: WALL_H - VOID_DEPTH,
    size: CELL - GRID_HALF_W * 2,
  };
}

/**
 * API entry point: attach deterministic ceiling inspection details to a
 * chunk layout. Assigns (never appends) so calls are idempotent -- rebuilds
 * produce identical data. Call after generateLayout, before meshing.
 */
export function addCeilingDetails(layout: ChunkLayout, seed: number): void {
  const d = ceilingDetailFor(layout, seed);
  layout.ceilingDetails = d ? [d] : [];
}

// --- renderer helpers --------------------------------------------------------

/**
 * Downward-facing quad corners (CCW as seen from below) for a missing-tile
 * void, plus its declared normal. The mesher emits these straight into the
 * ceiling group; pure black comes from a zeroed tint.
 */
export function voidQuadCorners(
  d: MissingTileDetail,
): { corners: [number, number, number][]; normal: [number, number, number] } {
  const h = d.size / 2;
  return {
    corners: [
      [d.x - h, d.y, d.z + h],
      [d.x + h, d.y, d.z + h],
      [d.x + h, d.y, d.z - h],
      [d.x - h, d.y, d.z - h],
    ],
    normal: [0, -1, 0],
  };
}

/**
 * Canvas-texture specification for a writing tile. The renderer draws bg
 * (stained mineral tile), then the text once in ink with a second offset
 * ghost pass (hand-pressed look), jitters stroke weight by d.seed, and
 * rotates the context by d.tilt before drawing.
 */
export function writingCanvasSpec(
  d: WritingTileDetail,
): {
  pxWidth: number;
  pxHeight: number;
  background: string;
  ink: string;
  fontPx: number;
  font: string;
  text: string;
  tilt: number;
} {
  return {
    pxWidth: 512,
    pxHeight: 256,
    background: '#b8b2a0',
    ink: '#2a2016',
    fontPx: 120,
    font: 'bold italic 120px "Segoe Script", cursive',
    text: d.text,
    tilt: d.tilt,
  };
}


