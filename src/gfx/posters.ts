/**
 * Wall posters - five procedurally painted paper artifacts pinned to the
 * backrooms walls, slowly forgetting what they used to say:
 *
 *  - missing      : MISSING-person flyer (silhouette portrait + LOST headline)
 *  - event        : faded gig poster for a band nobody remembers booking
 *  - safety       : yellow/black striped WARNING notice from a facility
 *                   that no longer exists
 *  - map          : torn fragment of an evacuation/corridor map, edges ragged
 *  - motivational : PEAK PERFORMANCE office poster, ironically peeling off
 *                   the plaster it was meant to inspire
 *
 * Each poster renders in one of three aging states (fresh / faded / torn)
 * that modulate ink opacity, tear damage and corner curl.
 *
 * Pure data in / pure pixels out: getPostersForChunk is a deterministic
 * function of the chunk coordinates (same hash discipline as architect.ts
 * and projections.ts) and paintPoster draws into any 2D canvas context -
 * DynamicTexture in game, a recording stub in tests. No Babylon imports,
 * safe to call from workers or node.
 */
import { RNG, hash2i } from '../core/rng';
import { CELL, CHUNK_CELLS } from '../world/constants';

/** Salt keeping poster gating independent of every other feature. */
export const POSTER_SALT = 0xb05e;
/** ~1 chunk in 7 (~14%, spec says ~15%) carries a poster. */
export const POSTER_PERIOD = 7;

/** The five procedural poster types. */
export type PosterType = 'missing' | 'event' | 'safety' | 'map' | 'motivational';

export const POSTER_TYPES: readonly PosterType[] = [
  'missing',
  'event',
  'safety',
  'map',
  'motivational',
];

/** Aging variants. */
export type PosterState = 'fresh' | 'faded' | 'torn';

export const POSTER_STATES: readonly PosterState[] = ['fresh', 'faded', 'torn'];

/** How far the poster floats off its wall plane (metres). */
export const POSTER_OFFSET = 0.015;
/** Wall-mount height band (metres above the floor), per spec. */
export const POSTER_Y_MIN = 1.4;
export const POSTER_Y_MAX = 1.7;

/** Minimal structural view of a chunk layout for wall lookup. */
export interface WallLookup {
  hEdges: Uint8Array;
  vEdges: Uint8Array;
}

export interface PosterPlacement {
  /** World-space anchor point on the wall face. */
  x: number;
  z: number;
  /** Mount height above the floor (1.4 .. 1.7 m). */
  y: number;
  /** Yaw so the poster quad faces into the open corridor. */
  rotY: number;
  type: PosterType;
  state: PosterState;
}


(Showing lines 50-69 of 613. Use offset=70 to continue.)

export interface AgingProfile {
  /** Overall ink opacity multiplier applied to every paint op. */
  alpha: number;
  /** 0..1 amount of tear/notch damage along the edges. */
  tear: number;
  /** 0..1 corner-curl strength (shaded lift on one corner). */
  curl: number;
}

/**
 * Aging parameters per state. Deterministic pure function.
 */
export function posterAging(state: PosterState): AgingProfile {
  switch (state) {
    case 'fresh':
      return { alpha: 0.97, tear: 0.05, curl: 0.03 };
    case 'faded':
      return { alpha: 0.55, tear: 0.22, curl: 0.12 };
    case 'torn':
      return { alpha: 0.74, tear: 0.85, curl: 0.2 };
  }
}

/** Texture pixel dimensions per poster type (portrait-ish paper). */
export function posterCanvasSize(type: PosterType): { width: number; height: number } {
  switch (type) {
    case 'missing':
      return { width: 256, height: 340 };
    case 'event':
      return { width: 256, height: 384 };
    case 'safety':
      return { width: 320, height: 224 };
    case 'map':
      return { width: 288, height: 288 };
    case 'motivational':
      return { width: 256, height: 320 };
  }
}

/**
 * Deterministic poster placements for chunk (cx, cz): empty unless the
 * chunk passes the 1-in-POSTER_PERIOD hash gate (~14% ~= 15% of chunks),
 * then 1-2 posters mounted on real wall faces (when a layout is supplied)
 * at y in [1.4, 1.7].
 *
 * When walls is supplied the poster lands against a SOLID edge whose
 * opposite side is open (a corridor face); otherwise a plausible interior
 * wall line is chosen from the chunk hash alone.
 */
export function getPostersForChunk(
  cx: number,
  cz: number,
  seed = 0,
  walls?: WallLookup,
): PosterPlacement[] {
  if ((hash2i(cx, cz, seed ^ POSTER_SALT) % POSTER_PERIOD) !== 0) return [];

  const N = CHUNK_CELLS;
  const rng = new RNG(hash2i(cx, cz, seed ^ (POSTER_SALT + 1)));
  const SOLID = 1; // EdgeCode.SOLID

  interface Candidate { lx: number; lz: number; face: 0 | 1 | 2 | 3 }

  // Collect wall-face candidates the same way projections.tryPlace does:
  // prefer faces looking into open cells, fall back to any solid face.
  let candidates: Candidate[] = [];
  if (walls) {
    const all: Candidate[] = [];
    const open: Candidate[] = [];
    for (let lz = 0; lz < N; lz++) {
      for (let lx = 0; lx < N; lx++) {
        const heIdx = lz * N + lx;
        const veIdx = lz * (N + 1) + lx;
        if (walls.hEdges[heIdx] === SOLID) {
          const c = { lx, lz, face: 0 as const }; // normal -z
          (walls.hEdges[(lz + 1) * N + lx] !== SOLID ? open : all).push(c);
        }
        if (walls.hEdges[(lz + 1) * N + lx] === SOLID) {
          const c = { lx, lz, face: 1 as const }; // normal +z
          (walls.hEdges[heIdx] !== SOLID ? open : all).push(c);
        }
        if (walls.vEdges[veIdx] === SOLID) {
          const c = { lx, lz, face: 2 as const }; // normal -x
          (walls.vEdges[lz * (N + 1) + lx + 1] !== SOLID ? open : all).push(c);
        }
        if (walls.vEdges[lz * (N + 1) + lx + 1] === SOLID) {
          const c = { lx, lz, face: 3 as const }; // normal +x
          (walls.vEdges[veIdx] !== SOLID ? open : all).push(c);
        }
      }
    }
    candidates = open.length ? open : all;
  }

  // 1-2 posters per gated chunk.
  const count = rng.chance(0.4) ? 2 : 1;

  // Distinct candidate indices so two posters never share a face spot.
  const usedIdx = new Set<number>();
  const pickCandidate = (): Candidate | null => {
    if (!candidates.length) return null;
    if (usedIdx.size >= candidates.length) return null;
    for (;;) {
      const i = rng.int(0, candidates.length);
      if (!usedIdx.has(i)) {
        usedIdx.add(i);
        return candidates[i];
      }
    }
  };

(Showing lines 100-179 of 613. Use offset=180 to continue.)


  const bx = cx * N;
  const bz = cz * N;
  const out: PosterPlacement[] = [];

  for (let p = 0; p < count; p++) {
    const along = rng.range(0.3, 0.7); // jitter along the wall run
    const y = rng.range(POSTER_Y_MIN, POSTER_Y_MAX);
    let x: number, z: number, rotY: number;
    const cand = pickCandidate();
    if (cand) {
      const { lx, lz, face } = cand;
      switch (face) {
        case 0: // wall normal -z
          x = (bx + lx + along) * CELL;
          z = (bz + lz) * CELL;
          rotY = Math.PI;
          break;
        case 1: // +z
          x = (bx + lx + along) * CELL;
          z = (bz + lz + 1) * CELL;
          rotY = 0;
          break;
        case 2: // -x
          x = (bx + lx) * CELL;
          z = (bz + lz + along) * CELL;
          rotY = -Math.PI / 2;
          break;
        default: // +x
          x = (bx + lx + 1) * CELL;
          z = (bz + lz + along) * CELL;
          rotY = Math.PI / 2;
          break;
      }
    } else {
      // Hash-only fallback: somewhere plausible mid-chunk against -z.
      x = (bx + rng.range(1, N - 1)) * CELL;
      z = bz * CELL;
      rotY = Math.PI;
    }

    // Offset along the facing normal lifts the paper proud of the wall.
    x += Math.sin(rotY) * POSTER_OFFSET;
    z += Math.cos(rotY) * POSTER_OFFSET;

    const type = POSTER_TYPES[hash2i(cx, cz, seed ^ (POSTER_SALT + 2 + p)) % POSTER_TYPES.length];
    // Weighted aging: mostly weathered, occasionally pristine.
    const sr = rng.next();
    const state: PosterState = sr < 0.3 ? 'fresh' : sr < 0.72 ? 'faded' : 'torn';

    out.push({ x, z, y, rotY, type, state });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procedural painting
// ---------------------------------------------------------------------------

/** Minimal 2D-context surface paintPoster needs (real canvas or test stub). */

(Showing lines 180-239 of 613. Use offset=240 to continue.)

export interface PosterCtx {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): {
    addColorStop(offset: number, color: string): void;
  };
  /** paint color: plain CSS color or a gradient from createLinearGradient */
  fillStyle: string | { addColorStop(offset: number, color: string): void };
  /** stroke color: plain CSS color or a gradient from createLinearGradient */
  strokeStyle: string | { addColorStop(offset: number, color: string): void };
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  textBaseline: 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom';
}

interface PaintPlan {
  ctx: PosterCtx;
  w: number;
  h: number;
  rng: RNG;
  aging: AgingProfile;
}

const MONO = '"Courier New", monospace';
const SANS = '"Arial Narrow", Arial, sans-serif';

function fillWhole(p: PaintPlan, color: string): void {
  p.ctx.fillStyle = color;
  p.ctx.fillRect(0, 0, p.w, p.h);
}

function centeredText(p: PaintPlan, text: string, cx: number, cy: number, font: string, color: string): void {
  const ctx = p.ctx;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
}

/** A row of fake body text rendered as soft grey bars (unreadable at range). */
function textBars(p: PaintPlan, x: number, y: number, rows: number, maxW: number, rowH: number, color: string): void {
  const ctx = p.ctx;
  ctx.fillStyle = color;
  for (let r = 0; r < rows; r++) {
    const bw = maxW * (0.6 + 0.4 * p.rng.next());
    ctx.fillRect(x, y + r * rowH * 1.6, bw, rowH);
  }
}

/** Missing-person flyer: silhouette portrait box + LOST headline. */
function drawMissing(p: PaintPlan): void {
  const { ctx, w, h } = p;
  fillWhole(p, '#e8e2d2'); // aged photocopy paper
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = Math.max(2, w * 0.012);
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);

  centeredText(p, 'MISSING', w / 2, h * 0.09, 'bold ' + Math.floor(h * 0.09) + 'px ' + SANS, '#111111');

  // Portrait frame with head-and-shoulders silhouette.
  const pw = w * 0.62;
  const ph = h * 0.42;
  const px = (w - pw) / 2;
  const py = h * 0.16;
  ctx.fillStyle = '#cfc8b6';
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = '#3a3a3a';
  ctx.beginPath();
  ctx.arc(w / 2, py + ph * 0.36, ph * 0.19, 0, Math.PI * 2); // head
  ctx.fill();
  ctx.beginPath();
  ctx.arc(w / 2, py + ph * 0.98, ph * 0.34, Math.PI, 0); // shoulders
  ctx.fill();

  textBars(p, w * 0.14, h * 0.64, 4, w * 0.72, h * 0.018, '#666666');
  centeredText(p, 'LOST', w / 2, h * 0.86, 'bold ' + Math.floor(h * 0.13) + 'px ' + MONO, '#1a1a1a');
  centeredText(p, 'LAST SEEN: LEVEL 0', w / 2, h * 0.95, Math.floor(h * 0.03) + 'px ' + MONO, '#444444');
}

/** Event poster: faded band logo, big act name, date strip. */
function drawEvent(p: PaintPlan): void {
  const { ctx, w, h } = p;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#241b30');
  g.addColorStop(1, '#120c1a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Abstract band "logo": offset rings bleeding into each other.
  ctx.save();
  ctx.translate(w / 2, h * 0.26);
  const hues = ['#c94f7c', '#7c4fc9', '#4fc9a6'];
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = hues[i];
    ctx.globalAlpha *= 0.75;
    ctx.lineWidth = w * 0.02;
    ctx.beginPath();
    ctx.arc((i - 1) * w * 0.07, 0, w * (0.16 + i * 0.035), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  centeredText(p, 'THE NULL CIRCUIT', w / 2, h * 0.52, 'bold ' + Math.floor(h * 0.062) + 'px ' + SANS, '#efe6ff');
  centeredText(p, 'LIVE  ONE  NIGHT  ONLY', w / 2, h * 0.62, Math.floor(h * 0.035) + 'px ' + MONO, '#b9a8d8');
  textBars(p, w * 0.16, h * 0.70, 3, w * 0.68, h * 0.016, '#8d7fb0');
  ctx.fillStyle = '#d8cef0';
  ctx.fillRect(w * 0.16, h * 0.86, w * 0.68, h * 0.035);
  centeredText(p, 'ROOM ???  /  NO EXIT', w / 2, h * 0.88, 'bold ' + Math.floor(h * 0.026) + 'px ' + MONO, '#241b30');
}

/** Safety notice: yellow ground, black hazard stripes, WARNING triangle. */
function drawSafety(p: PaintPlan): void {
  const { ctx, w, h } = p;
  fillWhole(p, '#e6c229');

  // Black diagonal stripe bands top and bottom.
  const stripe = () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h * 0.11);
    ctx.clip();
    ctx.fillStyle = '#141414';
    const step = w * 0.09;
    for (let x = -h; x < w + h; x += step * 2) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + step, 0);
      ctx.lineTo(x + step - h, h * 0.22);
      ctx.lineTo(x - h, h * 0.22);
      ctx.fill();
    }
    ctx.restore();
  };
  stripe();
  ctx.save();
  ctx.translate(0, h);
  ctx.scale(1, -1);
  stripe();
  ctx.restore();

  // Hazard triangle + exclamation.
  const tx = w / 2;
  const ty = h * 0.33;
  const tr = h * 0.13;
  ctx.fillStyle = '#141414';
  ctx.beginPath();
  ctx.moveTo(tx, ty - tr);
  ctx.lineTo(tx + tr, ty + tr * 0.75);
  ctx.lineTo(tx - tr, ty + tr * 0.75);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e6c229';
  ctx.fillRect(tx - tr * 0.07, ty - tr * 0.35, tr * 0.14, tr * 0.65);
  ctx.fillRect(tx - tr * 0.07, ty + tr * 0.4, tr * 0.14, tr * 0.14);

  centeredText(p, 'WARNING', w / 2, h * 0.58, 'bold ' + Math.floor(h * 0.115) + 'px ' + SANS, '#141414');
  textBars(p, w * 0.12, h * 0.67, 3, w * 0.76, h * 0.026, '#4d430f');
  centeredText(p, 'DO NOT REMAIN AFTER LIGHTS FAIL', w / 2, h * 0.86, 'bold ' + Math.floor(h * 0.036) + 'px ' + MONO, '#141414');
}

/** Map fragment: partial corridor layout with torn edges. */
function drawMap(p: PaintPlan): void {
  const { ctx, w, h, rng } = p;
  fillWhole(p, '#ddd6c3');
  ctx.strokeStyle = '#5b5648';
  ctx.lineWidth = Math.max(1, w * 0.004);
  ctx.strokeRect(w * 0.04, h * 0.04, w * 0.92, h * 0.92);

  // Partial corridor layout: connected passage segments.
  ctx.strokeStyle = '#3c382e';
  ctx.lineWidth = w * 0.045;
  const segs = 7;
  let mx = w * 0.15;
  let my = h * 0.2;
  for (let i = 0; i < segs; i++) {
    const nx = mx + (rng.chance(0.5) ? rng.range(-1, 1) * w * 0.28 : 0);
    const ny = my + (rng.chance(0.5) ? rng.range(0.2, 1) * h * 0.22 : 0);
    const cxn = Math.max(w * 0.08, Math.min(w * 0.92, nx));
    const cyn = Math.max(h * 0.1, Math.min(h * 0.88, ny));
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(cxn, cyn);
    ctx.stroke();
    mx = cxn;
    my = cyn;
  }

  // "You are here" mark.
  ctx.fillStyle = '#a32e2e';
  ctx.beginPath();
  ctx.arc(w * 0.38, h * 0.62, w * 0.035, 0, Math.PI * 2);
  ctx.fill();

  centeredText(p, 'SECTOR MAP', w / 2, h * 0.09, 'bold ' + Math.floor(h * 0.06) + 'px ' + MONO, '#3c382e');
  centeredText(p, 'REV. 7 - PARTIAL', w / 2, h * 0.93, Math.floor(h * 0.035) + 'px ' + MONO, '#6a6455');
}

/** Motivational poster: PEAK PERFORMANCE, ironically peeling. */
function drawMotivational(p: PaintPlan): void {
  const { ctx, w, h } = p;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#f4f1e8');
  g.addColorStop(1, '#ded8c6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Rising-sun rays behind a summit triangle.
  ctx.save();
  ctx.translate(w / 2, h * 0.34);
  ctx.fillStyle = '#c8762e';
  for (let i = 0; i < 12; i++) {
    ctx.rotate((Math.PI * 2) / 12);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-w * 0.05, -h * 0.5);
    ctx.lineTo(w * 0.05, -h * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle = '#5c5344';
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.14);
  ctx.lineTo(w * 0.78, h * 0.46);
  ctx.lineTo(w * 0.22, h * 0.46);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f4f1e8';
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.14);
  ctx.lineTo(w * 0.61, h * 0.27);
  ctx.lineTo(w * 0.39, h * 0.27);
  ctx.closePath();
  ctx.fill(); // snow cap

  centeredText(p, 'PEAK PERFORMANCE', w / 2, h * 0.6, 'bold ' + Math.floor(h * 0.062) + 'px ' + SANS, '#2e2a22');
  centeredText(p, 'SYNERGY BEGINS WITHIN', w / 2, h * 0.68, Math.floor(h * 0.035) + 'px ' + MONO, '#6b6350');
  textBars(p, w * 0.18, h * 0.74, 2, w * 0.64, h * 0.016, '#a49a82');
  centeredText(p, 'DEPT. OF MORALE', w / 2, h * 0.92, Math.floor(h * 0.03) + 'px ' + MONO, '#8a8069');
}

/**
 * Torn-state edge damage: bite triangular notches out of the borders via
 * destination-out compositing (falls back gracefully on stub contexts).
 */
function applyTears(p: PaintPlan): void {
  const { ctx, w, h, rng } = p;
  const comp = ctx as unknown as { globalCompositeOperation?: string };
  const prev = comp.globalCompositeOperation;
  try {
    comp.globalCompositeOperation = 'destination-out';
  } catch {
    /* stub context: skip compositing mode */
  }
  ctx.fillStyle = '#000000';
  const notches = 5 + Math.floor(rng.range(0, 5));
  for (let i = 0; i < notches; i++) {
    const side = rng.int(0, 4);
    const depth = h * rng.range(0.05, 0.14);
    const frac = rng.range(0.1, 0.9);
    let x0: number, y0: number, x1: number, y1: number, xt: number, yt: number;
    switch (side) {
      case 0: // top
        x0 = frac * w - w * 0.08; y0 = 0; x1 = frac * w + w * 0.08; y1 = 0;
        xt = frac * w + rng.range(-0.03, 0.03) * w; yt = depth;
        break;
      case 1: // bottom
        x0 = frac * w - w * 0.08; y0 = h; x1 = frac * w + w * 0.08; y1 = h;
        xt = frac * w + rng.range(-0.03, 0.03) * w; yt = h - depth;
        break;
      case 2: // left
        x0 = 0; y0 = frac * h - h * 0.08; x1 = 0; y1 = frac * h + h * 0.08;
        xt = depth; yt = frac * h + rng.range(-0.03, 0.03) * h;
        break;
      default: // right
        x0 = w; y0 = frac * h - h * 0.08; x1 = w; y1 = frac * h + h * 0.08;
        xt = w - depth; yt = frac * h + rng.range(-0.03, 0.03) * h;
        break;
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(xt, yt);
    ctx.closePath();
    ctx.fill();
  }
  try {
    comp.globalCompositeOperation = prev ?? 'source-over';
  } catch {
    /* ignore */
  }
}

/**
 * Faded-state sun-bleach wash plus curl shading shared by every type.
 */
function applyAging(p: PaintPlan): void {
  const { ctx, w, h } = p;
  if (p.aging.alpha < 1) {
    // Bleach the inks toward paper colour.
    ctx.fillStyle = 'rgba(214,206,184,' + ((1 - p.aging.alpha) * 0.9).toFixed(3) + ')';
    ctx.fillRect(0, 0, w, h);
  }
  if (p.aging.curl > 0.01) {
    // Shaded lifted corner (top-right) reads as curling away from the wall.
    const s = w * 0.28 * p.aging.curl * 4;
    const g = ctx.createLinearGradient(w - s, 0, w, s);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(58,48,30,0.45)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(w - s, 0);
    ctx.lineTo(w, 0);
    ctx.lineTo(w, s);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Paint one poster into a 2D context. Deterministic given (type, state,
 * seed). Applies the state's aging profile (opacity bleach, tear notches,
 * corner curl) over the base artwork.
 */
export function paintPoster(
  ctx: PosterCtx,
  width: number,
  height: number,
  type: PosterType,
  state: PosterState,
  seed = 0,
): void {
  const plan: PaintPlan = {
    ctx,
    w: width,
    h: height,
    rng: new RNG(hash2i(seed, type.length * 31 + state.length, POSTER_SALT + 3)),
    aging: posterAging(state),
  };

  ctx.save();
  ctx.globalAlpha = plan.aging.alpha;
  switch (type) {
    case 'missing': drawMissing(plan); break;
    case 'event': drawEvent(plan); break;
    case 'safety': drawSafety(plan); break;
    case 'map': drawMap(plan); break;
    case 'motivational': drawMotivational(plan); break;
  }
  if (plan.aging.tear > 0.1) applyTears(plan);
  applyAging(plan);
  ctx.restore();
}


