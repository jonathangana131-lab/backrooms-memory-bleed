/**
 * Projected wall text - rare slide-projector ghosts on the walls of dark
 * corridors. A handful of words (FORGET, REMEMBER, IT KNOWS, DON'T LOOK)
 * appear as if thrown onto the plaster by an unseen projector one room
 * over: soft-edged, warm-white, additive-blended, flickering like a dying
 * bulb.
 *
 * Placement is pure data (deterministic per chunk seed), exactly like
 * architect.ts; only makeProjectionMesh touches Babylon.
 */
import { RNG, hash2i, hash32 } from '../core/rng';
import { CELL, CHUNK_CELLS } from '../world/constants';
// District is a const enum - referenced only as a type here so the
// transpiled module stays free of erased-enum runtime references.
import type { District } from '../world/constants';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Constants } from '@babylonjs/core/Engines/constants';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Scene } from '@babylonjs/core/scene';

/** One wall-text placement consumed by makeProjectionMesh. */
export interface ProjectionPlacement {
  /** World X of the wall edge carrying the text. */
  x: number;
  /** World Z of the wall edge carrying the text. */
  z: number;
  /** Yaw facing into the open corridor side (radians). */
  rotY: number;
  /** The projected line itself. */
  text: string;
}

/** Height of the projected quad above the floor, in meters. */
export const PROJECTION_Y = 1.55;

/** Distance the quad floats off its wall along the facing normal, in meters. */
export const PROJECTION_OFFSET = 0.02;

/** Salt keeping projection gating independent of every other feature. */
export const PROJECTION_SALT = 0x50a1;

/** ~1 chunk in 12 carries a projection. */
export const PROJECTION_PERIOD = 12;

/** The projector only knows these four sentences. */
export const PROJECTION_TEXTS: readonly string[] = [
  'FORGET',
  'REMEMBER',
  'IT KNOWS',
  "DON'T LOOK",
];

/** Minimal structural view of a chunk layout for wall lookup. */
export interface WallLookup {
  hEdges: Uint8Array;
  vEdges: Uint8Array;
}

/**
 * Deterministic placement for chunk (cx, cz). Returns null unless the
 * chunk is OPEN_OFFICE (1) or HONEYCOMB (2) and passes the 1-in-12 hash
 * gate. When walls is supplied the text lands against a real solid edge
 * whose opposite side is open (a corridor face); otherwise a plausible
 * interior wall line is chosen from the chunk hash alone.
 *
 * rotY follows the face convention (0=-z 1=+z 2=-x 3=+x wall normal)
 * translated to yaw so the quad faces into the corridor.
 *
 * @param cx Chunk X coordinate.
 * @param cz Chunk Z coordinate.
 * @param district District id of the chunk (only 1 and 2 are eligible).
 * @param seed World seed mixed into every gate and pick draw.
 * @param walls Optional chunk layout edges used for real wall-face lookup.
 * @returns The placement, or null when this chunk carries no projection.
 */
export function tryPlace(
  cx: number,
  cz: number,
  district: District | number,
  seed = 0,
  walls?: WallLookup,
): ProjectionPlacement | null {
  if (district !== 1 && district !== 2) return null;
  if ((hash2i(cx, cz, seed ^ PROJECTION_SALT) % PROJECTION_PERIOD) !== 0) return null;

  const N = CHUNK_CELLS;
  const rng = new RNG(hash2i(cx, cz, seed ^ (PROJECTION_SALT + 1)));
  const SOLID = 1; // EdgeCode.SOLID

  interface Candidate { lx: number; lz: number; face: 0 | 1 | 2 | 3 }
  let candidates: Candidate[] = [];

  if (walls) {
    const all: Candidate[] = [];
    const open: Candidate[] = [];
    for (let lz = 0; lz < N; lz++) {
      for (let lx = 0; lx < N; lx++) {
        const heIdx = lz * N + lx;
        const veIdx = lz * (N + 1) + lx;
        if (walls.hEdges[heIdx] === SOLID) {
          const c = { lx, lz, face: 0 as const };
          (walls.hEdges[(lz + 1) * N + lx] !== SOLID ? open : all).push(c);
        }
        if (walls.hEdges[(lz + 1) * N + lx] === SOLID) {
          const c = { lx, lz, face: 1 as const };
          (walls.hEdges[heIdx] !== SOLID ? open : all).push(c);
        }
        if (walls.vEdges[veIdx] === SOLID) {
          const c = { lx, lz, face: 2 as const };
          (walls.vEdges[lz * (N + 1) + lx + 1] !== SOLID ? open : all).push(c);
        }
        if (walls.vEdges[lz * (N + 1) + lx + 1] === SOLID) {
          const c = { lx, lz, face: 3 as const };
          (walls.vEdges[veIdx] !== SOLID ? open : all).push(c);
        }

      }
    }
    candidates = open.length ? open : all;
  }

  let lx: number, lz: number, face: 0 | 1 | 2 | 3;
  if (candidates.length) {
    ({ lx, lz, face } = candidates[rng.int(0, candidates.length)]);
  } else {
    lx = rng.int(1, N - 1);
    lz = rng.int(1, N - 1);
    face = rng.int(0, 4) as 0 | 1 | 2 | 3;
  }

  // jitter along the wall so text is not always dead-center in the cell
  const along = rng.range(0.3, 0.7);
  const bx = cx * N;
  const bz = cz * N;
  let x: number, z: number, rotY: number;
  switch (face) {
    case 0: // wall normal -z: text sits on the cell's north edge line
      x = (bx + lx + along) * CELL;
      z = bz * CELL + lz * CELL;
      rotY = Math.PI;
      break;
    case 1: // +z
      x = (bx + lx + along) * CELL;
      z = (bz + lz + 1) * CELL;
      rotY = 0;
      break;
    case 2: // -x
      x = bx * CELL + lx * CELL;
      z = (bz + lz + along) * CELL;
      rotY = -Math.PI / 2;
      break;
    default: // +x
      x = (bx + lx + 1) * CELL;
      z = (bz + lz + along) * CELL;
      rotY = Math.PI / 2;
      break;
  }

  const text = PROJECTION_TEXTS[hash2i(cx, cz, seed ^ (PROJECTION_SALT + 2)) % PROJECTION_TEXTS.length];
  return { x, z, text, rotY };
}

export type ProjectionMesh = Mesh & { setFlicker(tMs: number): void };

const TEX_W = 512;
const TEX_H = 128;

/**
 * Projector flicker at time tMs: a slow double-sine breathe with occasional
 * deterministic bulb sags. Pure function of tMs.
 */
export function flickerAlpha(tMs: number): number {
  const t = tMs * 0.001;
  let a = 0.86 + 0.09 * Math.sin(t * 5.9) * Math.sin(t * 1.71 + 0.6);
  const win = Math.floor(t / 2.3);
  if (hash32(win) % 97 < 14) a *= 0.42 + (hash32(win ^ 0x9e37) % 20) / 100;
  return Math.max(0, Math.min(1, a));
}

/**
 * Build the projected-text quad for a placement: canvas-generated texture
 * (soft-edged warm-white letters on transparent ground), additive-ish
 * alpha blending, floating 0.02 m off the wall. The returned mesh carries
 * setFlicker(tMs), which modulates visibility like a failing lamp.
 */
export function makeProjectionMesh(scene: Scene, place: ProjectionPlacement): ProjectionMesh {
  const tex = new DynamicTexture('projectionTex', { width: TEX_W, height: TEX_H }, scene, true);
  tex.hasAlpha = true;
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 64px "Courier New", monospace';
  ctx.save();
  ctx.translate(TEX_W / 2, TEX_H / 2);
  // outer bloom pass then hot core pass -> soft projector edge falloff
  ctx.shadowColor = 'rgba(255,240,205,0.9)';
  ctx.shadowBlur = 26;
  ctx.fillStyle = 'rgba(255,244,218,0.5)';
  ctx.fillText(place.text, 0, 0);
  ctx.shadowBlur = 9;
  ctx.fillStyle = 'rgba(255,248,232,0.95)';
  ctx.fillText(place.text, 0, 0);
  ctx.restore();
  tex.update(false);

  const mat = new StandardMaterial('projectionMat', scene);
  mat.diffuseTexture = tex;
  mat.useAlphaFromDiffuseTexture = true;
  mat.disableLighting = true;
  mat.emissiveColor = new Color3(1, 0.95, 0.84); // warm white
  mat.specularColor = new Color3(0, 0, 0);
  mat.alphaMode = Constants.ALPHA_ADD; // additive-ish: light thrown on plaster
  mat.backFaceCulling = false;
  mat.alpha = flickerAlpha(0);

  const w = Math.min(2.4, place.text.length * 0.22 + 0.3);
  const mesh = MeshBuilder.CreatePlane('projection', { width: w, height: 0.5 }, scene);
  // offset along the facing normal pushes the quad off the wall
  mesh.position.set(
    place.x + Math.sin(place.rotY) * PROJECTION_OFFSET,
    PROJECTION_Y,
    place.z + Math.cos(place.rotY) * PROJECTION_OFFSET,
  );
  mesh.rotation.y = place.rotY;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();

  const setFlicker = (tMs: number): void => {
    mat.alpha = flickerAlpha(tMs);
  };
  return Object.assign(mesh, { setFlicker }) as ProjectionMesh;
}


