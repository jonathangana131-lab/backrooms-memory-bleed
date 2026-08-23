/**
 * Radio geometry specs — concrete box plans for the world radios placed by
 * RadioProps (src/world/radioprops.ts).
 *
 * The mesher emits props through addBox(m, x, z, y0, y1, w, d): an
 * axis-aligned box given by its center column (x, z), an explicit y range,
 * and FULL width/depth extents. BoxSpec below mirrors that call shape one
 * field for one argument, so meshing a radio is a straight loop:
 *
 *   for (const b of RadioGeometry.specsFor(place)) {
 *     addBox(g.props, b.x, b.z, b.y0, b.y1, b.w, b.d);
 *     if (b.tint !== undefined) tintVerts(g.props, v0, ...);
 *   }
 *
 * Three parts come back, in stable order:
 *   [0] body    - bakelite box resting on the desk-top plane
 *   [1] antenna - whip approximated as a thin vertical box, mounted
 *                 back-left of the body top
 *   [2] dial    - near-flat emissive amber slab flush against the front
 *                 face (+Z), glowing at a per-radio intensity hashed from
 *                 the tuner seed so no two radios read identically
 *
 * Pure data - no Babylon dependency, fully deterministic: same inputs give
 * byte-identical specs every session.
 */
import { RADIO_PROP, DIAL_COLOR } from './radioprops';

/** One mesher-ready box: arguments of addBox() plus optional vertex tint. */
export interface BoxSpec {
  /** Center column X in world meters (addBox arg 2). */
  x: number;
  /** Center column Z in world meters (addBox arg 3). */
  z: number;
  /** Bottom of the box in world meters (addBox arg 4). */
  y0: number;
  /** Top of the box in world meters (addBox arg 5). */
  y1: number;
  /** FULL extent along X in meters (addBox arg 6). */
  w: number;
  /** FULL extent along Z in meters (addBox arg 7). */
  d: number;
  /**
   * Vertex tint as packed 0xRRGGBB (same convention as architect detail
   * quads). Undefined means "leave the material color alone".
   */
  tint?: number;
  /**
   * Emissive strength 0..1 for parts that should self-glow (the dial).
   * Undefined means non-emissive.
   */
  emissive?: number;
}

/** Which part of the radio a BoxSpec describes. */
export type RadioPart = 'body' | 'antenna' | 'dial';

/** A BoxSpec labeled with the radio part it builds. */
export interface RadioBoxSpec extends BoxSpec {
  part: RadioPart;
}

/** Minimal placement slice consumed by the builder (RadioPlacement minus seed). */
export interface RadioPlace {
  x: number;
  z: number;
  y: number;
}

/* ------------------------------------------------------------------ */
/* Deterministic details                                               */
/* ------------------------------------------------------------------ */

/** Dial glow floor: dimmest a radio's dial may sit at rest. */
export const DIAL_GLOW_MIN = 0.45;
/** Dial glow ceiling: brightest hash draw (full-blast warm amber). */
export const DIAL_GLOW_MAX = 1.0;

/** FNV-style 32-bit string hash - dependency-free local copy. */
function hashStr(s: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Dial glow intensity for one radio: a pure function of the tuner seed
 * string ('radio:<cx>:<cz>'), mapped into [DIAL_GLOW_MIN, DIAL_GLOW_MAX].
 * Callers without a seed fall back to hashing the rounded coordinates,
 * which is equally deterministic because placement itself is.
 */
export function dialGlowFor(place: RadioPlace, seed?: string): number {
  const key = seed ?? ('pos:' + Math.round(place.x * 100) + ':' + Math.round(place.z * 100));
  const frac = hashStr(key) / 4294967296;
  return DIAL_GLOW_MIN + frac * (DIAL_GLOW_MAX - DIAL_GLOW_MIN);
}

/** Packed-amber -> rgb channels, shared by the dial spec. */
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const DIAL_RGB = hexToRgb(DIAL_COLOR);

/* ------------------------------------------------------------------ */
/* Geometry builder                                                    */
/* ------------------------------------------------------------------ */

/** Local shape constants lifted from radioprops.RADIO_PROP (single source). */
const BODY_W = RADIO_PROP.width;          // 0.26 across the front
const BODY_H = RADIO_PROP.height;         // 0.15 tall
const BODY_D = RADIO_PROP.depth;          // 0.12 front-to-back
const ANT = RADIO_PROP.antenna;           // mount offsets back-left

/**
 * Antenna is drawn as this square thin box instead of a real cylinder:
 * 1cm on a side reads identically at gameplay distances at a fraction of
 * the vertex cost.
 */
export const ANTENNA_BOX_SIDE = 0.01;

export class RadioGeometry {
  /**
   * Concrete box plan for one placed radio. Deterministic in every input;
   * safe to call per chunk rebuild. Parts always come back body, antenna,
   * dial in that order.
   */
  static specsFor(place: RadioPlace, seed?: string): RadioBoxSpec[] {
    const glow = dialGlowFor(place, seed);

    // Body: rests ON the placement plane (desk top), so its base is exactly
    // place.y and it rises BODY_H above it. Centered on (place.x, place.z).
    const body: RadioBoxSpec = {
      part: 'body',
      x: place.x,
      z: place.z,
      y0: place.y,
      y1: place.y + BODY_H,
      w: BODY_W,
      d: BODY_D,
    };

    // Whip antenna: thin vertical box standing on the body top at the
    // back-left mount point, full length of the RADIO_PROP antenna (0.34).
    const antenna: RadioBoxSpec = {
      part: 'antenna',
      x: place.x + ANT.offsetX,
      z: place.z + ANT.offsetZ,
      y0: place.y + BODY_H,
      y1: place.y + BODY_H + ANT.height,
      w: ANTENNA_BOX_SIDE,
      d: ANTENNA_BOX_SIDE,
    };

    // Dial: emissive amber quad on the front face (+Z). Approximated as a
    // hair-thin box proud of the face so the same addBox loop meshes it.
    // Glow scales the amber tint so hot radios read brighter in the dark.
    const dialTint =
      (Math.round(DIAL_RGB[0] * glow * 255) << 16) |
      (Math.round(DIAL_RGB[1] * glow * 255) << 8) |
      Math.round(DIAL_RGB[2] * glow * 255);
    const dial: RadioBoxSpec = {
      part: 'dial',
      x: place.x,
      z: place.z + BODY_D / 2 + 0.002, // just proud of the front face
      y0: place.y + RADIO_PROP.dial.centerY - RADIO_PROP.dial.height / 2,
      y1: place.y + RADIO_PROP.dial.centerY + RADIO_PROP.dial.height / 2,
      w: RADIO_PROP.dial.width,
      d: 0.004,
      tint: dialTint,
      emissive: glow,
    };

    return [body, antenna, dial];
  }
}


