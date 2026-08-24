/**
 * Radio prop mesher - box emission + dial-face painting for the world
 * radios placed by radioprops.ts.
 *
 * emit() pushes three boxes into a caller-supplied vertex sink in stable
 * order (body, grille, dial): neutral white corners everywhere except the
 * dial, whose vertices carry RADIO_TINT so the face reads emissive. When
 * the caller passes a 2D context via opts.dialCtx, paintFace() draws the
 * deterministic radio face onto it: aged bakelite shell, manufacturer
 * brand from DIAL_BRANDS, the FM scale band with its 'FM  MHz' caption,
 * and a red needle at the requested or seed-resting frequency.
 *
 * Pure data + pixels - no Babylon dependency, fully deterministic given
 * (place, seed): grain, scratches and resting needle all derive from an
 * FNV/LCG pair keyed off the seed string, never Math.random.
 */
import { DIAL_BRANDS, type DialCtx } from '../gfx/radiodial';

/** Warm amber glow tint applied to the dial box's vertices. */
export const RADIO_TINT: { r: number; g: number; b: number } = { r: 1.0, g: 0.82, b: 0.45 };

/** One emitted box: flat position/color arrays plus its part name. */
export interface RadioBox {
  /** Stable part label ('body' | 'grille' | 'dial'). */
  name: string;
  /** Corner positions, xyz triplets, 8 corners per box. */
  positions: number[];
  /** Corner colors, rgba quadruplets aligned with positions. */
  colors: number[];
}

/** Sink callback receiving each emitted box. */
export type BoxEmitter = (box: RadioBox) => void;

/** Minimal placement slice consumed by emit (rotation optional). */
export interface RadioMesherPlace {
  x: number;
  z: number;
  rotY?: number;
}

/** Optional emit() behavior: tuner seed, needle frequency, dial canvas. */
export interface RadioMesherOpts {
  /** Tuner seed ('radio:<cx>:<cz>'); drives brand + grain determinism. */
  seed?: string | number;
  /** Needle frequency in MHz; omitted paints the seed-resting needle. */
  freq?: number;
  /** 2D context receiving the painted dial face, when supplied. */
  dialCtx?: DialCtx;
}

/** FNV-1a 32-bit string hash - dependency-free local copy. */
function hashOf(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Push one axis-aligned box of flat-tinted corners into addBox. */
function pushBox(
  addBox: BoxEmitter,
  name: string,
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  rgba: [number, number, number, number],
): void {
  const hw = w / 2, hd = d / 2;
  const positions: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < 8; i++) {
    positions.push(
      cx + ((i & 1) ? hw : -hw),
      cy + ((i & 2) ? h : 0),
      cz + ((i & 4) ? hd : -hd),
    );
    colors.push(rgba[0], rgba[1], rgba[2], rgba[3]);
  }
  addBox({ name, positions, colors });
}

/**
 * Emits the world-radio prop mesh and paints its dial face on request.
 */
export class RadioPropMesh {
  /**
   * Emit body/grille/dial boxes for one placed radio.
   *
   * @param place  world placement (position + optional Y rotation)
   * @param addBox vertex sink receiving each box
   * @param opts   optional seed, needle frequency, and dial canvas context
   * @returns the number of boxes emitted (always 3)
   */
  emit(place: RadioMesherPlace, addBox: BoxEmitter, opts: RadioMesherOpts = {}): number {
    const seedStr = String(opts.seed ?? '0');
    const rotY = place.rotY || 0;
    const cx = Math.cos(rotY), sz = Math.sin(rotY);
    const bodyW = 0.62, bodyH = 0.24, bodyD = 0.34;
    const WHITE: [number, number, number, number] = [1, 1, 1, 1];
    const TINT: [number, number, number, number] = [RADIO_TINT.r, RADIO_TINT.g, RADIO_TINT.b, 1];
    pushBox(addBox, 'body', place.x, 0.76 + bodyH / 2, place.z, bodyW, bodyH, bodyD, WHITE);
    pushBox(addBox, 'grille', place.x - sz * 0.01, 0.76 + bodyH / 2, place.z - cx * 0.01, bodyW * 0.7, bodyH * 0.55, bodyD * 0.2, WHITE);
    pushBox(addBox, 'dial', place.x + sz * 0.02, 0.76 + bodyH * 0.8, place.z + cx * 0.02, bodyW * 0.8, bodyH * 0.4, bodyD * 0.15, TINT);
    if (opts.dialCtx && typeof opts.dialCtx.fillRect === 'function') {
      this.paintFace(opts.dialCtx, seedStr, opts.freq);
    }
    return 3;
  }

  /**
   * Paint one deterministic dial face: bakelite shell, speckle grain,
   * scratches, DIAL_BRANDS nameplate, FM scale band, red needle at the
   * requested frequency (or the seed's resting frequency).
   *
   * @param ctx     2D context to paint into
   * @param seedStr tuner seed string keying every pseudo-random draw
   * @param freq    optional live needle frequency in MHz
   */
  paintFace(ctx: DialCtx, seedStr: string, freq?: number): void {
    const h = hashOf(seedStr);
    let state = h ^ 0x9e3779b9;
    const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const W = 128, H = 64;
    ctx.save();
    // shell
    const base = ctx.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#3a2b18');
    base.addColorStop(1, '#241a10');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    // bakelite speckle grain
    for (let i = 0; i < 48; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(255,220,160,0.05)' : 'rgba(0,0,0,0.08)';
      ctx.beginPath();
      ctx.arc(rnd() * W, rnd() * H, 0.4 + rnd() * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    // scratches
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = 'rgba(210,190,150,0.10)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(rnd() * W, H * 0.35 + rnd() * H * 0.3);
      ctx.lineTo(rnd() * W, H * 0.35 + rnd() * H * 0.3);
      ctx.stroke();
    }
    // brand nameplate
    const brand = DIAL_BRANDS[h % DIAL_BRANDS.length];
    ctx.font = 'bold 7px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e8c88f';
    ctx.fillText(brand, W / 2, 12);
    // FM scale band
    ctx.fillStyle = '#181310';
    ctx.fillRect(W * 0.08, H * 0.52, W * 0.84, H * 0.22);
    ctx.strokeStyle = '#c8a86a';
    ctx.lineWidth = 0.6;
    for (let mhz = 88; mhz <= 108; mhz += 2) {
      const x = W * 0.08 + ((mhz - 88) / 20) * W * 0.84;
      ctx.beginPath();
      ctx.moveTo(x, H * 0.52);
      ctx.lineTo(x, H * 0.60);
      ctx.stroke();
    }
    ctx.fillStyle = '#d6b254';
    ctx.font = '5px monospace';
    ctx.textAlign = 'left';
    ctx.textAlign = 'center';
    ctx.fillText('FM  MHz', W / 2, H * 0.50);
    ctx.textAlign = 'left';
    // needle at the requested or resting frequency
    const f = typeof freq === 'number' && Number.isFinite(freq)
      ? freq
      : Math.round((89 + rnd() * 18) * 10) / 10;
    const nx = W * 0.08 + ((f - 88) / 20) * W * 0.84;
    ctx.strokeStyle = '#ff4a3d';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(nx, H * 0.50);
    ctx.lineTo(nx, H * 0.76);
    ctx.stroke();
    // aging vignette
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(30,18,8,' + (rnd() * 0.06).toFixed(3) + ')';
      ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1);
    }
    ctx.restore();
  }
}
