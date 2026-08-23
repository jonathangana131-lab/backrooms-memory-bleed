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


          // Hot cores riding each lobe keep the twin-tube read bright.
          g(0.5, 0.37, 0.15, 1.8, 0.42, [[0.0, 1.0], [1.0, 0.25]]),
          g(0.5, 0.63, 0.15, 1.8, 0.42, [[0.0, 1.0], [1.0, 0.25]]),
          // Wide dim fill so the housing never samples fully dark.
          g(0.5, 0.5, 0.30, 2.1, 0.95, [[0.0, 0.30], [1.0, 0.0]]),
        ],
        noiseSeed: 404,
        noiseAmount: 0.12,
      };
    case VARIANT_RECT_SOFT:
    default:
      // Troffer panel: broad soft plate, near-isotropic falloff, faint
      // corner lift from side lobes. Also the out-of-range fallback.
      return {
        size: POOL_TEXTURE_SIZE,
        gradients: [
          g(0.5, 0.5, 0.30, 1.55, 1.55, [[0.0, 0.80], [0.6, 0.50], [1.0, 0.0]]),
          g(0.5, 0.5, 0.16, 1.45, 1.45, [[0.0, 0.95], [1.0, 0.20]]),
          g(0.28, 0.5, 0.18, 1.2, 1.3, [[0.0, 0.30], [1.0, 0.0]]),
          g(0.72, 0.5, 0.18, 1.2, 1.3, [[0.0, 0.30], [1.0, 0.0]]),
          g(0.5, 0.26, 0.16, 1.3, 1.2, [[0.0, 0.28], [1.0, 0.0]]),
          g(0.5, 0.74, 0.16, 1.3, 1.2, [[0.0, 0.28], [1.0, 0.0]]),
        ],
        noiseSeed: 303,
        noiseAmount: 0.06,
      };
  }
}

/** Evaluate one gradient's falloff profile at a normalized sample point. */
function evalGradient(gr: PoolGradient, u: number, v: number): number {
  const dx = (u - gr.cx) / gr.sx;
  const dy = (v - gr.cy) / gr.sy;
  const d = Math.sqrt(dx * dx + dy * dy) / gr.r;
  const stops = gr.stops;
  if (d <= stops[0].at) return stops[0].a;
  for (let i = 1; i < stops.length; i++) {
    if (d <= stops[i].at) {
      const span = stops[i].at - stops[i - 1].at;
      const t = span > 0 ? (d - stops[i - 1].at) / span : 1;
      return stops[i - 1].a + (stops[i].a - stops[i - 1].a) * t;
    }
  }
  return 0;
}

/**
 * Analytic composite of one variant's pool at normalized texture coords
 * (u, v). Mirrors paint(): additive gradient composition followed by the
 * seeded edge-noise mottle, so tests can reason about coverage without a
 * canvas.
 */
export function sampleAlpha(variant: number, u: number, v: number): number {
  return LightPools.sampleAlpha(variant, u, v);
}

/** Class-surface alias so consumers can reach the sampler without a second import. */
export function sampleAlphaImpl(variant: number, u: number, v: number): number {
  const spec = LightPools.getTexture(variant);
  let a = 0;
  for (const gr of spec.gradients) a += evalGradient(gr, u, v);
  if (spec.noiseAmount > 0) {
    // Value-noise mottle centered on zero: brightens as often as it dims
    // so mean coverage survives while silhouettes turn ragged.
    const n = fbm2(u * 48, v * 48, 2, 2, 0.5, spec.noiseSeed);
    a += (n - 0.5) * spec.noiseAmount * 0.9;
  }
  return Math.min(1, Math.max(0, a));
}

/**
 * Rasterize a spec onto a canvas context: radial gradients composited in
 * 'lighter' mode, then a seeded per-texel jitter pass approximating the
 * analytic noise in sampleAlpha(). Consumers own texture lifecycle.
 */
export function paint(ctx: CanvasRenderingContext2D, spec: PoolTextureSpec): void {
  ctx.clearRect(0, 0, spec.size, spec.size);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const gr of spec.gradients) {
    const cx = gr.cx * spec.size;
    const cy = gr.cy * spec.size;
    const r = gr.r * spec.size;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const stop of gr.stops) {
      grad.addColorStop(Math.min(1, Math.max(0, stop.at)), 'rgba(255,255,255,' + stop.a.toFixed(3) + ')');
    }
    ctx.setTransform(gr.sx, 0, 0, gr.sy, cx * (1 - gr.sx), cy * (1 - gr.sy));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, spec.size, spec.size);
  }
  ctx.restore();

  if (spec.noiseAmount > 0) {
    // Edge irregularity: seeded dabs matching the fbm field used by
    // sampleAlpha, so bitmaps and analytic samples stay comparable.
    const rng = new RNG(spec.noiseSeed);
    ctx.save();
    for (let i = 0; i < spec.size * 3; i++) {
      const x = rng.next() * spec.size;
      const y = rng.next() * spec.size;
      const n = fbm2((x / spec.size) * 48, (y / spec.size) * 48, 2, 2, 0.5, spec.noiseSeed);
      const dA = (n - 0.5) * spec.noiseAmount * 0.9;
      if (Math.abs(dA) < 0.02) continue;
      ctx.globalAlpha = Math.min(1, Math.abs(dA));
      ctx.fillStyle = dA > 0 ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,1)';
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
  }
}

/**
 * Fixture -> pool-shape assignment. Pure hashing of world position: any
 * chunk regenerates identical pools for identical fixtures in any order.
 */
export class LightPools {
  private static cache = new Map<number, PoolTextureSpec>();

  /** Wrap any integer into the canonical variant range. */
  private static wrap(variant: number): number {
    return ((variant % POOL_VARIANT_COUNT) + POOL_VARIANT_COUNT) % POOL_VARIANT_COUNT;
  }

  /**
   * Declarative texture spec for a variant (cached per variant).
   * Out-of-range variants fall back to the soft rectangle.
   */
  static getTexture(variant: number): PoolTextureSpec {
    const v = this.wrap(variant);
    let spec = this.cache.get(v);
    if (!spec) {
      spec = buildSpec(v);
      this.cache.set(v, spec);
    }
    return spec;
  }

  /** Deterministic pool variant for a fixture at world (wx, wz). */
  static variantFor(wx: number, wz: number): number {
    // Quarter-metre quantization keeps neighbouring fixtures distinct
    // while remaining stable under float re-derivation.
    return hash2i(Math.round(wx * 4), Math.round(wz * 4), SALT_VARIANT) % POOL_VARIANT_COUNT;
  }

  /** Deterministic pool rotation in [0, 2*PI), independent of variant. */
  static rotationFor(wx: number, wz: number): number {
    return rand2(Math.round(wx * 4), Math.round(wz * 4), SALT_ROTATION) * Math.PI * 2;
  }

  /** Analytic pool coverage at normalized (u, v) — see sampleAlpha(). */
  static sampleAlpha(variant: number, u: number, v: number): number {
    const spec = this.getTexture(variant);
    let a = 0;
    for (const gr of spec.gradients) a += evalGradient(gr, u, v);
    if (spec.noiseAmount > 0) {
      // Value-noise mottle centered on zero: brightens as often as it dims
      // so mean coverage survives while silhouettes turn ragged.
      const n = fbm2(u * 48, v * 48, 2, 2, 0.5, spec.noiseSeed);
      a += (n - 0.5) * spec.noiseAmount * 0.9;
    }
    return Math.min(1, Math.max(0, a));
  }
}
