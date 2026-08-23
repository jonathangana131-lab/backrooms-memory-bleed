/*********************************************************************
 * Procedural light-pool shapes for fluorescent fixtures.
 *
 * Every alive fixture casts a floor pool through the pooled PointLight
 * rig (src/gfx/lighting.ts); until now those pools were implicitly
 * perfect circles. Real fixtures are NOT circular emitters - a troffer
 * panel spills a soft rectangle, a bare tube an elongated streak, an
 * aged diffuser a mottled blob, and a twin-tube housing two overlapping
 * lobes.
 *
 * This module owns four procedural pool textures plus the deterministic
 * fixture -> (variant, rotation) assignment. It is PURE canvas logic:
 *
 *   - getTexture() returns a declarative spec ({size, gradient stops,
 *     seeded edge-noise}) - no DOM, no Babylon, safe in workers/tests.
 *   - sampleAlpha() evaluates the composited spec analytically so tests
 *     can reason about pool coverage without a canvas.
 *   - paint() rasterizes a spec onto a CanvasRenderingContext2D (radial
 *     gradients in 'lighter' composite, then seeded value-noise jitter)
 *     for consumers that want a real bitmap (DynamicTexture / decal).
 *
 * Assignment hashes the fixture's world position, so any chunk
 * regenerates the identical pool shape for the identical fixture, in
 * any order.
 ********************************************************************/

import { hash2i, rand2, fbm2 } from '../core/rng';

/** Number of distinct pool variants (see VARIANT_* constants). */
export const POOL_VARIANT_COUNT = 4;

/** Texture edge length in texels (power of two for GPU friendliness). */
export const POOL_TEXTURE_SIZE = 128;

/** Salt for the fixture -> variant hash (arbitrary, fixed forever). */
const SALT_VARIANT = 0x1f2e3d;

/** Salt for the independent rotation hash. */
const SALT_ROTATION = 0x51ed;

/** One falloff stop on a radial gradient profile. */
export interface PoolStop {
  /** Gradient radius fraction where this stop sits, 0..1. */
  at: number;
  /** Luminance/alpha at this stop, 0..1. */
  a: number;
}

/** One radial gradient contribution, in normalized 0..1 texture space. */
export interface PoolGradient {
  /** Center, normalized 0..1 (0.5 = texture middle). */
  cx: number;
  cy: number;
  /** Base radius as a fraction of texture size, before axis scaling. */
  r: number;
  /** Axis scales applied around the center (1 = circle, >1 stretches). */
  sx: number;
  sy: number;
  /** Falloff profile, sorted ascending by 'at', ending at the rim. */
  stops: PoolStop[];
}

/** Declarative canvas spec returned by LightPools.getTexture(). */
export interface PoolTextureSpec {
  /** Texture edge length in texels. */
  size: number;
  /** Radial gradients composited additively ('lighter'). */
  gradients: PoolGradient[];
  /** Seed for the edge-irregularity noise pass. */
  noiseSeed: number;
  /** Edge irregularity amount 0..1 (0 = clean silhouette). */
  noiseAmount: number;
}

/** Variant 0: standard fluorescent troffer - soft rounded rectangle. */
export const VARIANT_RECT_SOFT = 0;
/** Variant 1: single tube - elongated oval streak. */
export const VARIANT_TUBE_OVAL = 1;
/** Variant 2: aged diffuser - mottled irregular blob. */
export const VARIANT_AGED_BLOB = 2;
/** Variant 3: twin-tube housing - dual-lobe footprint. */
export const VARIANT_DUAL_LOBE = 3;

function g(
  cx: number, cy: number, r: number, sx: number, sy: number,
  stops: [number, number][],
): PoolGradient {
  const out: PoolStop[] = [];
  for (const pair of stops) out.push({ at: pair[0], a: pair[1] });
  return { cx, cy, r, sx, sy, stops: out };
}

/**
 * Build the declarative spec for one variant. Deterministic: same variant
 * in, same spec out, forever.
 */
function buildSpec(variant: number): PoolTextureSpec {
  switch (((variant % POOL_VARIANT_COUNT) + POOL_VARIANT_COUNT) % POOL_VARIANT_COUNT) {
    case VARIANT_TUBE_OVAL:
      // Bare tube: one stretched hot core inside a longer dim streak.
      return {
        size: POOL_TEXTURE_SIZE,
        gradients: [
          g(0.5, 0.5, 0.34, 2.25, 0.52, [[0.0, 0.85], [0.55, 0.55], [1.0, 0.0]]),
          g(0.5, 0.5, 0.17, 2.05, 0.48, [[0.0, 1.0], [1.0, 0.25]]),
        ],
        noiseSeed: 101,
        noiseAmount: 0.10,
      };
    case VARIANT_AGED_BLOB:
      // Aged diffuser: off-center mottled radials + heavy edge noise.
      return {
        size: POOL_TEXTURE_SIZE,
        gradients: [
          g(0.46, 0.52, 0.34, 1.15, 0.95, [[0.0, 0.95], [0.6, 0.55], [1.0, 0.0]]),
          g(0.60, 0.40, 0.22, 1.0, 1.0, [[0.0, 0.75], [1.0, 0.0]]),
          g(0.38, 0.66, 0.19, 0.9, 1.1, [[0.0, 0.60], [1.0, 0.0]]),
          g(0.63, 0.68, 0.13, 1.0, 0.9, [[0.0, 0.45], [1.0, 0.0]]),
        ],
        noiseSeed: 202,
        noiseAmount: 0.45,
      };
    case VARIANT_DUAL_LOBE:
      // Twin tube: two parallel elongated lobes joined by a faint bridge.
      return {
        size: POOL_TEXTURE_SIZE,
        gradients: [
          g(0.5, 0.37, 0.26, 1.95, 0.50, [[0.0, 0.95], [0.55, 0.55], [1.0, 0.0]]),
          g(0.5, 0.63, 0.26, 1.95, 0.50, [[0.0, 0.95], [0.55, 0.55], [1.0, 0.0]]),
          g(0.5, 0.5, 0.12, 2.4, 0.9, [[0.0, 0.35], [1.0, 0.0]]),


