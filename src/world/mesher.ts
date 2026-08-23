/**
 * Chunk mesher: turns a ChunkLayout into raw triangle soup per material
 * group. World-space UVs keep textures seamless across chunks.
 *
 * Level of detail: pass camX/camZ to skip distant dressing geometry
 * (see LOD_NEAR / LOD_FAR below). Without them everything meshes at
 * full detail.
 */
import { CELL, CHUNK_CELLS, WALL_H, WALL_T, EdgeCode, District } from './constants';
import { hash2i } from '../core/rng';
import type { ChunkLayout, PropInstance } from './architect';

// ---------------------------------------------------------------------------
// Level of detail
// ---------------------------------------------------------------------------

/** Beyond this distance (m) a chunk skips small dressing quads. */
export const LOD_NEAR = 40;
/** Beyond this distance (m) a chunk additionally skips stains/graffiti quads. */
export const LOD_FAR = 80;

export type LodLevel = 0 | 1 | 2;

/**
 * Pure function of camera position and chunk center: the same chunk at the
 * same camera distance always resolves to the same level, so identical
 * buildChunkGeometry calls always produce identical geometry (no popping
 * from hidden state or time). Callers that want hysteresis can quantize
 * camX/camZ before passing them in.
 */
export function lodLevelFor(
  camX: number, camZ: number, centerX: number, centerZ: number,
): LodLevel {
  if (!Number.isFinite(camX) || !Number.isFinite(camZ)) return 0;
  const dx = centerX - camX, dz = centerZ - camZ;
  const d2 = dx * dx + dz * dz;
  if (d2 > LOD_FAR * LOD_FAR) return 2;
  if (d2 > LOD_NEAR * LOD_NEAR) return 1;
  return 0;
}

// --- vertex-budget debug accounting (one log line per 50 chunks built) ---
let lodChunksBuilt = 0;
let lodVertsBuiltTotal = 0;
let lodVertsSkippedTotal = 0;

function totalVerts(g: ChunkGeometry): number {
  let v = 0;
  for (const m of [g.floor, g.ceiling, g.walls, g.fixtures, g.fixturesDead,
    g.props, g.debris, g.puddles, g.graffiti, g.stains]) {
    v += m.positions.length / 3;
  }
  return v;
}

/**
 * Cheap deterministic estimate of the vertices the LOD gates left out:
 * every skipped pass emits fixed-size quads per layout item.
 */
function estimateSkippedVerts(layout: ChunkGeometryInput, lod: LodLevel): number {
  let quads = 0;
  if (lod >= 1) {
    // papers: floor litter + readable notes + landmark dressing quads
    // (prayer cards, lint, chalk...)
    quads += layout.notes.length;
    quads += layout.details?.length ?? 0;
    const N = CHUNK_CELLS;
    const baseX = layout.cx * N;
    const baseZ = layout.cz * N;
    for (let lz = 0; lz < N; lz++) {
      for (let lx = 0; lx < N; lx++) {
        if ((((baseX + lx) * 7 + (baseZ + lz) * 13) % 97) <= 3) quads++;
      }
    }
  }
  if (lod >= 2) {
    quads += layout.graffiti.length;
    quads += layout.stains.length * 7; // each stain fans into 7 quad calls
  }
  return quads * 4;
}

/** Add an axis-aligned box (y0..y1), center (x,z), full width w and depth d. */
export function addBox(
  m: MeshArrays,
  x: number, z: number, y0: number, y1: number, w: number, d: number,
): void {
  const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2;
  wallBox(m, x0, z0, x1, z1, y0, y1);
}

function dims(rot: number, a: number, b: number): [number, number] {
  return rot % 2 === 0 ? [a, b] : [b, a];
}

function addProp(g: ChunkGeometry, p: PropInstance): void {
  const box = (y0: number, y1: number, w: number, d: number, ox = 0, oz = 0): void =>
    addBox(g.props, p.x + ox, p.z + oz, y0, y1, ...dims(p.rot, w, d));
  switch (p.kind) {
    case 'desk': {
      box(0.70, 0.76, 1.5, 0.75);
      box(0.10, 0.62, 0.7, 0.65);
      break;
    }
    case 'chair':
      box(0.42, 0.47, 0.46, 0.46);
      box(0.47, 0.84, 0.09, 0.44, -0.19);
      break;
    case 'cabinet':
      box(0, 1.12, 0.95, 0.5);
      break;
    case 'sofa':
      box(0, 0.42, 1.9, 0.85);
      box(0.42, 0.88, 1.9, 0.22, 0, -0.31);
      break;
    case 'bed':
      box(0, 0.3, 1.05, 2.05);
      box(0.3, 0.48, 0.98, 1.98);
      break;
    case 'bedframe':
      box(0, 0.28, 1.0, 2.0);
      break;
    case 'locker':
      box(0, 1.92, 0.45, 0.5);
      break;
    case 'gurney':
      box(0.8, 0.9, 0.68, 1.95);
      box(0, 0.8, 0.5, 1.6);
      break;
    case 'bench':
      box(0.43, 0.51, 1.7, 0.48);
      break;
    case 'planter':
      box(0, 0.55, 0.65, 0.65);
      box(0.55, 0.9 + p.variant * 0.18, 0.32, 0.32);
      break;
    case 'turnstile':
      box(0, 1.0, 0.14, 0.6);
      break;
    case 'crate': {
      const s = 0.5 + p.variant * 0.13;
      addBox(g.props, p.x, p.z, 0, s, s, s);
      if (p.variant === 3) addBox(g.props, p.x + 0.12, p.z - 0.06, s, s * 1.75, s * 0.8, s * 0.8);
      break;
    }
    case 'stacked_chairs':
      for (let i = 0; i < 2 + p.variant; i++) {
        addBox(g.props, p.x, p.z, i * 0.15, i * 0.15 + 0.06, 0.48, 0.48);
        addBox(g.props, p.x - 0.19, p.z, i * 0.15 + 0.06, i * 0.15 + 0.4, 0.07, 0.48);
      }
      break;
    case 'tv':
      box(0, 0.5, 0.5, 0.45);
      box(0.5, 0.98, 0.62, 0.55);
      break;
    case 'battery':
      addBox(g.props, p.x, p.z, 0.004, 0.045, 0.13, 0.07);
      addBox(g.props, p.x, p.z, 0.045, 0.058, 0.05, 0.05);
      break;
    case 'vending': {
      // body with a flush darker front inset (reads as the dispenser face)
      box(0, 1.9, 0.92, 0.8);
      const off = p.rot === 3 ? 0.42 : p.rot === 1 ? -0.42 : 0;
      const offz = p.rot === 2 ? 0.38 : p.rot === 0 ? -0.38 : 0;
      addBox(g.props,
        p.x + (p.rot % 2 === 0 ? 0 : off),
        p.z + (p.rot % 2 === 0 ? offz : off),
        0.35, 1.62, p.rot % 2 === 0 ? 0.74 : 0.06, p.rot % 2 === 0 ? 0.06 : 0.74);
      break;
    }
    case 'whiteboard':
      box(0.85, 0.95, 1.5, 0.08);
      box(0.9, 2.05, 1.62, 0.05);
      break;
    case 'cooler':
      box(0, 0.95, 0.4, 0.4);
      box(0.95, 1.28, 0.32, 0.32);
      break;
    case 'couch_l':
      box(0, 0.42, 1.9, 0.85);
      box(0.42, 0.88, 1.9, 0.22, 0, -0.31);
      box(0, 0.42, 0.85, 1.4, 0.95);
      box(0.42, 0.88, 0.22, 1.4, 1.24);
      break;
    case 'shelf':
      box(0, 1.8, 0.9, 0.35);
      for (const yy of [0.44, 0.88, 1.32]) box(yy, yy + 0.04, 0.86, 0.3);
      break;
  }
}

function addProps(g: ChunkGeometry, layout: ChunkLayout): void {
  for (const p of layout.props) addProp(g, p);
}

export interface MeshArrays {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  colors?: number[];
}
export interface ChunkGeometry {
  floor: MeshArrays;
  ceiling: MeshArrays;
  walls: MeshArrays;
  fixtures: MeshArrays;
  fixturesDead: MeshArrays;
  props: MeshArrays;
  debris: MeshArrays;
  puddles: MeshArrays;
  graffiti: MeshArrays;
  stains: MeshArrays;
}

function newArray(): MeshArrays {
  return { positions: [], normals: [], uvs: [], indices: [], colors: [] };
}

/**

(Showing lines 1-220 of 946. Use offset=221 to continue.)

 * Fill a vertex-color channel with a per-chunk tint multiplier.
 * Districts read at slightly different temperatures without new materials.
 */
export function applyTint(m: MeshArrays, r: number, g: number, b: number): void {
  const verts = m.positions.length / 3;
  if (!m.colors || m.colors.length !== verts * 4) {
    const out: number[] = [];
    for (let i = 0; i < verts; i++) out.push(1, 1, 1, 1);
    m.colors = out;
  }
  for (let i = 0; i < verts; i++) {
    m.colors[i * 4] *= r;
    m.colors[i * 4 + 1] *= g;
    m.colors[i * 4 + 2] *= b;
  }
}

/** Per-vertex micro-jitter so large fields never read as flat fills. */
function jitterCell(m: MeshArrays, seedX: number, seedZ: number, amount: number): void {
  const j = 1 + ((hash2i(seedX, seedZ, 77) % 100) / 100 - 0.5) * 2 * amount;
  const start = m.positions.length / 3 - 4;
  if (!m.colors || m.colors.length < m.positions.length) return;
  for (let v = start; v < start + 4; v++) {
    m.colors[v * 4] *= j;
    m.colors[v * 4 + 1] *= j;
    m.colors[v * 4 + 2] *= j;
  }
}

/** Add a quad defined by 4 corners (ccw seen from normal side). */
function quad(
  m: MeshArrays,
  a: [number, number, number], b: [number, number, number],
  c: [number, number, number], d: [number, number, number],
  n: [number, number, number],
  uvA: [number, number], uvB: [number, number], uvC: [number, number], uvD: [number, number],
): void {
  const i = m.positions.length / 3;
  m.positions.push(...a, ...b, ...c, ...d);
  m.normals.push(...n, ...n, ...n, ...n);
  m.uvs.push(...uvA, ...uvB, ...uvC, ...uvD);
  // Auto-orient: ensure triangle winding matches the declared normal so
  // faces are never backface-culled regardless of corner order.
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  // Babylon LH rasterizer: front face = clockwise on screen. Empirically
  // verified against cross-product sign below.
  if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) {
    m.indices.push(i, i + 2, i + 1, i, i + 3, i + 2);
  } else {
    m.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
}

const CARPET_SCALE = 1 / 1.7;
const CEIL_SCALE = 1 / 0.61;
const WALL_UV_SCALE = 1 / 2.7;
const DOOR_W = 1.24;
const DOOR_H = 2.14;

/** Architectural detail dimensions. */
const BASEBOARD_H = 0.1;      // trim strip height at wall bases
const BASEBOARD_OUT = 0.008;  // how far trim sits proud of the wall face
const GRID_Y_OFF = 0.009;     // ceiling tile grooves sit just below the plane
const GRID_HALF_W = 0.016;    // half-width of a recessed grid line
const HEADER_H = 0.15;        // door header beam height
const HEADER_SIDE = 0.2;      // header overhang past the opening each side
const WEAR_Y = 0.002;         // floor wear patch height above carpet

/** Pad the color channel with white so per-quad tints stay vertex-synced. */
function ensureColors(m: MeshArrays): void {
  if (!m.colors) m.colors = [];
  const verts = m.positions.length / 3;
  while (m.colors.length < verts * 4) m.colors.push(1, 1, 1, 1);
}

/** Tint every vertex from `fromVert` up (used right after emitting detail quads). */
function tintVerts(m: MeshArrays, fromVert: number, r: number, g: number, b: number): void {
  ensureColors(m);
  const cols = m.colors!;
  const end = m.positions.length / 3;
  for (let v = Math.max(0, fromVert); v < end; v++) {
    cols[v * 4] *= r;
    cols[v * 4 + 1] *= g;
    cols[v * 4 + 2] *= b;
  }
}

function addFloor(g: ChunkGeometry, cx: number, cz: number): void {
  const N = CHUNK_CELLS;
  const bx = cx * N * CELL;
  const bz = cz * N * CELL;
  const f = g.floor;
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const x0 = bx + lx * CELL, z0 = bz + lz * CELL;
      const x1 = x0 + CELL, z1 = z0 + CELL;
      quad(f,
        [x0, 0, z1], [x1, 0, z1], [x1, 0, z0], [x0, 0, z0],
        [0, 1, 0],
        [x0 * CARPET_SCALE, z1 * CARPET_SCALE],
        [x1 * CARPET_SCALE, z1 * CARPET_SCALE],
        [x1 * CARPET_SCALE, z0 * CARPET_SCALE],
        [x0 * CARPET_SCALE, z0 * CARPET_SCALE]);
      jitterCell(f, bx + lx, bz + lz, 0.05);
    }
  }
}

/**
 * High-traffic wear: in lattice corridor districts the carpet lightens in
 * irregular patches along the walked line, as if bleached by footfalls.
 */
function addFloorWear(g: ChunkGeometry, layout: ChunkLayout): void {
  if (layout.district !== District.CORRIDOR_GRID) return;
  const N = CHUNK_CELLS;
  const baseX = layout.cx * N;
  const baseZ = layout.cz * N;
  const f = g.floor;
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const wx = baseX + lx;
      const wz = baseZ + lz;
      if (hash2i(wx, wz, 4242) % 100 >= 55) continue;
      const cxw = (wx + 0.5) * CELL + ((hash2i(wx, wz, 91) % 60) / 100 - 0.3);
      const czw = (wz + 0.5) * CELL + ((hash2i(wx, wz, 92) % 60) / 100 - 0.3);
      const rBase = 0.45 + ((wx * 3 + wz * 7 + hash2i(wx, wz, 93)) % 40) / 100;
      // irregular pentagon fan around the patch center
      const pts: [number, number][] = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + (hash2i(wx * 5 + i, wz, 94) % 628) / 100;
        const rr = rBase * (0.65 + (hash2i(wx + i * 17, wz + i * 11, 95) % 100) / 220);
        pts.push([cxw + Math.cos(a) * rr, czw + Math.sin(a) * rr]);
      }
      for (let i = 0; i < 5; i++) {
        const a = pts[i], b = pts[(i + 1) % 5];
        quad(f,
          [cxw, WEAR_Y, czw], [a[0], WEAR_Y, a[1]], [b[0], WEAR_Y, b[1]], [cxw, WEAR_Y, czw],
          [0, 1, 0],
          [cxw * CARPET_SCALE, czw * CARPET_SCALE],
          [a[0] * CARPET_SCALE, a[1] * CARPET_SCALE],
          [b[0] * CARPET_SCALE, b[1] * CARPET_SCALE],
          [cxw * CARPET_SCALE, czw * CARPET_SCALE]);
      }
      tintVerts(f, (f.positions.length / 3) - 20, 1.22, 1.19, 1.12);
    }
  }
}

function addCeiling(g: ChunkGeometry, cx: number, cz: number): void {
  const N = CHUNK_CELLS;
  const bx = cx * N * CELL;
  const bz = cz * N * CELL;
  const c = g.ceiling;
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const x0 = bx + lx * CELL, z0 = bz + lz * CELL;
      const x1 = x0 + CELL, z1 = z0 + CELL;
      quad(c,
        [x0, WALL_H, z0], [x1, WALL_H, z0], [x1, WALL_H, z1], [x0, WALL_H, z1],
        [0, -1, 0],
        [x0 * CEIL_SCALE, z0 * CEIL_SCALE],
        [x1 * CEIL_SCALE, z0 * CEIL_SCALE],
        [x1 * CEIL_SCALE, z1 * CEIL_SCALE],
        [x0 * CEIL_SCALE, z1 * CEIL_SCALE]);
      jitterCell(c, bx + lx + 9999, bz + lz + 7777, 0.04);
    }
  }
}

/**
 * Suspended-ceiling tile grid: thin dark grooves every CELL distance, sitting
 * just below the ceiling plane so they read as recessed tile seams.
 */
function addCeilingGrid(g: ChunkGeometry, cx: number, cz: number): void {
  const N = CHUNK_CELLS;
  const bx = cx * N * CELL;
  const bz = cz * N * CELL;
  const span = N * CELL;
  const y = WALL_H - GRID_Y_OFF;
  const c = g.ceiling;
  // lines running along X at each z boundary
  for (let lz = 0; lz <= N; lz++) {
    const z = bz + lz * CELL;
    const v0 = (bx - 2) * CEIL_SCALE, v1 = (bx + span + 2) * CEIL_SCALE;
    quad(c,
      [bx, y, z - GRID_HALF_W], [bx + span, y, z - GRID_HALF_W],
      [bx + span, y, z + GRID_HALF_W], [bx, y, z + GRID_HALF_W],
      [0, -1, 0], [v0, 0], [v1, 0], [v1, 1], [v0, 1]);
    tintVerts(c, (c.positions.length / 3) - 4, 0.58, 0.57, 0.54);
  }
  // lines running along Z at each x boundary
  for (let lx = 0; lx <= N; lx++) {
    const x = bx + lx * CELL;
    const u0 = (bz - 2) * CEIL_SCALE, u1 = (bz + span + 2) * CEIL_SCALE;
    quad(c,
      [x - GRID_HALF_W, y, bz], [x + GRID_HALF_W, y, bz],
      [x + GRID_HALF_W, y, bz + span], [x - GRID_HALF_W, y, bz + span],
      [0, -1, 0], [0, u0], [1, u0], [1, u1], [0, u1]);
    tintVerts(c, (c.positions.length / 3) - 4, 0.58, 0.57, 0.54);
  }
}

/**
 * Baseboard trim: a dark 0.1 m strip along wall bases where walls meet the
 * floor. Reuses the wall material with a darker per-vertex tint; sits a hair
 * proud of the wall face so it never z-fights.
 */
function addBaseboards(g: ChunkGeometry, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  const T = WALL_T;
  const ht = T / 2;
  const w = g.walls;
  const bx = layout.cx * N;
  const bz = layout.cz * N;
  const y1 = BASEBOARD_H;
  const v1 = y1 * WALL_UV_SCALE;

  const stripH = (x0: number, x1: number, zc: number): void => {
    // north face (-z side)
    quad(w,
      [x0, 0, zc - ht - BASEBOARD_OUT], [x1, 0, zc - ht - BASEBOARD_OUT],
      [x1, y1, zc - ht - BASEBOARD_OUT], [x0, y1, zc - ht - BASEBOARD_OUT],
      [0, 0, -1],
      [x0 * WALL_UV_SCALE, 0], [x1 * WALL_UV_SCALE, 0],
      [x1 * WALL_UV_SCALE, v1], [x0 * WALL_UV_SCALE, v1]);
    // south face (+z side)
    quad(w,
      [x1, 0, zc + ht + BASEBOARD_OUT], [x0, 0, zc + ht + BASEBOARD_OUT],
      [x0, y1, zc + ht + BASEBOARD_OUT], [x1, y1, zc + ht + BASEBOARD_OUT],
      [0, 0, 1],
      [x1 * WALL_UV_SCALE, 0], [x0 * WALL_UV_SCALE, 0],
      [x0 * WALL_UV_SCALE, v1], [x1 * WALL_UV_SCALE, v1]);
    tintVerts(w, (w.positions.length / 3) - 8, 0.42, 0.40, 0.37);
  };
  const stripV = (zc0: number, zc1: number, xc: number): void => {
    // west face (-x side)
    quad(w,
      [xc - ht - BASEBOARD_OUT, 0, zc1], [xc - ht - BASEBOARD_OUT, 0, zc0],
      [xc - ht - BASEBOARD_OUT, y1, zc0], [xc - ht - BASEBOARD_OUT, y1, zc1],
      [-1, 0, 0],
      [zc1 * WALL_UV_SCALE, 0], [zc0 * WALL_UV_SCALE, 0],
      [zc0 * WALL_UV_SCALE, v1], [zc1 * WALL_UV_SCALE, v1]);
    // east face (+x side)
    quad(w,
      [xc + ht + BASEBOARD_OUT, 0, zc0], [xc + ht + BASEBOARD_OUT, 0, zc1],
      [xc + ht + BASEBOARD_OUT, y1, zc1], [xc + ht + BASEBOARD_OUT, y1, zc0],
      [1, 0, 0],
      [zc0 * WALL_UV_SCALE, 0], [zc1 * WALL_UV_SCALE, 0],
      [zc1 * WALL_UV_SCALE, v1], [zc0 * WALL_UV_SCALE, v1]);
    tintVerts(w, (w.positions.length / 3) - 8, 0.42, 0.40, 0.37);
  };

  for (let lz = 0; lz <= N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const code = layout.hEdges[lz * N + lx];
      if (code === EdgeCode.OPEN) continue;
      const x0 = (bx + lx) * CELL;
      const x1 = x0 + CELL;
      const zc = (bz + lz) * CELL;
      if (code === EdgeCode.SOLID) {
        stripH(x0, x1, zc);
      } else {
        const mid = (x0 + x1) / 2;
        const dw = DOOR_W / 2;
        stripH(x0, mid - dw, zc);
        stripH(mid + dw, x1, zc);
      }
    }
  }
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx <= N; lx++) {
      const code = layout.vEdges[lz * (N + 1) + lx];
      if (code === EdgeCode.OPEN) continue;
      const z0 = (bz + lz) * CELL;
      const z1 = z0 + CELL;
      const xc = (bx + lx) * CELL;
      if (code === EdgeCode.SOLID) {
        stripV(z0, z1, xc);
      } else {
        const mid = (z0 + z1) / 2;
        const dw = DOOR_W / 2;
        stripV(z0, mid - dw, xc);
        stripV(mid + dw, z1, xc);
      }
    }
  }
}

function wallBox(
  w: MeshArrays,
  x0: number, z0: number, x1: number, z1: number,
  y0 = 0, y1 = WALL_H,
): void {
  // two vertical faces per axis-aligned slab (interior sides only when visible)
  const h = y1 - y0;
  const v0 = y0 * WALL_UV_SCALE, v1 = y1 * WALL_UV_SCALE;
  // north face (-z side)
  if (y1 > y0) {
    quad(w,
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [0, 0, -1],
      [x0 * WALL_UV_SCALE, v0], [x1 * WALL_UV_SCALE, v0],
      [x1 * WALL_UV_SCALE, v1], [x0 * WALL_UV_SCALE, v1]);
    // south face (+z side)
    quad(w,
      [x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1],
      [0, 0, 1],
      [x1 * WALL_UV_SCALE, v0], [x0 * WALL_UV_SCALE, v0],
      [x0 * WALL_UV_SCALE, v1], [x1 * WALL_UV_SCALE, v1]);
    // west face (-x side)
    quad(w,
      [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1],
      [-1, 0, 0],
      [z1 * WALL_UV_SCALE, v0], [z0 * WALL_UV_SCALE, v0],
      [z0 * WALL_UV_SCALE, v1], [z1 * WALL_UV_SCALE, v1]);
    // east face (+x side)
    quad(w,
      [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0],
      [1, 0, 0],
      [z0 * WALL_UV_SCALE, v0], [z1 * WALL_UV_SCALE, v0],
      [z1 * WALL_UV_SCALE, v1], [z0 * WALL_UV_SCALE, v1]);
    if (h < WALL_H - 0.01) {
      // lintel underside
      quad(w,
        [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
        [0, 1, 0],
        [x0 * WALL_UV_SCALE, z0 * WALL_UV_SCALE],
        [x1 * WALL_UV_SCALE, z0 * WALL_UV_SCALE],
        [x1 * WALL_UV_SCALE, z1 * WALL_UV_SCALE],
        [x0 * WALL_UV_SCALE, z1 * WALL_UV_SCALE]);
    }
  }
}

function addWalls(g: ChunkGeometry, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  const T = WALL_T;
  const ht = T / 2;
  const w = g.walls;
  const bx = layout.cx * N;
  const bz = layout.cz * N;

  // Horizontal edges (walls running along X at integer z boundaries)
  for (let lz = 0; lz <= N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const code = layout.hEdges[lz * N + lx];
      if (code === EdgeCode.OPEN) continue;
      const x0 = (bx + lx) * CELL;
      const x1 = x0 + CELL;
      const zc = (bz + lz) * CELL;
      if (code === EdgeCode.SOLID) {
        wallBox(w, x0, zc - ht, x1, zc + ht);
      } else {
        const mid = (x0 + x1) / 2;
        const dw = DOOR_W / 2;
        wallBox(w, x0, zc - ht, mid - dw, zc + ht);
        wallBox(w, mid + dw, zc - ht, x1, zc + ht);
        wallBox(w, mid - dw, zc - ht, mid + dw, zc + ht, DOOR_H, WALL_H); // lintel
        doorFrame(w, mid, zc, false, dw, ht);
      }
    }
  }
  // Vertical edges (walls running along Z at integer x boundaries)
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx <= N; lx++) {
      const code = layout.vEdges[lz * (N + 1) + lx];
      if (code === EdgeCode.OPEN) continue;
      const z0 = (bz + lz) * CELL;
      const z1 = z0 + CELL;
      const xc = (bx + lx) * CELL;
      if (code === EdgeCode.SOLID) {
        wallBox(w, xc - ht, z0, xc + ht, z1);
      } else {
        const mid = (z0 + z1) / 2;
        const dw = DOOR_W / 2;
        wallBox(w, xc - ht, z0, xc + ht, mid - dw);
        wallBox(w, xc - ht, mid + dw, xc + ht, z1);
        wallBox(w, xc - ht, mid - dw, xc + ht, mid + dw, DOOR_H, WALL_H);
        doorFrame(w, xc, mid, true, dw, ht);
      }
    }
  }
}

/**
 * Trim around a doorway: two jambs protruding slightly past both wall
 * faces plus a head casing. Same wall material; reads as a real frame.
 */
function doorFrame(
  w: MeshArrays, cxm: number, czm: number, vertical: boolean,
  dw: number, ht: number,
): void {
  const jT = 0.09;   // jamb thickness across the wall
  const jOut = 0.05; // how far it sticks out of the wall face
  const jW = 0.11;   // jamb width along the opening
  // header beam above the opening: HEADER_H tall, spanning the door width
  // plus HEADER_SIDE overhang each side; lighter trim tint than the casing
  const hBeamY0 = DOOR_H + 0.07;
  const hBeamY1 = hBeamY0 + HEADER_H;
  if (!vertical) {
    const vStart = w.positions.length / 3;
    for (const s of [-1, 1]) {
      wallBox(w, cxm + s * dw - jW * 0.5, czm - ht - jOut, cxm + s * dw + jW * 0.5, czm + ht + jOut, 0, DOOR_H + 0.06);
    }
    wallBox(w, cxm - dw - jW * 0.5, czm - jT * 0.5 - 0.02, cxm + dw + jW * 0.5, czm + jT * 0.5 + 0.02, DOOR_H, DOOR_H + 0.07);
    wallBox(w, cxm - dw - HEADER_SIDE, czm - ht - jOut, cxm + dw + HEADER_SIDE, czm + ht + jOut, hBeamY0, hBeamY1);
    tintVerts(w, vStart, 0.72, 0.70, 0.66);
  } else {
    const vStart = w.positions.length / 3;
    for (const s of [-1, 1]) {
      wallBox(w, cxm - ht - jOut, czm + s * dw - jW * 0.5, cxm + ht + jOut, czm + s * dw + jW * 0.5, 0, DOOR_H + 0.06);
    }
    wallBox(w, cxm - jT * 0.5 - 0.02, czm - dw - jW * 0.5, cxm + jT * 0.5 + 0.02, czm + dw + jW * 0.5, DOOR_H, DOOR_H + 0.07);
    wallBox(w, cxm - ht - jOut, czm - dw - HEADER_SIDE, cxm + ht + jOut, czm + dw + HEADER_SIDE, hBeamY0, hBeamY1);
    tintVerts(w, vStart, 0.72, 0.70, 0.66);
  }
}

function addFixtures(g: ChunkGeometry, layout: ChunkLayout): void {
  const emitPanel = (f: MeshArrays, l: { x: number; z: number }) => {
    const y = WALL_H - 0.03;
    const hw = 0.56, hh = 0.28; // panel half extents
    quad(f,
      [l.x - hw, y, l.z - hh], [l.x + hw, y, l.z - hh],
      [l.x + hw, y, l.z + hh], [l.x - hw, y, l.z + hh],
      [0, -1, 0],
      [0, 0], [1, 0], [1, 1], [0, 1]);
    // frame skirt to catch glow
    const fy0 = y, fy1 = y + 0.05;
    quad(f, [l.x - hw - 0.04, fy0, l.z - hh - 0.04], [l.x + hw + 0.04, fy0, l.z - hh - 0.04],
      [l.x + hw + 0.04, fy1, l.z - hh - 0.04], [l.x - hw - 0.04, fy1, l.z - hh - 0.04],
      [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1]);
    quad(f, [l.x + hw + 0.04, fy0, l.z + hh + 0.04], [l.x - hw - 0.04, fy0, l.z + hh + 0.04],
      [l.x - hw - 0.04, fy1, l.z + hh + 0.04], [l.x + hw + 0.04, fy1, l.z + hh + 0.04],
      [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
    quad(f, [l.x - hw - 0.04, fy0, l.z + hh + 0.04], [l.x - hw - 0.04, fy0, l.z - hh - 0.04],
      [l.x - hw - 0.04, fy1, l.z - hh - 0.04], [l.x - hw - 0.04, fy1, l.z + hh + 0.04],
      [-1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    quad(f, [l.x + hw + 0.04, fy0, l.z - hh - 0.04], [l.x + hw + 0.04, fy0, l.z + hh + 0.04],
      [l.x + hw + 0.04, fy1, l.z + hh + 0.04], [l.x + hw + 0.04, fy1, l.z - hh - 0.04],
      [1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  };


(Showing lines 298-667 of 946. Use offset=668 to continue.)

  // twin-tube fixture: two narrow emissive strips + dark housings
  const emitTubes = (f: MeshArrays, l: { x: number; z: number }) => {

(Showing lines 540-669 of 946. Use offset=670 to continue.)

    const y = WALL_H - 0.06;
    for (const s of [-1, 1]) {
      quad(f,
        [l.x - 0.5, y, l.z + s * 0.13 - 0.055], [l.x + 0.5, y, l.z + s * 0.13 - 0.055],
        [l.x + 0.5, y, l.z + s * 0.13 + 0.055], [l.x - 0.5, y, l.z + s * 0.13 + 0.055],
        [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
    const d = g.fixturesDead;
    for (const s of [-1, 1]) {
      wallBox(d, l.x - 0.56, l.z - 0.24, l.x - 0.48, l.z + 0.24, WALL_H - 0.09, WALL_H - 0.03);
      wallBox(d, l.x + 0.48, l.z - 0.24, l.x + 0.56, l.z + 0.24, WALL_H - 0.09, WALL_H - 0.03);
      void s;
    }
  };

  // broken fixture: panel hanging at an angle, always dead
  const emitBroken = (l: { x: number; z: number }) => {
    const f = g.fixturesDead;
    const y = WALL_H - 0.02;
    const hw = 0.55, hh = 0.27, drop = 0.34;
    // tilted panel: one edge still at the ceiling, the other dropped
    quad(f,
      [l.x - hw, y, l.z - hh], [l.x + hw, y, l.z - hh],
      [l.x + hw, y - drop, l.z + hh], [l.x - hw, y - drop, l.z + hh],
      [-0.35, 0.82, -0.45], [0, 0], [1, 0], [1, 1], [0, 1]);
    // torn underside hint
    wallBox(f, l.x - 0.08, l.z - 0.05, l.x + 0.08, l.z + 0.05, WALL_H - drop - 0.22, WALL_H - drop - 0.05);
  };

  for (const l of layout.lights) {
    const style = l.flicker % 25;
    if (!l.alive && style === 7) {
      emitBroken(l);
      continue;
    }
    if (style < 15) emitPanel(l.alive ? g.fixtures : g.fixturesDead, l);
    else emitTubes(l.alive ? g.fixtures : g.fixturesDead, l);
  }
}

/** Ceiling water stains: dark brown irregular patches facing down. */
function addCeilingStains(g: ChunkGeometry, layout: ChunkLayout): void {
  const s = g.stains;

(Showing lines 643-712 of 960. Use offset=713 to continue.)

  for (const st of layout.stains) {
    const y = WALL_H - 0.004;
    const pts: [number, number][] = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const rr = st.r * (0.6 + ((i * 41 + Math.floor(st.z)) % 12) / 24);
      pts.push([st.x + Math.cos(a) * rr, st.z + Math.sin(a) * rr]);
    }
    for (let i = 0; i < 7; i++) {
      const a = pts[i], b = pts[(i + 1) % 7];
      quad(s,
        [st.x, y, st.z], [a[0], y, a[1]], [b[0], y, b[1]], [st.x, y, st.z],
        [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
}

/** Graffiti: dark scrawled sheet pasted onto a wall. */
function addGraffiti(g: ChunkGeometry, layout: import('./architect').ChunkLayout): void {
  const gr = g.graffiti;
  for (const gf of layout.graffiti) {
    const w = Math.min(1.6, gf.text.length * 0.11 + 0.2);
    const hgt = 0.42;
    const OFF = WALL_T / 2 + 0.012;
    let cxw = gf.x, czw = gf.z;
    if (gf.face === 0) czw -= OFF;
    else if (gf.face === 1) czw += OFF;
    else if (gf.face === 2) cxw -= OFF;
    else cxw += OFF;
    // rotate the quad to hug its wall
    const horiz = gf.face === 0 || gf.face === 1;
    if (horiz) {
      quad(gr,
        [cxw - w / 2, gf.y - hgt / 2, czw], [cxw + w / 2, gf.y - hgt / 2, czw],
        [cxw + w / 2, gf.y + hgt / 2, czw], [cxw - w / 2, gf.y + hgt / 2, czw],
        [0, 0, gf.face === 0 ? -1 : 1],
        [0, 0], [1, 0], [1, 1], [0, 1]);
    } else {
      quad(gr,
        [cxw, gf.y - hgt / 2, czw - w / 2], [cxw, gf.y - hgt / 2, czw + w / 2],
        [cxw, gf.y + hgt / 2, czw + w / 2], [cxw, gf.y + hgt / 2, czw - w / 2],
        [gf.face === 2 ? -1 : 1, 0, 0],
        [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
}

/** Dangling wire bundles under dead fixtures. */
function addWires(g: ChunkGeometry, layout: ChunkLayout): void {
  for (const w of layout.wires) {
    const top = WALL_H - 0.02;
    const bot = Math.max(0.4, top - w.len);
    // two thin conductors twisting slightly apart
    addBox(g.fixturesDead, w.x - 0.03, w.z, bot, top, 0.02, 0.02);
    addBox(g.fixturesDead, w.x + 0.04, w.z + 0.02, bot + 0.15, top, 0.015, 0.015);
  }
}

/** Damp patches: dark low quads that catch specular highlights. */
function addPuddles(g: ChunkGeometry, layout: ChunkLayout): void {
  const p = g.puddles;
  for (const pd of layout.puddles) {
    // irregular hexagonal patch
    const pts: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + pd.x * 0.13 % 1;
      const rr = pd.r * (0.7 + ((i * 37 + Math.floor(pd.z)) % 10) / 30);
      pts.push([pd.x + Math.cos(a) * rr, pd.z + Math.sin(a) * rr]);
    }
    for (let i = 0; i < 6; i++) {
      const a = pts[i], b = pts[(i + 1) % 6];
      quad(p,
        [pd.x, 0.004, pd.z], [a[0], 0.004, a[1]], [b[0], 0.004, b[1]], [pd.x, 0.004, pd.z],
        [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
}

/** Readable notes: a distinct larger sheet on the carpet. */
function addNotes(g: ChunkGeometry, layout: ChunkLayout): void {
  const d = g.debris;
  for (const nt of layout.notes) {
    const s = 0.19;
    const ca = Math.cos(nt.rot), sa = Math.sin(nt.rot);
    const p = (dx: number, dz: number): [number, number] => [nt.x + dx * ca - dz * sa, nt.z + dx * sa + dz * ca];
    const a = p(-s, -s), b = p(s * 1.35, -s), cc = p(s * 1.35, s), dd = p(-s, s);
    quad(d,
      [a[0], 0.006, a[1]], [b[0], 0.006, b[1]], [cc[0], 0.006, cc[1]], [dd[0], 0.006, dd[1]],
      [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  }
}

/** Sparse paper scraps and floor litter. */
function addDebris(g: ChunkGeometry, layout: ChunkLayout): void {
  const N = CHUNK_CELLS;
  const baseX = layout.cx * N;
  const baseZ = layout.cz * N;
  for (let lz = 0; lz < N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const wx = baseX + lx;
      const wz = baseZ + lz;
      if (((wx * 7 + wz * 13) % 97) > 3) continue;
      const rngA = ((wx * 31 + wz * 17) % 628) / 100;
      const cxw = (wx + 0.3 + ((wx * 11 + wz) % 40) / 100) * CELL;
      const czw = (wz + 0.3 + ((wz * 13 + wx) % 40) / 100) * CELL;
      const s = 0.10 + ((wx + wz) % 12) / 100;
      const ca = Math.cos(rngA), sa = Math.sin(rngA);
      const c = g.debris;
      const p = (dx: number, dz: number): [number, number] => [cxw + dx * ca - dz * sa, czw + dx * sa + dz * ca];
      const a = p(-s, -s), b = p(s, -s), cc = p(s, s), dd = p(-s, s);
      quad(c,
        [a[0], 0.004, a[1]], [b[0], 0.004, b[1]], [cc[0], 0.004, cc[1]], [dd[0], 0.004, dd[1]],
        [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
}

/**
 * Landmark dressing quads (prayer cards, dryer lint, photos, chalk marks):
 * small flat sheets either lying horizontally or hugging a wall face.
 * Emitted into the debris material group; tinted per-quad by packed rgb.
 */
function addDetails(g: ChunkGeometry, layout: ChunkLayout): void {
  const d = g.debris;
  for (const dt of layout.details ?? []) {
    const startVert = d.positions.length / 3;
    const OFF = WALL_T / 2 + 0.01;
    if (dt.face === undefined) {
      // horizontal: yawed flat quad sitting at its given height
      const ca = Math.cos(dt.rot), sa = Math.sin(dt.rot);
      const hw = dt.w / 2, hh = dt.h / 2;
      const p = (dx: number, dz: number): [number, number] =>
        [dt.x + dx * ca - dz * sa, dt.z + dx * sa + dz * ca];
      const a = p(-hw, -hh), b = p(hw, -hh), c = p(hw, hh), e = p(-hw, hh);
      quad(d,
        [a[0], dt.y, a[1]], [b[0], dt.y, b[1]], [c[0], dt.y, c[1]], [e[0], dt.y, e[1]],
        [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    } else {
      let cxw = dt.x, czw = dt.z;
      if (dt.face === 0) czw -= OFF;
      else if (dt.face === 1) czw += OFF;
      else if (dt.face === 2) cxw -= OFF;
      else cxw += OFF;
      const hw = dt.w / 2, hh = dt.h / 2;
      const y0 = dt.y - hh, y1 = dt.y + hh;
      if (dt.face === 0 || dt.face === 1) {
        quad(d,
          [cxw - hw, y0, czw], [cxw + hw, y0, czw],
          [cxw + hw, y1, czw], [cxw - hw, y1, czw],
          [0, 0, dt.face === 0 ? -1 : 1], [0, 0], [1, 0], [1, 1], [0, 1]);
      } else {
        quad(d,
          [cxw, y0, czw - hw], [cxw, y0, czw + hw],
          [cxw, y1, czw + hw], [cxw, y1, czw - hw],
          [dt.face === 2 ? -1 : 1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      }
    }
    tintVerts(d, startVert,
      ((dt.rgb >> 16) & 255) / 255,
      ((dt.rgb >> 8) & 255) / 255,
      (dt.rgb & 255) / 255);
  }
}

export function buildChunkGeometry(
  layout: ChunkGeometryInput,
  camX: number = Infinity,
  camZ: number = Infinity,
): ChunkGeometry {
  const N = CHUNK_CELLS;
  const centerX = (layout.cx + 0.5) * N * CELL;
  const centerZ = (layout.cz + 0.5) * N * CELL;
  // pure distance band: same chunk at same camera distance => same geometry
  const lod = lodLevelFor(camX, camZ, centerX, centerZ);
  const g: ChunkGeometry = {
    floor: newArray(), ceiling: newArray(),
    walls: newArray(), fixtures: newArray(), fixturesDead: newArray(),
    props: newArray(), debris: newArray(),
    puddles: newArray(), graffiti: newArray(), stains: newArray(),
  };
  addFloor(g, layout.cx, layout.cz);
  addCeiling(g, layout.cx, layout.cz);
  addCeilingGrid(g, layout.cx, layout.cz);
  addWalls(g, layout);
  addBaseboards(g, layout);
  addFixtures(g, layout);
  addProps(g, layout);
  // LOD 1+: skip small dressing quads — paper scraps, readable notes and
  // landmark details (prayer cards, lint, chalk...)
  if (lod < 1) addDebris(g, layout);
  // path echo: faint dark scuffs along the previous session's trail
  if (layout.pathEcho) {
    for (const pt of layout.pathEcho) {
      const sz2 = 0.09;
      const ang2 = Math.sin(pt.x * 7.3 + pt.z * 3.1) * Math.PI;
      const ca = Math.cos(ang2), sa = Math.sin(ang2);
      for (const [ox, oz] of [[-0.12, 0], [0.12, 0]] as const) {
        const px2 = pt.x + ca * ox - sa * oz;
        const pz2 = pt.z + sa * ox + ca * oz;
        quad(g.debris,
          [px2 - sz2, 0.005, pz2 - sz2], [px2 + sz2, 0.005, pz2 - sz2],
          [px2 + sz2, 0.005, pz2 + sz2], [px2 - sz2, 0.005, pz2 + sz2],
          [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
      }
    }
  }
  // LOD 1+: notes and landmark dressing quads are skipped too
  if (lod < 1) {
    addNotes(g, layout);
    addDetails(g, layout);
  }
  addPuddles(g, layout);
  addFloorWear(g, layout);
  addWires(g, layout);
  // LOD 2: also skip stains/graffiti quads
  if (lod < 2) {
    addGraffiti(g, layout);
    addCeilingStains(g, layout);
  }
  // vertex-budget debug aid: one console line per 50 chunks built
  lodChunksBuilt++;
  const verts = totalVerts(g);
  lodVertsBuiltTotal += verts;
  if (lod > 0) lodVertsSkippedTotal += estimateSkippedVerts(layout, lod);
  if (lodChunksBuilt % 50 === 0) {
    const full = lodVertsBuiltTotal + lodVertsSkippedTotal;
    const pct = full > 0 ? ((lodVertsSkippedTotal / full) * 100).toFixed(1) : '0.0';
    console.log(
      `[lod] ${lodChunksBuilt} chunks built: ${lodVertsBuiltTotal} verts emitted, ` +
      `~${lodVertsSkippedTotal} skipped by distance LOD (~${pct}% reduction)`);
  }
  return g;
}
type ChunkGeometryInput = import('./architect').ChunkLayout;


  lodChunksBuilt++;
  const verts = totalVerts(g);
  lodVertsBuiltTotal += verts;
  if (lod > 0) lodVertsSkippedTotal += estimateSkippedVerts(layout, lod);
  if (lodChunksBuilt % 50 === 0) {
    const full = lodVertsBuiltTotal + lodVertsSkippedTotal;
    const pct = full > 0 ? ((lodVertsSkippedTotal / full) * 100).toFixed(1) : '0.0';
    console.log(
      `[lod] ${lodChunksBuilt} chunks built: ${lodVertsBuiltTotal} verts emitted, ` +
      `~${lodVertsSkippedTotal} skipped by distance LOD (~${pct}% reduction)`);
  }
  return g;
}
type ChunkGeometryInput = import('./architect').ChunkLayout;


