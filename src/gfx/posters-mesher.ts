/**
 * PosterMesherPass - emission adapter from poster placements to wall quads.
 *
 * posters.ts decides WHERE the backrooms still remembers its paper past
 * (getPostersForChunk -> {x, z, y, rotY, type, state}); this layer decides
 * how those flyers LOOK and how they reach the mesher:
 *
 *  - bakePoster        : paints paintPoster's artwork into a Babylon
 *                        DynamicTexture sized by posterCanvasSize(), one
 *                        canvas per (type, state) pair.
 *  - PosterMesherPass  : emits one wall-mounted quad per placement in exactly
 *                        the CornerAO QuadInstance decal contract - four
 *                        world-space corners CCW seen from the wall normal,
 *                        a shared surface normal, flat per-corner RGB
 *                        multipliers - plus a texture key so the consumer
 *                        can bind the matching baked DynamicTexture without
 *                        new material plumbing beyond a UV quartet.
 *
 * State-driven visuals ride two channels at once:
 *  - vertex tints scale with posterAging(state).alpha, so faded paper reads
 *    sun-bleached against the wallpaper even before texturing;
 *  - the baked canvas itself carries the state's tear notches and curl
 *    shading because paintPoster applies them for torn/faded states.
 *
 * Pure data in / pure data out for the mesher half (deterministic function
 * of the placement list, no engine dependencies, worker/test safe); only
 * bakePoster touches Babylon.
 */
import { hash2i } from '../core/rng';
import { WALL_H } from '../world/constants';
import type { Scene } from '@babylonjs/core/scene';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';

import {
  POSTER_TYPES,
  POSTER_STATES,
  posterAging,
  posterCanvasSize,
  paintPoster,
} from './posters';
import type {
  PosterCtx,
  PosterPlacement,
  PosterType,
  PosterState,
} from './posters';
import type { QuadInstance } from './cornerao';

/** Physical width of every poster quad (metres); height follows the type's canvas aspect. */
export const POSTER_QUAD_WIDTH = 0.5;
/**
 * Extra standoff added on top of placements' own POSTER_OFFSET lift so the
 * paper never z-fights the wall face or the AO/crack decals beneath it.
 */
export const POSTER_QUAD_OFFSET = 0.004;
/** Vertical clamp band keeping every corner on the wall face. */
export const POSTER_MIN_Y = 0.05;

/**
 * World-space size of one poster quad: fixed width, height stretched to
 * match the type's baked-canvas aspect ratio so pixels stay square.
 */
export function posterQuadSize(type: PosterType): { width: number; height: number } {
  const { width: cw, height: ch } = posterCanvasSize(type);
  return { width: POSTER_QUAD_WIDTH, height: POSTER_QUAD_WIDTH * (ch / cw) };
}

/**
 * Vertex tint multiplier for one aging state: the aging profile's alpha,
 * clamped into (0, 1]. Faded paper dims toward transparency-by-tint the
 * same way CornerAO darkens corners; fresh stays near-untouched.
 */
export function posterTintForState(state: PosterState): number {
  return Math.min(1, Math.max(0.05, posterAging(state).alpha));
}

/** Stable texture-cache key for one type+state pair. */
export function posterTextureKey(type: PosterType, state: PosterState): string {
  return 'poster:' + type + ':' + state;
}

/** Seed used when baking a given placement's texture (pure hash of position). */
export function posterSeedFor(poster: PosterPlacement): number {
  return hash2i(
    Math.round(poster.x * 64),
    Math.round(poster.z * 64),
    poster.type.length * 7 + poster.state.length,
  );
}

/**
 * Paint one poster's full artwork (base drawing + aging + tears) into any
 * 2D context at the type's canonical canvas size. Deterministic pure
 * wrapper over paintPoster - usable with real canvases or test stubs.
 */
export function renderPosterInto(
  ctx: PosterCtx,
  type: PosterType,
  state: PosterState,
  seed = 0,
): { width: number; height: number } {
  const { width, height } = posterCanvasSize(type);
  paintPoster(ctx, width, height, type, state, seed);
  return { width, height };
}

/**
 * Bake one poster variant into a fresh DynamicTexture sized by
 * posterCanvasSize() and upload it to the GPU. Deterministic for a given
 * (type, state, seed): identical arguments yield pixel-identical faces.
 */
export function bakePoster(
  scene: Scene,
  poster: Pick<PosterPlacement, 'type' | 'state'> & Partial<Pick<PosterPlacement, 'x' | 'z'>>,
  seed?: number,
): DynamicTexture {
  const s = seed ?? posterSeedFor({ ...poster, x: poster.x ?? 0, z: poster.z ?? 0, y: 0, rotY: 0 });
  const { width, height } = posterCanvasSize(poster.type);
  const tex = new DynamicTexture(
    'posterTex_' + posterTextureKey(poster.type, poster.state),
    { width, height },
    scene,
    true,
  );
  const ctx = tex.getContext() as unknown as PosterCtx;
  renderPosterInto(ctx, poster.type, poster.state, s);
  tex.update(false);
  return tex;
}

/** One emitted poster quad: the CornerAO contract plus binding metadata. */
export interface PosterQuad extends QuadInstance {
  /** Which baked texture to bind (see bakePoster / posterTextureKey). */
  textureKey: string;
  /** Poster type carried through for material caching / debugging. */
  type: PosterType;
  /** Aging state carried through for material caching / debugging. */
  state: PosterState;
  /** Scalar alpha behind the four tints (== every tint component). */
  alpha: number;
}

/** Snap an arbitrary yaw to the nearest wall-aligned quarter turn. */
function snapYaw(rotY: number): number {
  const q = Math.round(rotY / (Math.PI / 2));
  return (((q % 4) + 4) % 4) * (Math.PI / 2);
}

export interface PosterMesherOptions {
  /** Wall-face standoff in metres (added to the placement's own lift). Default POSTER_QUAD_OFFSET. */
  offset?: number;
}

/**
 * Converts poster placements into wall-mounted QuadInstance decals.
 * Integrate-ready beside CornerAO/moisture/crackmesher: for each returned
 * quad q, emit quad() from q.positions/q.normal with the standard uv
 * quartet (0,0)(1,0)(1,1)(0,1), multiply the four fresh vertices' color
 * channels pairwise by q.tints, and bind the texture named q.textureKey.
 */
export class PosterMesherPass {
  readonly offset: number;

  constructor(opts: PosterMesherOptions = {}) {
    this.offset = Math.max(0, opts.offset ?? POSTER_QUAD_OFFSET);
  }

  /**
   * All poster quads for the given placements. Deterministic: identical
   * inputs produce byte-identical quad lists, in input order.
   */
  generate(posters: readonly PosterPlacement[]): PosterQuad[] {
    const out: PosterQuad[] = [];
    for (const poster of posters) {
      if (!poster || !Number.isFinite(poster.x)
        || !Number.isFinite(poster.y) || !Number.isFinite(poster.z)
        || !Number.isFinite(poster.rotY)) continue;
      out.push(this.emit(poster));
    }
    return out;
  }

  /** Emit one wall-mounted poster quad for a single placement. */
  emit(poster: PosterPlacement): PosterQuad {
    const rotY = snapYaw(poster.rotY);
    // Wall-face basis: n points into the open corridor, t runs along the
    // wall run (same convention as crackmesher).
    const nx = Math.sin(rotY);
    const nz = Math.cos(rotY);
    const tx = nz;
    const tz = -nx;

    // Standoff along the facing normal keeps the paper proud of the wall
    // and of any decals layered beneath it.
    const ox = poster.x + nx * this.offset;
    const oz = poster.z + nz * this.offset;

    const { width: w, height: h } = posterQuadSize(poster.type);
    const hw = w / 2;
    const hh = h / 2;

    // Clamp the vertical span onto the wall face (the mount band 1.4-1.7 m
    // already clears both limits; the clamp guards degenerate input).
    const cy = Math.min(WALL_H - POSTER_MIN_Y, Math.max(POSTER_MIN_Y, poster.y));

    // Four corners CCW seen from the wall-normal side, matching the mesher
    // uv quartet (0,0)(1,0)(1,1)(0,1): bottom-left, bottom-right, top-right,
    // top-left in tangent space.
    const su = [-hw, hw, hw, -hw]; // along the wall tangent
    const sv = [-hh, -hh, hh, hh]; // up the wall
    const positions: number[] = [];
    for (let i = 0; i < 4; i++) {
      positions.push(ox + tx * su[i], Math.min(WALL_H - POSTER_MIN_Y, Math.max(POSTER_MIN_Y, cy + sv[i])), oz + tz * su[i]);
    }

    // State-driven alpha rides the shared tint channel.
    const shade = posterTintForState(poster.state);
    const tints: number[] = [];
    for (let i = 0; i < 12; i++) tints.push(shade);

    return {
      positions,
      normal: [nx, 0, nz],
      tints,
      textureKey: posterTextureKey(poster.type, poster.state),
      type: poster.type,
      state: poster.state,
      alpha: shade,
    };
  }
}

/** Every distinct baked-texture key across all type x state variants. */
export const ALL_POSTER_TEXTURE_KEYS: readonly string[] =
  POSTER_TYPES.flatMap((t) => POSTER_STATES.map((s) => posterTextureKey(t, s)));


