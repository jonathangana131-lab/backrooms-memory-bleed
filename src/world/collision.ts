/** Static collision world: per-chunk AABB lists + capsule resolution. */
import { CELL, CHUNK_CELLS, WALL_T, EdgeCode } from './constants';
import type { Box2, PropInstance } from './architect';
import type { ChunkLayout } from './architect';

/** Solid footprints for props that should block movement. */
function propFootprint(p: PropInstance): Box2 | null {
  const swap = (w: number, d: number): [number, number] => (p.rot % 2 === 0 ? [w, d] : [d, w]);
  switch (p.kind) {
    case 'desk': { const [w, d] = swap(1.5, 0.75); return boxOf(p, w, d); }
    case 'cabinet': { const [w, d] = swap(0.95, 0.5); return boxOf(p, w, d); }
    case 'sofa': { const [w, d] = swap(1.9, 0.85); return boxOf(p, w, d); }
    case 'bed': case 'bedframe': { const [w, d] = swap(1.05, 2.05); return boxOf(p, w, d); }
    case 'locker': { const [w, d] = swap(0.45, 0.5); return boxOf(p, w, d); }
    case 'gurney': { const [w, d] = swap(0.68, 1.95); return boxOf(p, w, d); }
    case 'planter': return boxOf(p, 0.65, 0.65);
    case 'turnstile': return boxOf(p, 0.6, 0.6);
    case 'crate': { const s = 0.55 + p.variant * 0.13; return boxOf(p, s, s); }
    case 'vending': { const [vw, vd] = swap(0.95, 0.85); return boxOf(p, vw, vd); }
    case 'whiteboard': { const [ww2, wd2] = swap(1.65, 0.35); return boxOf(p, ww2, wd2); }
    case 'cooler': return boxOf(p, 0.42, 0.42);
    case 'couch_l': { const [cw, cd] = swap(2.75, 2.25); return boxOf(p, cw, cd); }
    case 'shelf': { const [sw2, sd2] = swap(0.92, 0.37); return boxOf(p, sw2, sd2); }
    default: return null; // chairs/benches low enough to step over visually
  }
}

function boxOf(p: PropInstance, w: number, d: number): Box2 {
  return { minX: p.x - w / 2, minZ: p.z - d / 2, maxX: p.x + w / 2, maxZ: p.z + d / 2 };
}

export function buildColliders(layout: ChunkLayout): Box2[] {
  const out: Box2[] = [];
  for (const p of layout.props) {
    const f = propFootprint(p);
    if (f) out.push(f);
  }
  const N = CHUNK_CELLS;
  const ht = WALL_T / 2;
  const bx = layout.cx * N;
  const bz = layout.cz * N;
  const DOOR_W = 1.24;

  for (let lz = 0; lz <= N; lz++) {
    for (let lx = 0; lx < N; lx++) {
      const code = layout.hEdges[lz * N + lx];
      if (code === EdgeCode.OPEN) continue;
      const x0 = (bx + lx) * CELL;
      const x1 = x0 + CELL;
      const zc = (bz + lz) * CELL;
      if (code === EdgeCode.SOLID) {
        out.push({ minX: x0, minZ: zc - ht, maxX: x1, maxZ: zc + ht });
      } else {
        const mid = (x0 + x1) / 2;
        const dw = DOOR_W / 2;
        out.push({ minX: x0, minZ: zc - ht, maxX: mid - dw, maxZ: zc + ht });
        out.push({ minX: mid + dw, minZ: zc - ht, maxX: x1, maxZ: zc + ht });
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
        out.push({ minX: xc - ht, minZ: z0, maxX: xc + ht, maxZ: z1 });
      } else {
        const mid = (z0 + z1) / 2;
        const dw = DOOR_W / 2;
        out.push({ minX: xc - ht, minZ: z0, maxX: xc + ht, maxZ: mid - dw });
        out.push({ minX: xc - ht, minZ: mid + dw, maxX: xc + ht, maxZ: z1 });
      }
    }
  }
  return out;
}

export interface CircleBody {
  x: number; z: number; radius: number;
}

/** Resolve circle vs box overlap by minimal push-out. Returns true if moved. */
function pushOut(body: CircleBody, b: Box2): boolean {
  const cx = Math.max(b.minX, Math.min(body.x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(body.z, b.maxZ));
  const dx = body.x - cx;
  const dz = body.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= body.radius * body.radius) return false;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    const push = (body.radius - d) / d;
    body.x += dx * push;
    body.z += dz * push;
  } else {
    // center inside box: push along smallest penetration axis
    const left = body.x - b.minX, right = b.maxX - body.x;
    const up = body.z - b.minZ, down = b.maxZ - body.z;
    const m = Math.min(left, right, up, down);
    if (m === left) body.x = b.minX - body.radius;
    else if (m === right) body.x = b.maxX + body.radius;
    else if (m === up) body.z = b.minZ - body.radius;
    else body.z = b.maxZ + body.radius;
  }
  return true;
}

/** Sampled line-of-sight test against wall boxes. */
export function hasLineOfSight(
  x1: number, z1: number, x2: number, z2: number,
  colliders: readonly Box2[], steps = 14,
): boolean {
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const z = z1 + (z2 - z1) * t;
    const m = 0.05;
    for (const b of colliders) {
      if (x > b.minX - m && x < b.maxX + m && z > b.minZ - m && z < b.maxZ + m) return false;
    }
  }
  return true;
}

/** Move a circle through the collider field, sliding along surfaces. */
export function moveCircle(
  body: CircleBody,
  dx: number, dz: number,
  colliders: readonly Box2[],
): void {
  body.x += dx;
  body.z += dz;
  for (let iter = 0; iter < 3; iter++) {
    let any = false;
    for (const b of colliders) {
      // broad phase
      if (body.x + body.radius < b.minX || body.x - body.radius > b.maxX) continue;
      if (body.z + body.radius < b.minZ || body.z - body.radius > b.maxZ) continue;
      if (pushOut(body, b)) any = true;
    }
    if (!any) break;
  }
}


