/**
 * WetReflections - fake planar reflections inside puddle zones.
 *
 * Real MirrorTexture costs a second render pass per frame, which is far too
 * expensive to leave running everywhere. Instead we cheat: light fixtures
 * standing near an active puddle get a dimmed twin rendered BELOW the floor
 * plane (y < 0). Seen through the semi-glossy puddle decal the twin reads as
 * a wobbling water reflection; anywhere else it is swallowed by the floor.
 *
 * Performance contract (mirrors the rest of src/gfx):
 *  - reflection meshes exist ONLY while the player stands within
 *    CREATE_DIST (10 m) of some registered puddle; beyond DISPOSE_DIST
 *    (12 m) every reflection mesh is disposed again. The 2 m band gives
 *    hysteresis so loitering on the boundary cannot thrash creation.
 *  - only fixtures within FIXTURE_RANGE (8 m) of an ACTIVE puddle (one
 *    itself within CREATE_DIST of the player) are reflected, capped at
 *    MAX_REFLECTIONS meshes.
 *  - ripples are a cheap CPU sine wave on the reflection vertices, animated
 *    through preallocated Float32Arrays - no steady state allocation.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

/** Player-to-puddle distance at which reflections are created (meters). */
export const CREATE_DIST = 10;
/** Player-to-puddle distance at which reflections are disposed (meters). */
export const DISPOSE_DIST = 12;
/** Fixture-to-puddle distance inside which a fixture gets reflected (m). */
export const FIXTURE_RANGE = 8;
/** Maximum simultaneous reflection meshes. */
export const MAX_REFLECTIONS = 16;
/** Ripple wave height on reflection vertices (meters). */
export const RIPPLE_AMPLITUDE = 0.02;
/** Ripple wavelength along the wave direction (meters). */
export const RIPPLE_WAVELENGTH = 0.45;
/** Ripple travel speed (meters per second). */
export const RIPPLE_SPEED = 1.6;
/** Heavy fade applied to every reflection (0 = invisible, 1 = solid). */
export const REFLECTION_ALPHA = 0.24;
/** Depth below the floor where reflections sit (meters, negative). */
export const REFLECTION_Y = -0.06;

/** Minimal world-space point used throughout the public API. */
export interface XZPoint {
  x: number;
  z: number;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/**
 * Pure selection logic: which fixtures should be reflected right now?
 *
 * A fixture qualifies when some ACTIVE puddle (within CREATE_DIST of the
 * player) lies within FIXTURE_RANGE of it. Order follows the input fixture
 * order; capped at maxCount results. Exported separately so tests can pin
 * the rules without spinning up a scene.
 */
export function selectReflections(
  puddles: readonly XZPoint[],
  fixtures: readonly XZPoint[],
  px: number,
  pz: number,
  maxCount: number = MAX_REFLECTIONS,
): XZPoint[] {
  const out: XZPoint[] = [];
  if (!puddles.length || !fixtures.length || maxCount <= 0) return out;

  const createR2 = CREATE_DIST * CREATE_DIST;
  const rangeR2 = FIXTURE_RANGE * FIXTURE_RANGE;

  outer:
  for (const f of fixtures) {
    for (const p of puddles) {
      // puddle must be active (near enough to the player to be seen)
      if (dist2(p.x, p.z, px, pz) > createR2) continue;
      // and close enough to this fixture to mirror it
      if (dist2(f.x, f.z, p.x, p.z) <= rangeR2) {
        out.push(f);
        if (out.length >= maxCount) break outer;
        break;
      }
    }
  }
  return out;
}

/** Stable string identity of a selected fixture set (rounded to cm). */
function signature(sel: readonly XZPoint[]): string {
  let s = '';
  for (const f of sel) s += f.x.toFixed(2) + ',' + f.z.toFixed(2) + ';';
  return s;
}

interface ReflEntry {
  mesh: Mesh;
  /** Rest pose of vertex y values; ripple offsets are added on top. */
  baseY: Float32Array;
  phase: number;
}

export class WetReflections {
  private scene: Scene;
  private mat: StandardMaterial | null = null;
  private puddles: XZPoint[] = [];
  private entries: ReflEntry[] = [];
  private live = false;
  private sig = '';
  private time = Math.random() * 100;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** Number of live reflection meshes (0 while idle). */
  get reflectionCount(): number {
    return this.entries.length;
  }

  /** True while the system is armed (player inside the puddle band). */
  get isLive(): boolean {
    return this.live;
  }

  /** Debug/test access to the i-th reflection mesh. */
  meshAt(i: number): Mesh | null {
    return this.entries[i] ? this.entries[i].mesh : null;
  }

  /**
   * Register puddle zones (replaces any previous list). Positions are world
   * meters on the floor plane. Callers should feed layout.puddles from all
   * loaded chunks.
   */
  setPuddles(points: readonly XZPoint[]): void {
    this.puddles = Array.isArray(points) ? points.slice() : [];
  }

  /**
   * Advance the system. px, pz is the player ground position; fixtures is
   * the light-fixture list of loaded chunks ({x, z} suffices).
   */
  update(dt: number, px: number, pz: number, fixtures: readonly XZPoint[] = []): void {
    // ---- performance guard: create near, dispose far -----------------
    let nearest2 = Infinity;
    for (const p of this.puddles) {
      const d2 = dist2(p.x, p.z, px, pz);
      if (d2 < nearest2) nearest2 = d2;
    }

    if (!this.live) {
      if (this.puddles.length > 0 && nearest2 <= CREATE_DIST * CREATE_DIST) {
        this.build(selectReflections(this.puddles, fixtures, px, pz));
      }
    } else {
      const gone = this.puddles.length === 0 || nearest2 > DISPOSE_DIST * DISPOSE_DIST;
      if (gone) {
        this.destroy();
      } else {
        // fixture set changed (chunks loaded/unloaded) -> rebuild cheaply
        const sel = selectReflections(this.puddles, fixtures, px, pz);
        const s = signature(sel);
        if (s !== this.sig) this.build(sel);
      }
    }

    // ---- ripple animation ---------------------------------------------
    if (dt > 0 && this.entries.length > 0) {
      this.time += dt > 0.1 ? 0.1 : dt; // tab-back spike guard
      this.animate();
    }
  }

  /** Dispose every reflection mesh and release the shared material. */
  dispose(): void {
    this.destroy();
    if (this.mat) {
      this.mat.dispose();
      this.mat = null;
    }
  }

  // ------------------------------------------------------------------

  private ensureMaterial(): void {
    if (this.mat) return;
    const mat = new StandardMaterial('wetReflMat', this.scene);

  private ensureMaterial(): void {
    if (this.mat) return;
    const mat = new StandardMaterial('wetReflMat', this.scene);
    // Dimmed echo of the fluorescent tube color, heavily faded.
    mat.emissiveColor = new Color3(0.14, 0.13, 0.10);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.alpha = REFLECTION_ALPHA;
    mat.backFaceCulling = false;
    this.mat = mat;
  }

  private build(sel: readonly XZPoint[]): void {
    this.destroy();
    if (sel.length === 0) {
      this.live = this.puddles.length > 0; // armed; nothing to mirror yet
      return;
    }
    this.ensureMaterial();

    const count = Math.min(sel.length, MAX_REFLECTIONS);
    for (let i = 0; i < count; i++) {
      const f = sel[i];
      // Fluorescent tube footprint, varied deterministically per fixture.
      const w = 1.35 + 0.25 * Math.abs(Math.sin(f.x * 7.31 + f.z * 3.77));
      const depth = 0.32;
      const mesh = MeshBuilder.CreateGround(
        'wetRefl' + i,
        { width: w, height: depth, subdivisionsX: 4, subdivisionsY: 2, updatable: true },
        this.scene,
      );
      mesh.material = this.mat;
      mesh.isPickable = false;
      mesh.position.set(f.x, REFLECTION_Y, f.z);

      const posData = mesh.getVerticesData('position');
      const baseY = posData
        ? Float32Array.from(posData.filter((_, idx) => idx % 3 === 1))
        : new Float32Array(0);

      const phase = Math.abs(Math.sin(f.x * 12.9898 + f.z * 78.233)) * Math.PI * 2;
      this.entries.push({ mesh: mesh, baseY: baseY, phase: phase });
    }

    this.sig = signature(sel.slice(0, this.entries.length));
    this.live = true;
    // No animate() here: meshes keep their flat rest pose until the next
    // update with dt > 0 drives the ripple clock.
  }

  private destroy(): void {
    for (const e of this.entries) e.mesh.dispose();
    this.entries.length = 0;
    this.sig = '';
    this.live = false;
  }

  /** Sine-wave y-offset on reflection vertices: fake water movement. */


    const dirZ = 0.70710678;
    for (let ei = 0; ei < this.entries.length; ei++) {
      const e = this.entries[ei];
      const pos = e.mesh.getVerticesData('position');
      if (!pos || e.baseY.length === 0) continue;
      const n = e.baseY.length;
      const out = new Float32Array(pos.length);
      for (let vi = 0; vi < n; vi++) {
        const ix = vi * 3;
        const lx = pos[ix];
        const lz = pos[ix + 2];
        out[ix] = lx;
        out[ix + 1] =
          e.baseY[vi] + RIPPLE_AMPLITUDE * Math.sin(k * (lx * dirX + lz * dirZ) + t + e.phase);
        out[ix + 2] = lz;
      }
      e.mesh.setVerticesData('position', out);
    }
  }
}


