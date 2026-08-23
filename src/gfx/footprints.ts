/**
 * Visible footprint trails — where you have been, written on the floor.
 *
 * Hooks the player controller's footstep events (one per bob-cycle peak,
 * see PlayerController.onFootstep / 'footstep') and stamps a small dark
 * ellipse quad under each foot, alternating left/right of the travel
 * direction. Prints fade out over FOOTPRINT_LIFETIME seconds and their
 * pool slot is recycled, so a long walk leaves a fading history behind.
 *
 * Pool management: one pre-allocated batched mesh holds FOOTPRINT_POOL_SIZE
 * quads in a ring buffer; the oldest print is recycled when the pool wraps.
 * step()/update() touch only pre-allocated typed arrays — zero allocation
 * during gameplay.
 *
 * Surface awareness: profiles are parameterized per surface type. Carpet
 * takes a slightly larger, darker stamp than hard floors (tile/metal).
 */
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

/** Fixed pool size: 40 footprint quads, ring-recycled oldest-first. */
export const FOOTPRINT_POOL_SIZE = 40;
/** Seconds a print stays visible before its slot recycles. */
export const FOOTPRINT_LIFETIME = 30;
/** Peak opacity of a fresh print; fades linearly to 0. */
export const FOOTPRINT_ALPHA = 0.25;
/** Half the stride length: splits paired left/right prints fore/aft. */
export const STRIDE_HALF = 0.23;
/** Height above the floor the quads hover at (below the wear decals). */
export const PRINT_Y = 0.008;

/** Which foot stamped last: flips on every step(). */
type Side = -1 | 1;

export type SurfaceKind = 'carpet' | 'hard';

export interface SurfaceProfile {
  /** Stamp width across the foot (metres). */
  width: number;
  /** Stamp length along the foot (metres). */
  length: number;
  /** RGB multiplier — lower = darker stamp pressed into the surface. */
  shade: number;
  /** Lateral foot offset from the travel line (metres); sprint widens gait. */
  lateral: number;
}

/** Parameterized per-surface stamp look: carpet is bigger and darker. */
export const SURFACE_PROFILES: Readonly<Record<SurfaceKind, SurfaceProfile>> = {
  carpet: { width: 0.17, length: 0.3, shade: 0.72, lateral: 0.11 },
  hard: { width: 0.13, length: 0.24, shade: 0.9, lateral: 0.09 },
};

/** Per-slot sim state, all pre-allocated once in the constructor. */

/**
 * Fading footprint trail backed by one batched, updatable mesh.
 * Construct once per player; call step() on each footstep event and
 * update(dt) every frame.
 */
export class Footprints {
  private readonly mesh: Mesh;
  private readonly profile: SurfaceProfile;

  // ---- pooled sim state (pre-allocated; mutated in place) ----
  private readonly active: Uint8Array;
  private readonly age: Float32Array;
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly pdx: Float32Array; // unit heading of the print
  private readonly pdz: Float32Array;

  // ---- GPU buffers (pre-allocated; updated in place) ----
  private readonly verts: Float32Array; // POOL*4*3 positions
  private readonly cols: Float32Array;  // POOL*4*4 rgba (a carries the fade)
  private posDirty = false;
  private colDirty = false;

  private nextSlot = 0;      // ring cursor: next slot to recycle
  private lastSide: Side = 1;
  private liveCount = 0;
  /** Total prints ever stamped this session (diagnostics/tests). */
  printsSpawned = 0;

  constructor(scene: Scene, surfaceType: SurfaceKind) {
    this.profile = SURFACE_PROFILES[surfaceType] ?? SURFACE_PROFILES.hard;
    this.active = new Uint8Array(FOOTPRINT_POOL_SIZE);
    this.age = new Float32Array(FOOTPRINT_POOL_SIZE);
    this.px = new Float32Array(FOOTPRINT_POOL_SIZE);
    this.pz = new Float32Array(FOOTPRINT_POOL_SIZE);
    this.pdx = new Float32Array(FOOTPRINT_POOL_SIZE);
    this.pdz = new Float32Array(FOOTPRINT_POOL_SIZE);

    this.verts = new Float32Array(FOOTPRINT_POOL_SIZE * 4 * 3);
    this.cols = new Float32Array(FOOTPRINT_POOL_SIZE * 4 * 4);

    // All quads start collapsed far below the floor (invisible).
    for (let q = 0; q < FOOTPRINT_POOL_SIZE; q++) this.collapseQuad(q);

    const mesh = new Mesh('footprints', scene);
    const vd = new VertexData();
    vd.positions = this.verts;
    vd.colors = this.cols;
    const idx = new Uint16Array(FOOTPRINT_POOL_SIZE * 6);
    for (let q = 0; q < FOOTPRINT_POOL_SIZE; q++) {
      const b = q * 4, o = q * 6;
      idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
      idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
    }
    vd.indices = idx;
    vd.applyToMesh(mesh, true); // updatable buffers => in-place updates
    mesh.hasVertexAlpha = true; // per-vertex fade needs alpha blending

    const mat = new StandardMaterial('footprintMat', scene);
    mat.disableLighting = true;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    // Dark grime tint; carpet shade multiplies it darker per-print.
    mat.emissiveColor = new Color3(0.06, 0.055, 0.045);
    mat.backFaceCulling = false;
    mesh.material = mat;

    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    this.mesh = mesh;
  }

  /** Number of currently visible prints. */
  get count(): number {
    return this.liveCount;
  }

  /**
   * Stamp one footprint at (x, z) travelling along unit (dirX, dirZ),
   * alternating left/right of the travel line. Reuses the oldest slot
   * when the pool is full — no allocation.
   */
  step(x: number, z: number, dirX: number, dirZ: number, sprinting: boolean): void {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return; // no meaningful heading — skip rather than stamp garbage
    const dx = dirX / len;
    const dz = dirZ / len;

    const side: Side = this.lastSide === 1 ? -1 : 1;
    this.lastSide = side;

    const p = this.profile;
    const lat = p.lateral * (sprinting ? 1.3 : 1); // sprinting gait is wider
    const fwd = side * STRIDE_HALF;                // pair interleaves fore/aft

    // perpendicular to travel: (-dz, dx)
    const cx = x + dx * fwd + -dz * lat * side;
    const cz = z + dz * fwd + dx * lat * side;

    const slot = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % FOOTPRINT_POOL_SIZE; // oldest recycled
    if (this.active[slot]) this.liveCount--; // overwriting a still-fading print
    this.active[slot] = 1;
    this.age[slot] = 0;
    this.px[slot] = cx;
    this.pz[slot] = cz;
    this.pdx[slot] = dx;
    this.pdz[slot] = dz;
    this.liveCount++;
    this.printsSpawned++;

    this.writeQuad(slot);
    this.writeColor(slot);
    this.posDirty = true;
    this.colDirty = true;
  }

  /** Advance fade timers; deactivate and collapse expired prints. */
  update(dt: number): void {
    const invLife = 1 / FOOTPRINT_LIFETIME;
    for (let i = 0; i < FOOTPRINT_POOL_SIZE; i++) {
      if (!this.active[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= FOOTPRINT_LIFETIME) {
        this.active[i] = 0;
        this.liveCount--;
        this.collapseQuad(i);
        this.posDirty = true;
        continue;
      }
      this.writeColor(i);
      this.colDirty = true;
    }
    this.flush();
  }

  /** Fade everything out immediately and reset the ring. */
  clear(): void {
    for (let i = 0; i < FOOTPRINT_POOL_SIZE; i++) {
      if (this.active[i]) {
        this.active[i] = 0;
        this.collapseQuad(i);
      }
      this.age[i] = 0;
    }
    this.liveCount = 0;
    this.nextSlot = 0;
    this.posDirty = true;
    this.colDirty = true;
    this.flush();
  }

  /** Release GPU resources. */
  dispose(): void {
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }

  // ---- test/diagnostic readouts (read-only, allocation-free) ----
  /** Current faded alpha of slot i (0 when inactive/expired). */
  alphaAt(i: number): number {
    if (!this.active[i]) return 0;
    return FOOTPRINT_ALPHA * Math.max(0, 1 - this.age[i] / FOOTPRINT_LIFETIME);
  }
  /** World position of slot i's stamp centre. */
  centerAt(i: number): { x: number; z: number } {
    return { x: this.px[i], z: this.pz[i] };
  }

  // ---- internals ----

  /** Write slot's quad corners into the shared position buffer. */
  private writeQuad(slot: number): void {
    const p = this.profile;
    const hw = p.width * 0.5;
    const hl = p.length * 0.5;
    const cx = this.px[slot];
    const cz = this.pz[slot];
    const dx = this.pdx[slot];
    const dz = this.pdz[slot];
    // right vector relative to heading: (-dz, dx)
    const rx = -dz * hw;
    const rz = dx * hw;
    const fx = dx * hl;
    const fz = dz * hl;
    const v = this.verts;
    let o = slot * 12;
    // corners: back-right, front-right, front-left, back-left
    v[o++] = cx - rx - fx; v[o++] = PRINT_Y; v[o++] = cz - rz - fz;
    v[o++] = cx + rx - fx; v[o++] = PRINT_Y; v[o++] = cz + rz - fz;
    v[o++] = cx + rx + fx; v[o++] = PRINT_Y; v[o++] = cz + rz + fz;
    v[o++] = cx - rx + fx; v[o++] = PRINT_Y; v[o++] = cz - rz + fz;
    this.posDirty = true;
  }

  /** Collapse slot's quad to a point below the floor (invisible). */
  private collapseQuad(slot: number): void {
    const v = this.verts;
    let o = slot * 12;
    for (let k = 0; k < 4; k++) {
      v[o++] = 0; v[o++] = -10; v[o++] = 0;
    }
    const c = this.cols;
    let co = slot * 16;
    for (let k = 0; k < 4; k++) {
      c[co++] = 0; c[co++] = 0; c[co++] = 0; c[co++] = 0;
    }
    this.posDirty = true;
    this.colDirty = true;
  }

  /** Write slot's shaded colour + faded alpha into the colour buffer. */
  private writeColor(slot: number): void {
    const shade = this.profile.shade;
    const a = FOOTPRINT_ALPHA * Math.max(0, 1 - this.age[slot] / FOOTPRINT_LIFETIME);
    const c = this.cols;
    let o = slot * 16;
    for (let k = 0; k < 4; k++) {
      c[o++] = shade; c[o++] = shade; c[o++] = shade; c[o++] = a;
    }
    this.colDirty = true;
  }

  /** Push dirty buffers to the GPU in place — no new arrays. */
  private flush(): void {
    if (this.posDirty) {
      this.mesh.updateVerticesData('position', this.verts);
      this.posDirty = false;
    }
    if (this.colDirty) {
      this.mesh.updateVerticesData('color', this.cols);
      this.colDirty = false;
    }
  }
}


