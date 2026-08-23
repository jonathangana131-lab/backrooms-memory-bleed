  c.globalAlpha = 1;

  speckle(c, w, h, new RNG(layerSeed(seed, 0x3d33)), w * h * 0.008, 0.18);
  age(c, w, h, seed, 9);
  c.restore();
};

// ---------------------------------------------------------------------------
// Atlas table + dispatch
// ---------------------------------------------------------------------------

const PAINTERS: readonly CarpetPainter[] = [
  paintLoopPile,
  paintShag,
  paintDiamond,
  paintWornPath,
  paintWatermark,
  paintNeedleStripes,
];

/**
 * Salt isolating atlas variant selection from materials.ts's legacy
 * carpetVariantIndex hashing, so the two systems decorrelate per chunk.
 */
const ATLAS_VARIANT_SALT = 0xca27ab;

/**
 * Crossfade two pattern painters. Returns a NEW painter that lerps
 * a -> b as t goes 0 -> 1 (clamped). Exact per-channel lerp: A is painted
 * opaque, then B at globalAlpha = t over it (both bases are opaque, so
 * source-over yields (1-t)*A + t*B). Deterministic in seed like its inputs.
 */
export function blendPatterns(a: CarpetPainter, b: CarpetPainter, t: number): CarpetPainter {
  const tc = Math.min(1, Math.max(0, t));
  if (!(tc > 0)) return a;
  if (tc >= 1) return b;
  return (ctx: CanvasRenderingContext2D, w: number, h: number, seed: number): void => {
    a(ctx, w, h, seed);
    ctx.save();
    ctx.globalAlpha *= tc;
    b(ctx, w, h, seed);
    ctx.restore();
  };
}

/**
 * Facade over the six-pattern library. Everything is static: the atlas is
 * stateless data, callers own their canvases (DynamicTexture contexts etc).
 */
export class CarpetAtlas {
  /** Number of patterns (mirrors PATTERN_COUNT). */
  static readonly COUNT = PATTERN_COUNT;
  /** Names indexed by variant id. */
  static readonly NAMES: readonly string[] = PATTERN_NAMES;
  /**
   * Per-variant blend eligibility. Every atlas painter is vector-only and
   * alpha-composited, so all six crossfade cleanly through blendPatterns();
   * the table exists so callers can gate transitions uniformly and so
   * future non-blendable specials have a slot.
   */
  static readonly BLENDABLE: readonly boolean[] = [true, true, true, true, true, true];

  /** True when the variant may take part in a blend transition. */
  static isBlendable(variant: number): boolean {
    return this.BLENDABLE[((variant % PATTERN_COUNT) + PATTERN_COUNT) % PATTERN_COUNT] === true;
  }

  /** The raw painter for a variant (wrapped modulo the pattern count). */
  static painter(variant: number): CarpetPainter {
    const v = ((variant % PATTERN_COUNT) + PATTERN_COUNT) % PATTERN_COUNT;
    return PAINTERS[v];
  }

  /**
   * Deterministic variant index for a chunk coordinate. Independent salt
   * from materials.carpetVariantIndex, same contract: neighbors usually
   * differ, any chunk always regenerates identical.
   */
  static variantFor(cx: number, cz: number): number {
    return hash2i(cx, cz, ATLAS_VARIANT_SALT) % PATTERN_COUNT;
  }

  /** Blend painter between two variants (see blendPatterns). */
  static blend(variantA: number, variantB: number, t: number): CarpetPainter {
    return blendPatterns(this.painter(variantA), this.painter(variantB), t);
  }

  /**
   * Paint one atlas pattern onto a canvas context.
   *
   * @param ctx     any CanvasRenderingContext2D-compatible target
   * @param w,h     canvas pixel size
   * @param seed    arbitrary integer; drives all randomness
   * @param variant pattern id 0..5 (out-of-range values wrap)
   */
  static paint(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    seed: number,
    variant: number,
  ): void {
    this.painter(variant)(ctx, w, h, seed | 0);
  }
}








