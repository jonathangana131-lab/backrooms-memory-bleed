/**
 * Radio dial faces - procedural textures for the world radios placed by
 * radioprops.ts and tuned through radiotune.ts's overlay.
 *
 * Two variants paint into any 2D canvas context:
 *
 *  - paintDial     : the resting face - aged bakelite plastic, a dimly
 *                    amber-lit FM scale (88-108 MHz), the station needle
 *                    mark, and the manufacturer brand (HALCYON or REGENCY,
 *                    picked deterministically from the radio's seed).
 *  - paintDialLit  : the actively-tuned emissive twin - same layout, but
 *                    the backlight surges, the scale glows hot amber and
 *                    the needle burns bright so the face reads as powered
 *                    while the player hunts a carrier.
 *
 * Pure data in / pure pixels out: no Babylon imports, safe from workers
 * or node. Deterministic given (seed, freq): speckle grain, scratch
 * pattern, brand and default needle position all derive from the seed,
 * so a given radio always wears the same face. Wire the result into a
 * BABYLON.DynamicTexture via its getContext() canvas - materials.ts holds
 * the established DynamicTexture painting pattern.
 */
import { RNG, hash2i } from '../core/rng';

/** Low edge of the FM band shown on the dial, in MHz (mirrors radiotune). */
export const FM_BAND_MIN = 88;

/** High edge of the FM band shown on the dial, in MHz (mirrors radiotune). */
export const FM_BAND_MAX = 108;

/** Salt keeping dial hashing independent of every other feature. */
export const DIAL_SALT = 0x1a7e;

/** Manufacturer brands printed under the scale. */
export const DIAL_BRANDS: readonly string[] = ['HALCYON', 'REGENCY'];

/**
 * Texture pixel dimensions of one dial face. Landscape, multiples of 4 -
 * friendly to DynamicTexture UVs on the radio's front quad.
 */
export function dialCanvasSize(): { width: number; height: number } {
  return { width: 512, height: 256 };
}

/**
 * Deterministic brand for a radio seed: every radio of the same seed
 * always carries the same nameplate.
 */
export function dialBrandFor(seed: number): string {
  return DIAL_BRANDS[hash2i(seed | 0, 7, DIAL_SALT) % DIAL_BRANDS.length];
}

/**
 * Pixel x of a frequency along the scale inside a w-wide canvas. Linear
 * across the padded band; shared by the painter and by callers that want
 * to align overlays (a glowing found-station dot) with the texture.
 */
export function needleXFor(freq: number, w: number): number {
  const f = Math.min(FM_BAND_MAX, Math.max(FM_BAND_MIN, freq));
  const pad = w * 0.09;
  return pad + ((f - FM_BAND_MIN) / (FM_BAND_MAX - FM_BAND_MIN)) * (w - 2 * pad);
}

/**
 * Seeded resting needle position (MHz, one decimal) used when a caller
 * does not supply a live frequency. Deterministic per seed.
 */
export function dialRestFreq(seed: number): number {
  const r = hash2i(seed | 0, 13, DIAL_SALT + 5) / 4294967296;
  return Math.round((FM_BAND_MIN + 1 + r * (FM_BAND_MAX - FM_BAND_MIN - 2)) * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Procedural painting                                                 */
/* ------------------------------------------------------------------ */

/** Minimal 2D-context surface paintDial needs (real canvas or stub). */
export interface DialCtx {
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  /** Painter-settable state; real canvases carry these, stubs record them. */
  font: string;
  textAlign: string;
  textBaseline: string;
  fillStyle: string | CanvasGradient;
  strokeStyle: string | CanvasGradient;
  lineWidth: number;
  shadowColor: string;
  shadowBlur: number;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): {
    addColorStop(t: number, color: string): void;
  };
  createRadialGradient(
    x0: number, y0: number, r0: number, x1: number, y1: number, r1: number,
  ): { addColorStop(t: number, color: string): void };
}

/** Monospace glyph advance used for hand-letter-spaced brand text. */
const GLYPH_ASPECT = 0.6;

/** Palette for one paint pass; lit=true is the emissive tuned variant. */
interface DialPalette {
  /** Backlight surge behind the scale (radial centre alpha). */
  backlight: number;
  /** Scale line + minor tick colour. */
  tick: string;
  /** Major-tick colour. */
  tickMajor: string;
  /** Numeric label / caption colour. */
  label: string;
  /** Needle colour. */
  needle: string;
  /** Needle glow blur radius (0 = unlit, no shadow pass). */
  glow: number;
  /** Faceplate inner brightness 0..1. */
  face: number;
}

const DIM_PALETTE: DialPalette = {
  backlight: 0.10,
  tick: 'rgba(196,150,60,0.55)',
  tickMajor: 'rgba(222,178,84,0.75)',
  label: 'rgba(206,168,86,0.72)',
  needle: '#e8641e',
  glow: 0,
  face: 0.5,
};

const LIT_PALETTE: DialPalette = {
  backlight: 0.34,
  tick: 'rgba(255,204,96,0.9)',
  tickMajor: 'rgba(255,224,140,1)',
  label: 'rgba(255,232,160,0.95)',
  needle: '#ffb347',
  glow: 9,
  face: 0.85,
};

interface PaintPlan {
  ctx: DialCtx;
  w: number;
  h: number;
  rng: RNG;
  pal: DialPalette;
  lit: boolean;
}

/** Aged plastic shell: bakelite base tone, speckle grain, scratches. */
function drawShell(p: PaintPlan): void {
  const { ctx, w, h } = p;
  // Base bakelite: dark warm brown, slightly lighter toward the top.
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, p.lit ? '#3a2b18' : '#241a10');
  base.addColorStop(0.55, p.lit ? '#332514' : '#1e150c');
  base.addColorStop(1, '#120d07');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Speckle grain: dense faint dots, biased toward the bottom (grime).
  for (let i = 0; i < 420; i++) {
    const x = p.rng.next() * w;
    const yBias = p.rng.next();
    const y = yBias * yBias * h;
    const a = 0.02 + p.rng.next() * 0.05;
    ctx.fillStyle = p.rng.next() < 0.5
      ? 'rgba(210,180,130,' + a.toFixed(3) + ')'
      : 'rgba(0,0,0,' + a.toFixed(3) + ')';
    const s = 1 + p.rng.next() * 1.6;
    ctx.fillRect(x, y, s, s);
  }

  // Hairline scratches from years of fingernails and ring wear.
  for (let i = 0; i < 14; i++) {
    const y = p.rng.next() * h;
    const x0 = p.rng.next() * w * 0.4;
    const len = w * (0.15 + p.rng.next() * 0.45);
    ctx.strokeStyle = 'rgba(190,160,110,' + (0.03 + p.rng.next() * 0.05).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(Math.min(w, x0 + len), y + (p.rng.next() - 0.5) * 6);
    ctx.stroke();
  }

  // Corner screws with slots.
  const m = w * 0.035;
  for (const [sx, sy] of [[m, m], [w - m, m], [m, h - m], [w - m, h - m]]) {
    ctx.fillStyle = '#0c0906';
    ctx.beginPath();
    ctx.arc(sx, sy, w * 0.012, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,170,110,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - w * 0.007, sy);
    ctx.lineTo(sx + w * 0.007, sy);
    ctx.stroke();
  }
}

/** Inset faceplate behind the scale, catching the backlight. */
function drawFaceplate(p: PaintPlan): void {
  const { ctx, w, h } = p;
  const fx = w * 0.06;
  const fy = h * 0.16;
  const fw = w * 0.88;
  const fh = h * 0.62;
  const cx = w / 2;
  const cy = fy + fh * 0.75;
  const g = ctx.createRadialGradient(cx, cy, h * 0.05, cx, cy, fw * 0.62);
  g.addColorStop(0, 'rgba(255,176,64,' + p.pal.backlight.toFixed(3) + ')');
  g.addColorStop(1, 'rgba(255,176,64,0)');
  ctx.fillStyle = g;
  ctx.fillRect(fx, fy, fw, fh);

  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(fx, fy, fw, fh);
  ctx.strokeStyle = 'rgba(214,178,84,' + (0.10 + p.pal.face * 0.14).toFixed(3) + ')';
  ctx.lineWidth = 1;
  ctx.strokeRect(fx + 2, fy + 2, fw - 4, fh - 4);
}

/** The 88-108 MHz scale: baseline rail, minor/major ticks, numeric labels. */
function drawScale(p: PaintPlan): void {
  const { ctx, w, h, pal } = p;
  const pad = w * 0.09;
  const yBase = h * 0.66;

  ctx.strokeStyle = pal.tick;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, yBase);
  ctx.lineTo(w - pad, yBase);
  ctx.stroke();

  ctx.font = Math.round(h * 0.075) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const span = FM_BAND_MAX - FM_BAND_MIN;
  for (let mhz = FM_BAND_MIN; mhz <= FM_BAND_MAX; mhz++) {
    const t = (mhz - FM_BAND_MIN) / span;
    const x = pad + t * (w - 2 * pad);
    const major = mhz % 5 === 0 || mhz === FM_BAND_MIN || mhz === FM_BAND_MAX;
    const len = major ? h * 0.11 : h * 0.06;
    ctx.strokeStyle = major ? pal.tickMajor : pal.tick;
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, yBase);
    ctx.lineTo(x, yBase - len);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = pal.label;
      ctx.fillText(String(mhz), x, yBase - len - h * 0.04);
    }
  }

  // Band captions flanking the rail.
  ctx.fillStyle = pal.label;
  ctx.font = Math.round(h * 0.06) + 'px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('FM  MHz', w - pad, yBase + h * 0.12);
  ctx.textAlign = 'left';
  ctx.fillText('kilocycles', pad, yBase + h * 0.12);
}

/** Manufacturer nameplate, hand letter-spaced, centred above the scale. */
function drawBrand(p: PaintPlan, brand: string): void {
  const { ctx, w, h, pal } = p;
  const size = Math.round(h * 0.085);
  const spacing = size * 0.42;
  let total = -spacing;
  for (const ch of brand) total += size * GLYPH_ASPECT + spacing;
  let x = (w - total) / 2;
  const y = h * 0.30;
  ctx.font = size + 'px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = pal.label;
  for (const ch of brand) {
    ctx.fillText(ch, x, y);
    x += size * GLYPH_ASPECT + spacing;
  }
}

/** Needle position mark over the scale at the given frequency. */
function drawNeedle(p: PaintPlan, freq: number): void {
  const { ctx, w, h, pal } = p;
  const x = needleXFor(freq, w);
  const top = h * 0.40;
  const bottom = h * 0.70;

  if (pal.glow > 0) {
    ctx.save();
    ctx.shadowColor = 'rgba(255,179,71,0.95)';
    ctx.shadowBlur = pal.glow * 2;
  }
  // Pointer triangle above the travel line...
  ctx.fillStyle = pal.needle;
  ctx.beginPath();
  ctx.moveTo(x, top - h * 0.035);
  ctx.lineTo(x - w * 0.008, top);
  ctx.lineTo(x + w * 0.008, top);
  ctx.closePath();
  ctx.fill();
  // ...and the needle blade down through the scale.
  ctx.strokeStyle = pal.needle;
  ctx.lineWidth = p.lit ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  if (pal.glow > 0) ctx.restore();
}

/** Aged glass strip over everything plus an edge vignette. */
function drawAging(p: PaintPlan): void {
  const { ctx, w, h } = p;
  // Diagonal glare across the dial glass.
  const glare = ctx.createLinearGradient(w * 0.1, h, w * 0.55, 0);
  glare.addColorStop(0, 'rgba(255,240,210,0)');
  glare.addColorStop(0.5, 'rgba(255,240,210,' + (p.lit ? 0.045 : 0.028) + ')');
  glare.addColorStop(1, 'rgba(255,240,210,0)');
  ctx.fillStyle = glare;
  ctx.fillRect(0, 0, w, h);

  // Vignette pulls the corners into the dark.
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, w * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Core paint pass. Deterministic given (seed, freq, lit): every random op
 * draws from an RNG hashed off the seed, never from Math.random. The two
 * variants hash different salts so their grain differs while the layout
 * stays identical.
 */
export function paintDialInto(
  ctx: DialCtx,
  w: number,
  h: number,
  seed: number,
  opts: { freq?: number; lit?: boolean } = {},
): void {
  const lit = opts.lit === true;
  const freq = typeof opts.freq === 'number' && Number.isFinite(opts.freq)
    ? opts.freq
    : dialRestFreq(seed);
  const plan: PaintPlan = {
    ctx,
    w,
    h,
    rng: new RNG(hash2i(seed | 0, lit ? 31 : 17, DIAL_SALT + 11)),
    pal: lit ? LIT_PALETTE : DIM_PALETTE,
    lit,
  };

  ctx.save();
  drawShell(plan);
  drawFaceplate(plan);
  drawBrand(plan, dialBrandFor(seed));
  drawScale(plan);
  drawNeedle(plan, freq);
  drawAging(plan);
  ctx.restore();
}

/** Resting dial face: dim amber scale on aged plastic. */
export function paintDial(
  ctx: DialCtx,
  w: number,
  h: number,
  seed: number,
  freq?: number,
): void {
  paintDialInto(ctx, w, h, seed, { freq });
}

/**
 * Emissively lit twin for actively tuned radios: brighter backlight,
 * hotter scale, glowing needle. Same layout and geometry as paintDial so
 * a material swap between the two reads as power, not redesign.
 */
export function paintDialLit(
  ctx: DialCtx,
  w: number,
  h: number,
  seed: number,
  freq?: number,
): void {
  paintDialInto(ctx, w, h, seed, { freq, lit: true });
}


