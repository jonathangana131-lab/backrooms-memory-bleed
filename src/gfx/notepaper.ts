/**
 * Note paper variety - procedural paper types and handwriting styles.
 *
 * Every readable note in MEMORY BLEED gets one of four procedurally drawn
 * paper textures (yellow legal pad, white printer sheet with a coffee ring,
 * torn notebook page, aged letter) and one of three handwriting treatments
 * (neat print, rushed scrawl, shaky elderly hand). The assignment is purely
 * deterministic: a note's ID string hashes to a stable (paperType, handStyle)
 * pair, so the same note looks identical across saves and sessions.
 *
 * Performance contract:
 *  - each texture is generated once and cached; getTexture() never redraws;
 *  - generation is pure canvas work - no external images, no font loading;
 *  - all randomness is seeded from the paper type itself, so even the first
 *    draw is reproducible frame-for-frame.
 */

/** Number of distinct paper textures. */
export const PAPER_TYPES = 4;
/** Number of distinct handwriting treatments. */
export const HAND_STYLES = 3;

/** Side length of every generated texture canvas. */
export const TEX_SIZE = 256;

/** Paper type indices. */
export const PAPER_LEGAL = 0;
export const PAPER_PRINTER = 1;
export const PAPER_NOTEBOOK = 2;
export const PAPER_LETTER = 3;

/** Handwriting style indices. */
export const HAND_PRINT = 0;
export const HAND_SCRAWL = 1;
export const HAND_SHAKY = 2;

/** Human-readable names, indexed by type/style id. */
export const PAPER_NAMES = ['legal pad', 'printer', 'notebook', 'letter'];
export const HAND_NAMES = ['print', 'scrawl', 'shaky'];

/** Deterministic style pair assigned to a note. */
export interface NoteStyle {
  /** 0..PAPER_TYPES-1 */
  paperType: number;
  /** 0..HAND_STYLES-1 */
  handStyle: number;
}

export interface ApplyOptions {
  /** Which texture to paint; clamped into range. Default legal pad. */
  paperType?: number;
}

/* ------------------------------------------------------------------ *
 * Hashing + seeded RNG
 * ------------------------------------------------------------------ */

/** FNV-1a 32-bit hash of a string; stable across sessions. */
export function hashNoteId(noteId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < noteId.length; i++) {
    h ^= noteId.charCodeAt(i);
    // FNV prime multiply, kept exact with Math.imul.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface Rng {
  (): number;
}

/** mulberry32 PRNG seeded from a 32-bit integer. */
function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Texture painters (one per paper type)
 * ------------------------------------------------------------------ */

function makeCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('notepaper: no DOM');
  return document.createElement('canvas');
}

/** Scatter faint darker/lighter speckles for fibre grain. */
function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: Rng,
  count: number,
  alpha: number,
): void {
  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 0.5 + rng() * 1.2;
    ctx.fillStyle = rng() > 0.5
      ? `rgba(90, 70, 40, ${alpha})`
      : `rgba(255, 255, 250, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintLegalPad(ctx: CanvasRenderingContext2D, size: number): void {
  const rng = seededRng(101);
  ctx.fillStyle = '#f3e39b';
  ctx.fillRect(0, 0, size, size);
  // Slight top-to-bottom tone shift like cheap glued pads.
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, 'rgba(255, 246, 190, 0.55)');
  grad.addColorStop(1, 'rgba(196, 168, 84, 0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  // Blue ruled lines.
  ctx.strokeStyle = 'rgba(110, 140, 190, 0.65)';
  ctx.lineWidth = 1;
  const pitch = size / 8;
  ctx.beginPath();
  for (let y = pitch; y < size; y += pitch) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(size, Math.round(y) + 0.5);
  }
  ctx.stroke();
  // Red double margin rule.
  const margin = Math.round(size * 0.14);
  ctx.strokeStyle = 'rgba(205, 80, 80, 0.75)';
  ctx.beginPath();
  ctx.moveTo(margin + 0.5, 0);
  ctx.lineTo(margin + 0.5, size);
  ctx.moveTo(margin + 3.5, 0);
  ctx.lineTo(margin + 3.5, size);
  ctx.stroke();
  speckle(ctx, size, rng, 220, 0.05);
}

function paintPrinter(ctx: CanvasRenderingContext2D, size: number): void {
  const rng = seededRng(202);
  ctx.fillStyle = '#f6f5f0';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, rng, 160, 0.03);
  // Coffee ring: off-centre brown annulus built from wobbly arcs.
  const cx = size * 0.66;
  const cy = size * 0.38;
  const r = size * 0.22;
  ctx.lineWidth = 5;
  for (let ring = 0; ring < 3; ring++) {
    ctx.strokeStyle = `rgba(112, 66, 30, ${0.28 - ring * 0.07})`;
    const start = rng() * Math.PI * 2;
    const sweep = Math.PI * (1.1 + rng() * 0.7);
    const rr = r + (rng() - 0.5) * 4;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, start, start + sweep);
    ctx.stroke();
  }
  // Faint residual stain inside the ring.
  ctx.fillStyle = 'rgba(150, 105, 60, 0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, r - 3, 0, Math.PI * 2);
  ctx.fill();
}

function paintNotebook(ctx: CanvasRenderingContext2D, size: number): void {
  const rng = seededRng(303);
  ctx.fillStyle = '#efece2';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, rng, 180, 0.04);
  // Spiral punch holes down the left edge: dark pit + highlight rim.
  const holeX = size * 0.075;
  const count = 6;
  for (let i = 0; i < count; i++) {
    const hy = ((i + 0.5) / count) * size;
    const hr = size * 0.028;
    const g = ctx.createRadialGradient(holeX - hr * 0.3, hy - hr * 0.3, hr * 0.2, holeX, hy, hr);
    g.addColorStop(0, 'rgba(25, 25, 28, 0.9)');
    g.addColorStop(0.75, 'rgba(50, 48, 52, 0.85)');
    g.addColorStop(1, 'rgba(120, 115, 105, 0.4)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(holeX, hy, hr, 0, Math.PI * 2);
    ctx.fill();
  }
  // Torn right edge: chew it away with destination-out jagged triangles.
  ctx.globalCompositeOperation = 'destination-out';
  const step = 7;
  for (let y = 0; y < size; y += step) {
    const depth = 2 + rng() * (size * 0.045);
    ctx.beginPath();
    ctx.moveTo(size, y);
    ctx.lineTo(size - depth, y + step / 2);
    ctx.lineTo(size, y + step);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  // Shadow just inside the torn edge so the tear reads as physical.
  const sh = ctx.createLinearGradient(size - size * 0.06, 0, size, 0);
  sh.addColorStop(0, 'rgba(120, 110, 95, 0)');
  sh.addColorStop(1, 'rgba(120, 110, 95, 0.28)');
  ctx.fillStyle = sh;
  ctx.fillRect(size - size * 0.06, 0, size * 0.06, size);
}

function paintLetter(ctx: CanvasRenderingContext2D, size: number): void {
  const rng = seededRng(404);
  // Yellowed base with darker, uneven ageing toward the edges.
  const base = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.72);
  base.addColorStop(0, '#efe4bd');
  base.addColorStop(0.7, '#e4d5a4');
  base.addColorStop(1, '#cdb98a');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  // Foxing blotches.
  for (let i = 0; i < 10; i++) {
    const bx = rng() * size;
    const by = rng() * size;
    const br = 3 + rng() * 12;
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
    g.addColorStop(0, 'rgba(140, 105, 55, 0.16)');
    g.addColorStop(1, 'rgba(140, 105, 55, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fold creases: vertical centre + horizontal thirds, each a bright ridge
  // beside a dark groove so they catch light both ways.
  const crease = (x1: number, y1: number, x2: number, y2: number): void => {
    ctx.strokeStyle = 'rgba(255, 250, 225, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120, 100, 60, 0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1 + 1, y1);
    ctx.lineTo(x2 + 1, y2);
    ctx.stroke();
  };
  crease(size / 2, 0, size / 2, size);
  crease(0, size / 3, size, size / 3);
  crease(0, (size * 2) / 3, size, (size * 2) / 3);
  speckle(ctx, size, rng, 240, 0.05);
}

const PAINTERS: ((ctx: CanvasRenderingContext2D, size: number) => void)[] = [
  paintLegalPad,
  paintPrinter,
  paintNotebook,
  paintLetter,
];

/* ------------------------------------------------------------------ *
 * NotePaper API
 * ------------------------------------------------------------------ */

export class NotePaper {
  private static readonly cache = new Map<number, HTMLCanvasElement>();

  /**
   * Procedural texture for one paper type. The canvas is generated once per
   * type and reused; out-of-range ids wrap safely via modulo.
   */
  static getTexture(type: number): HTMLCanvasElement {
    const idx = ((Math.round(type) % PAPER_TYPES) + PAPER_TYPES) % PAPER_TYPES;
    const hit = this.cache.get(idx);
    if (hit) return hit;
    const canvas = makeCanvas();
    canvas.width = TEX_SIZE;
    canvas.height = TEX_SIZE;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('notepaper: no 2d context');
    PAINTERS[idx](ctx, TEX_SIZE);
    this.cache.set(idx, canvas);
    return canvas;
  }

  /**
   * Stable style pair for a note id. The same id always maps to the same
   * (paperType, handStyle); different ids spread over all combinations.
   */
  static styleFor(noteId: string): NoteStyle {
    const h = hashNoteId(noteId);
    return {
      paperType: h % PAPER_TYPES,
      handStyle: (h >>> 16) % HAND_STYLES,
    };
  }

  /**
   * Paint the chosen paper texture onto a context at the requested size.
   * Called as applyToCanvas(ctx, w, h) it uses the default (legal pad)
   * paper; pass { paperType } to select another.
   */
  static applyToCanvas(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    options?: ApplyOptions,
  ): void {
    const tex = this.getTexture(options?.paperType ?? PAPER_LEGAL);
    ctx.drawImage(tex, 0, 0, w, h);
  }

  /**
   * Draw text in one of the handwriting treatments. Newlines split lines.
   * Returns the y coordinate below the last line so callers can stack more.
   */
  static drawText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    handStyle: number,
    opts?: { fontSize?: number; lineHeight?: number },
  ): number {
    const idx = ((Math.round(handStyle) % HAND_STYLES) + HAND_STYLES) % HAND_STYLES;
    const fontSize = opts?.fontSize ?? 18;
    const lineHeight = opts?.lineHeight ?? fontSize * 1.35;
    const lines = String(text).split('\n');
    const rng = seededRng(hashNoteId(String(text)) ^ 0x9e3779b9);

    if (idx === HAND_PRINT) {
      ctx.font = `${fontSize}px "Courier New", monospace`;
      ctx.textBaseline = 'alphabetic';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], x, y + i * lineHeight);
      }
      return y + lines.length * lineHeight;
    }

    if (idx === HAND_SCRAWL) {
      // Rushed scrawl: italic cursive with a small rotation and x drift per line.
      ctx.font = `italic ${fontSize}px cursive`;
      ctx.textBaseline = 'alphabetic';
      for (let i = 0; i < lines.length; i++) {
        ctx.save();
        ctx.translate(x, y + i * lineHeight);
        ctx.rotate((rng() - 0.5) * 0.09);
        ctx.fillText(lines[i], rng() * 3, 0);
        ctx.restore();
      }
      return y + lines.length * lineHeight;
    }

    // Shaky elderly: serif with a per-character baseline wobble that drifts
    // like an unsteady hand crossing the page.
    ctx.font = `${fontSize}px Georgia, serif`;
    ctx.textBaseline = 'alphabetic';
    let cursorY = y;
    for (let i = 0; i < lines.length; i++) {
      let cx = x;
      for (const ch of lines[i]) {
        const wob = Math.sin(cx * 0.11 + i) * 1.6 + (rng() - 0.5) * 2.2;
        ctx.fillText(ch, cx, cursorY + wob);
        cx += ctx.measureText(ch).width + (rng() - 0.5);
      }
      cursorY += lineHeight;
    }
    return cursorY;
  }
}


