/**
 * CarpetAtlas: procedural floor-pattern library for BACKROOMS: MEMORY BLEED.
 *
 * Six distinct carpet weaves beyond the base fiber noise in materials.ts,
 * each painted by a PURE function (ctx, w, h, seed):
 *
 *   0 tight loop pile   - dense little loops, uniform commercial tufting
 *   1 shag              - long irregular fibers, deep pile chaos
 *   2 diamond geometric - hotel-convention-center diamond lattice
 *   3 worn path         - traffic-darkened lanes ground into the nap
 *   4 watermarked       - sun-faded ghost of an older decorative motif
 *   5 industrial needle-stripes - glued-down needlepunch strip flooring
 *
 * Design rules:
 *  - Deterministic: every painter derives its randomness exclusively from
 *    the seed argument via the shared hash-RNG (src/core/rng.ts). Same
 *    (variant, seed) => byte-identical call sequence, forever.
 *  - Vector-only: painters NEVER touch getImageData/putImageData. Pixel ops
 *    bypass canvas compositing and would punch through crossfades; fill and
 *    stroke ops respect globalAlpha, so blendPatterns() can lerp two
 *    patterns exactly: paint A opaque, then B at globalAlpha = t gives
 *    (1 - t) * A + t * B per channel because both are fully opaque bases.
 *  - Palette conventions follow src/gfx/materials.ts paintCarpet():
 *    mustard base #7a6a33, dark fibers #4d411e, light fibers #96823f,
 *    grime rgba(30,24,8,*), bleach rgba(120,100,40,*).
 *  - No Babylon imports: safe to run headless (tests, workers).
 */

import { RNG, hash2i, rand2, fbm2 } from '../core/rng';

// ---------------------------------------------------------------------------
// Palette + shared constants (mirrors materials.ts carpet conventions)
// ---------------------------------------------------------------------------

const CARPET_BASE = '#7a6a33';
const CARPET_DARK = '#4d411e';
const CARPET_LIGHT = '#96823f';
/** Grime tone used for traffic wear / stains (matches markDirty splats). */
const GRIME_RGB = '30,24,8';
/** Bleach tone used for faded motifs (matches light blobs). */
const BLEACH_RGB = '120,100,40';

/** Number of distinct patterns in the atlas. */
export const PATTERN_COUNT = 6;

/** Human-readable names, indexed by variant id. */
export const PATTERN_NAMES: readonly string[] = [
  'loop-pile',
  'shag',
  'diamond',
  'worn-path',
  'watermark',
  'needle-stripes',
];

/** A pure carpet texture painter. Must be deterministic in seed. */
export type CarpetPainter = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
) => void;

// ---------------------------------------------------------------------------
// Shared painting helpers (vector-only, alpha-safe)
// ---------------------------------------------------------------------------

/**
 * Speckle grain: the vector-mode stand-in for materials.ts paintNoise().
 * Thousands of tiny 1-2px rect dabs in alternating dark/light tones read as
 * fiber noise while remaining fully crossfadable.
 */
function speckle(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  rng: RNG,
  count: number,
  maxAlpha: number,
): void {
  const n = Math.max(1, Math.round(count));
  for (let i = 0; i < n; i++) {
    c.globalAlpha = maxAlpha * (0.35 + 0.65 * rng.next());
    c.fillStyle = rng.chance(0.5) ? CARPET_DARK : CARPET_LIGHT;
    c.fillRect(rng.next() * w, rng.next() * h, rng.chance(0.3) ? 2 : 1, 1);
  }
  c.globalAlpha = 1;
}

/** Radial stain bloom, same recipe as the blobs() helper in materials.ts. */
function stain(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  rng: RNG,
  rgb: string,
  minR: number,
  maxR: number,
  alpha: number,
): void {
  const x = rng.next() * w;
  const y = rng.next() * h;
  const r = rng.range(minR, maxR);
  const g = c.createRadialGradient(x, y, r * 0.1, x, y, r);
  g.addColorStop(0, 'rgba(' + rgb + ',' + (alpha * rng.range(0.5, 1)).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(' + rgb + ',0)');
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Scatter a few grime blooms; every carpet ages a little. */
function age(
  c: CanvasRenderingContext2D,
  w: number,
  h: number,
  seed: number,
  count: number,
): void {
  const rng = new RNG((seed ^ 0xbeef01) >>> 0);
  for (let i = 0; i < count; i++) stain(c, w, h, rng, GRIME_RGB, w * 0.03, w * 0.16, 0.16);
}

/** Layer seed derivation: keeps each painter's random streams far apart. */
function layerSeed(seed: number, salt: number): number {
  return (seed ^ salt) >>> 0;
}

// ---------------------------------------------------------------------------
// Pattern 0: tight loop pile
// ---------------------------------------------------------------------------

const paintLoopPile: CarpetPainter = (c, w, h, seed) => {
  c.save();
  c.fillStyle = CARPET_BASE;
  c.fillRect(0, 0, w, h);

  // Uniform commercial tufting: a tight grid of tiny loops (arcs), each
  // individually toned so the surface reads dense but never flat.
  const rng = new RNG(layerSeed(seed, 0xa110));
  const step = Math.max(3, Math.round(Math.min(w, h) / 96));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const tone = rng.next();
      c.globalAlpha = 0.10 + 0.16 * rng.next();
      c.strokeStyle = tone < 0.45 ? CARPET_DARK : tone < 0.85 ? CARPET_LIGHT : '#b09a48';
      c.lineWidth = 1;
      c.beginPath();
      c.arc(x + rng.range(-0.6, 0.6), y + rng.range(-0.6, 0.6), step * 0.42, 0, Math.PI, tone < 0.5);
      c.stroke();
    }
  }
  c.globalAlpha = 1;

  speckle(c, w, h, new RNG(layerSeed(seed, 0xa111)), w * h * 0.02, 0.28);
  age(c, w, h, seed, 8);
  c.restore();
};

// ---------------------------------------------------------------------------
// Pattern 1: shag (long irregular fibers)
// ---------------------------------------------------------------------------

const paintShag: CarpetPainter = (c, w, h, seed) => {
  c.save();
  // Shag reads a touch deeper/darker than flatweave before fibers land.
  c.fillStyle = '#6e5f2d';
  c.fillRect(0, 0, w, h);

  // Three passes: dark under-fibers, mid matting, bright stray highlights.
  const passes: Array<{ n: number; salt: number; len: number; alpha: number }> = [
    { n: 520, salt: 0x5ba9, len: 0.13, alpha: 0.20 },
    { n: 700, salt: 0x5baa, len: 0.09, alpha: 0.22 },
    { n: 260, salt: 0x5bab, len: 0.05, alpha: 0.24 },
  ];
  for (const p of passes) {
    const rng = new RNG(layerSeed(seed, p.salt));
    c.lineWidth = rng.range(1, 2.2);
    for (let i = 0; i < p.n; i++) {
      const x = rng.next() * w;
      const y = rng.next() * h;
      const ang = rng.next() * Math.PI * 2;
      const len = h * p.len * rng.range(0.5, 1.2);
      // Irregular bend: control point pushes the fiber off its chord.
      const bend = rng.range(-0.5, 0.5);
      c.globalAlpha = p.alpha * rng.range(0.5, 1);
      c.strokeStyle = rng.chance(0.55) ? CARPET_DARK : CARPET_LIGHT;
      c.beginPath();
      c.moveTo(x, y);
      c.quadraticCurveTo(
        x + Math.cos(ang + bend) * len * 0.5,
        y + Math.sin(ang + bend) * len * 0.5,
        x + Math.cos(ang) * len,
        y + Math.sin(ang) * len,
      );
      c.stroke();
    }
  }
  c.globalAlpha = 1;

  speckle(c, w, h, new RNG(layerSeed(seed, 0x5bac)), w * h * 0.008, 0.22);
  age(c, w, h, seed, 10);
  c.restore();
};

// ---------------------------------------------------------------------------
// Pattern 2: diamond geometric
// ---------------------------------------------------------------------------

const paintDiamond: CarpetPainter = (c, w, h, seed) => {
  c.save();
  c.fillStyle = CARPET_BASE;
  c.fillRect(0, 0, w, h);

  const rng = new RNG(layerSeed(seed, 0xd14d));
  const cell = Math.max(12, Math.min(w, h) / 7);
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / (cell * 2)) + 1;

  // Lattice of diamonds in staggered rows; alternate fields carry a faint
  // tone shift so big areas still show structure under dim lighting.
  for (let r = 0; r < rows; r++) {
    for (let col = -1; col < cols; col++) {
      const cx = col * cell + (r % 2 ? cell / 2 : 0);
      const cy = r * cell;
      const field = (r + col) & 1;
      c.beginPath();
      c.moveTo(cx, cy - cell / 2);
      c.lineTo(cx + cell / 2, cy);
      c.lineTo(cx, cy + cell / 2);
      c.lineTo(cx - cell / 2, cy);
      c.closePath();
      c.globalAlpha = 0.14 + 0.10 * rng.next();
      c.fillStyle = field ? '#8a7739' : '#6a5c2a';
      c.fill();
      c.globalAlpha = 0.22;
      c.strokeStyle = CARPET_DARK;
      c.lineWidth = 1.5;
      c.stroke();
      // Tiny center dot, the tufted anchor of each diamond.
      c.globalAlpha = 0.25;
      c.fillStyle = field ? CARPET_DARK : CARPET_LIGHT;
      c.fillRect(cx - 1, cy - 1, 2, 2);
    }
  }
  c.globalAlpha = 1;

  speckle(c, w, h, new RNG(layerSeed(seed, 0xd14e)), w * h * 0.012, 0.20);
  age(c, w, h, seed, 7);
  c.restore();
};

// ---------------------------------------------------------------------------
// Pattern 3: worn path (traffic darkening)
// ---------------------------------------------------------------------------

const paintWornPath: CarpetPainter = (c, w, h, seed) => {
  c.save();
  c.fillStyle = CARPET_BASE;
  c.fillRect(0, 0, w, h);

  speckle(c, w, h, new RNG(layerSeed(seed, 0x00a0)), w * h * 0.015, 0.24);

  // Two or three sinuous desire-lines laid out with value noise, painted as
  // thin vertical slices so the lane meanders instead of running straight.
  const rng = new RNG(layerSeed(seed, 0x00b0));
  const lanes = 2 + rng.int(0, 2);
  const slice = 4;
  for (let li = 0; li < lanes; li++) {
    const laneSalt = layerSeed(seed, 0x00c0 + li * 7919);
    const centerBase = ((li + 0.5 + rng.range(-0.15, 0.15)) / lanes) * h;
    const halfWidth = h * rng.range(0.05, 0.09);
    const freq = rng.range(2.2, 3.6);
    for (let x = 0; x < w; x += slice) {
      const t = (x / w) * freq;
      const cy = centerBase + (fbm2(t, li * 13.7, 3, 2, 0.5, laneSalt) - 0.5) * h * 0.34;
      // Soft-edged lane: several overlapping translucent strokes per slice.
      for (let k = 0; k < 3; k++) {
        const spread = halfWidth * (k === 0 ? 1 : k === 1 ? 0.66 : 0.36);
        c.globalAlpha = k === 0 ? 0.07 : k === 1 ? 0.08 : 0.09;
        c.fillStyle = 'rgb(' + GRIME_RGB + ')';
        c.fillRect(x, cy - spread, slice, spread * 2);
      }
      // Trampled fringe scuffs hugging the lane edges.
      if (rand2(x, li, laneSalt) > 0.72) {
        c.globalAlpha = 0.10;
        const ey = cy + (rand2(x + 1, li, laneSalt) < 0.5 ? -1 : 1) * halfWidth;
        c.fillRect(x, ey, slice, 2);
      }
    }
  }
  c.globalAlpha = 1;

  // Heel scuffs scattered near (but not on) the lanes.
  for (let i = 0; i < 14; i++) stain(c, w, h, rng, GRIME_RGB, w * 0.02, w * 0.07, 0.14);
  age(c, w, h, seed, 5);
  c.restore();
};

// ---------------------------------------------------------------------------
// Pattern 4: watermarked (faded motif)
// ---------------------------------------------------------------------------

const paintWatermark: CarpetPainter = (c, w, h, seed) => {
  c.save();
  c.fillStyle = CARPET_BASE;
  c.fillRect(0, 0, w, h);

  speckle(c, w, h, new RNG(layerSeed(seed, 0xa4a1)), w * h * 0.015, 0.24);

  // Ghost motif: a rosette (nested diamonds + ring) stamped on a grid, as if
  // the building once had patterned carpet and decades of fluorescents
  // bleached everything except a memory of the design.
  const rng = new RNG(layerSeed(seed, 0xa4b2));
  const cell = Math.max(26, Math.min(w, h) / 3.2);
  const cols = Math.ceil(w / cell) + 1;
  const rows = Math.ceil(h / cell) + 1;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const cx = col * cell + (r % 2 ? cell / 2 : 0);
      const cy = r * cell;
      const s = cell * rng.range(0.30, 0.38);
      c.globalAlpha = 0.10 + 0.06 * rng.next();
      c.strokeStyle = 'rgb(' + BLEACH_RGB + ')';
      c.lineWidth = 3;
      // outer diamond
      c.beginPath();
      c.moveTo(cx, cy - s);
      c.lineTo(cx + s, cy);
      c.lineTo(cx, cy + s);
      c.lineTo(cx - s, cy);
      c.closePath();
      c.stroke();
      // inner diamond
      const s2 = s * 0.5;
      c.beginPath();
      c.moveTo(cx, cy - s2);
      c.lineTo(cx + s2, cy);
      c.lineTo(cx, cy + s2);
      c.lineTo(cx - s2, cy);
      c.closePath();
      c.stroke();
      // ring
      c.beginPath();
      c.arc(cx, cy, s * 0.72, 0, Math.PI * 2);
      c.stroke();
    }
  }

  // Uneven fade: patchy bleach blooms decide how much of the motif survives.
  const frng = new RNG(layerSeed(seed, 0xa4c3));
  for (let i = 0; i < 16; i++) {
    const fx = frng.next() * w;
    const fy = frng.next() * h;
    const fr = frng.range(w * 0.08, w * 0.28);
    const fg = c.createRadialGradient(fx, fy, fr * 0.1, fx, fy, fr);
    fg.addColorStop(0, 'rgba(' + GRIME_RGB + ',' + (0.20 * frng.range(0.5, 1)).toFixed(3) + ')');
    fg.addColorStop(1, 'rgba(' + GRIME_RGB + ',0)');
    c.globalAlpha = 1;
    c.fillStyle = fg;
    c.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
  }
  c.globalAlpha = 1;

  age(c, w, h, seed, 4);
  c.restore();
};

// ---------------------------------------------------------------------------
// Pattern 5: industrial needle-stripes
// ---------------------------------------------------------------------------

const paintNeedleStripes: CarpetPainter = (c, w, h, seed) => {
  c.save();
  c.fillStyle = '#756631';
  c.fillRect(0, 0, w, h);

  // Broad bonded stripes laid down the sheet.
  const rng = new RNG(layerSeed(seed, 0x3d11));
  const stripeW = Math.max(14, w / 9);
  const nStr = Math.ceil(w / stripeW) + 1;
  for (let i = 0; i < nStr; i++) {
    if (i % 2) {
      c.globalAlpha = 0.13;
      c.fillStyle = '#5f5124';
      c.fillRect(i * stripeW, 0, stripeW, h);
    }
  }

  // Needlepunch fiber lines: dense 1px verticals across the sheet,
  // alternating tone per hairline, slight lean so it reads woven.
  const hairRng = new RNG(layerSeed(seed, 0x3d22));
  const hairs = Math.round(w * 2.2);
  c.lineWidth = 1;
  for (let i = 0; i < hairs; i++) {
    const x = hairRng.next() * w;
    const lean = hairRng.range(-2.5, 2.5);
    c.globalAlpha = 0.06 + 0.10 * hairRng.next();
    c.strokeStyle = hairRng.chance(0.5) ? CARPET_DARK : '#a08c44';
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x + lean, h);
    c.stroke();
  }

  // Seam lines where the strips are glued together.
  c.globalAlpha = 0.30;
  c.strokeStyle = CARPET_DARK;
  c.lineWidth = 2;
  for (let i = 1; i < nStr; i++) {
    c.beginPath();
    c.moveTo(i * stripeW, 0);
    c.lineTo(i * stripeW, h);
    c.stroke();
  }
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
