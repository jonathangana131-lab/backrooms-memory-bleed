/**
 * District-specific door frame treatments.
 *
 * The mesher's built-in doorFrame() draws one generic trim profile around
 * every doorway. This module layers variety on top: each district family
 * gets its own frame treatment, and every individual doorway rolls a
 * deterministic variant plus a small dimensional jitter so no two corridors
 * feel stamped from the same die.
 *
 * Families:
 *   MAZE (0)                - simple flat trim, narrow painted boards
 *   OPEN_OFFICE (1)         - wider commercial casings with sheet-metal
 *   HONEYCOMB (2)             kick plates at the base of each jamb
 *   CORRIDOR_GRID (3)       - falls back to the simple maze trim (unspecified)
 *   STORAGE (4)             - heavy industrial frames with angle-iron corner
 *                             braces and a deeper header beam
 *
 * Selection is pure hashing (salted so frame rolls never correlate with any
 * other hashed world feature): hash(district, doorX, doorZ) picks the
 * variant within the family and a width scale of +/-5%, so regeneration of
 * the same chunk always reproduces identical frames.
 *
 * Pure logic - no engine dependencies. The mesher consumes the returned box
 * specs through its wallBox()/tintVerts() pattern.
 */
import { CELL } from '../world/constants';
import { hash2i } from '../core/rng';

/** Salt so door-frame hashes never correlate with other hashed features. */
const FRAME_SALT = 0xd00a;

/** Opening dimensions mirrored from mesher.ts (kept private there). */
export const DOOR_W = 1.24;
export const DOOR_H = 2.14;

/**
 * Wall-run orientation of the doorway:
 *   0 - wall runs along X (frame boxes vary in x, fixed z band)
 *   1 - wall runs along Z (frame boxes vary in z, fixed x band)
 */
export type Orientation = 0 | 1;

/** RGB tint multipliers, matching the mesher's vertex-tint convention. */
export type Tint = readonly [number, number, number];

/**
 * One axis-aligned box of trim. x/z is the box center in world space,
 * w its size along the wall run, h its height, and y the base height above
 * the floor (default 0). The across-wall extent is implied by the style's
 * protrusion and the wall thickness - consumers expand it symmetrically
 * around the wall plane exactly like mesher.doorFrame().
 */
export interface BoxSpec {
  x: number;
  z: number;
  w: number;
  h: number;
  tint: Tint;
  y?: number;
}

/** Static description of one frame treatment. */
export interface StyleDef {
  id: string;
  name: string;
  /** Jamb width along the wall run. */
  jambW: number;
  /** How far jambs protrude past each wall face. */
  jambOut: number;
  /** Head casing height. */
  headH: number;
  /** Vertical gap between door top and head casing bottom. */
  headGap: number;
  /** Kick plate height; 0 = family has no kick plates. */
  kickH: number;
  /** Angle-iron corner brace size; 0 = family has no braces. */
  brace: number;
  /** Trim tint multiplied into the wall material. */
  tint: Tint;
  /** Accent tint for plates/braces; null when the family has neither. */
  accentTint: Tint | null;
}

/* ------------------------------------------------------------------ */
/* Family tables                                                       */
/* ------------------------------------------------------------------ */

/** Simple flat trim - narrow painted boards, barely proud of the wall. */
const MAZE_TRIM: StyleDef[] = [
  {
    id: 'maze-flat-a', name: 'flat trim',
    jambW: 0.07, jambOut: 0.02, headH: 0.08, headGap: 0.02,
    kickH: 0, brace: 0,
    tint: [0.80, 0.77, 0.72], accentTint: null,
  },
  {
    id: 'maze-flat-b', name: 'flat trim (narrow)',
    jambW: 0.055, jambOut: 0.015, headH: 0.06, headGap: 0.03,
    kickH: 0, brace: 0,
    tint: [0.76, 0.73, 0.68], accentTint: null,
  },
];

/** Wider commercial casing with sheet-metal kick plates. */
const COMMERCIAL_FRAME: StyleDef[] = [
  {
    id: 'office-commercial-a', name: 'commercial casing',
    jambW: 0.13, jambOut: 0.055, headH: 0.12, headGap: 0.01,
    kickH: 0.34, brace: 0,
    tint: [0.66, 0.66, 0.63], accentTint: [0.44, 0.46, 0.49],
  },
  {
    id: 'office-commercial-b', name: 'commercial casing (tall plate)',
    jambW: 0.15, jambOut: 0.06, headH: 0.10, headGap: 0.01,
    kickH: 0.42, brace: 0,
    tint: [0.62, 0.62, 0.60], accentTint: [0.40, 0.42, 0.46],
  },
];

/** Heavy industrial frame with angle-iron corners and a deep header. */
const INDUSTRIAL_FRAME: StyleDef[] = [
  {
    id: 'storage-angleiron-a', name: 'angle-iron frame',
    jambW: 0.16, jambOut: 0.07, headH: 0.18, headGap: 0,
    kickH: 0, brace: 0.20,
    tint: [0.50, 0.48, 0.45], accentTint: [0.33, 0.31, 0.29],
  },
  {
    id: 'storage-angleiron-b', name: 'angle-iron frame (heavy)',
    jambW: 0.19, jambOut: 0.08, headH: 0.22, headGap: 0,
    kickH: 0, brace: 0.26,
    tint: [0.46, 0.44, 0.42], accentTint: [0.30, 0.28, 0.27],
  },
];

function familyFor(district: number): StyleDef[] {
  switch (district) {
    case 0: return MAZE_TRIM;            // District.MAZE
    case 1:                              // District.OPEN_OFFICE
    case 2: return COMMERCIAL_FRAME;     // District.HONEYCOMB
    case 4: return INDUSTRIAL_FRAME;     // District.STORAGE
    default: return MAZE_TRIM;           // CORRIDOR_GRID & anything new
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export const DoorStyles = {
  /**
   * Canonical frame treatment for a district (variant 0 of its family).
   * Per-doorway variant selection happens in generateForDoorway().
   */
  forDistrict(district: number): StyleDef {
    return familyFor(district)[0];
  },

  /**
   * Emit the frame boxes for one doorway.
   *
   * @param doorX doorway cell coordinate (integer grid space)
   * @param doorZ doorway cell coordinate (integer grid space)
   * @param orientation 0 = wall runs along X, 1 = wall runs along Z
   * @param district District value styling the frame
   * @returns box specs centered on the doorway world position
   */
  generateForDoorway(
    doorX: number,
    doorZ: number,
    orientation: Orientation,
    district: number,
  ): BoxSpec[] {
    const family = familyFor(district);
    const h = hash2i(doorX, doorZ, FRAME_SALT ^ (district * 0x9e37));
    const style = family[h % family.length];

    // Dimensional variation: overall frame width +/-5% in 1% steps.
    const widthScale = 1 + (((h >>> 7) % 11) - 5) / 100;
    const dw = (DOOR_W / 2) * widthScale;

    // World-space doorway center.
    const cxm = (doorX + 0.5) * CELL;
    const czm = (doorZ + 0.5) * CELL;

    const boxes: BoxSpec[] = [];
    const push = (along: number, w: number, hh: number, tint: Tint, y = 0): void => {
      if (orientation === 0) {
        boxes.push({ x: cxm + along, z: czm, w, h: hh, tint, y });
      } else {
        boxes.push({ x: cxm, z: czm + along, w, h: hh, tint, y });
      }
    };

    const trim = style.tint;

    // Two jambs flanking the opening, floor to just above the door leaf.
    const jambH = DOOR_H + 0.06;
    for (const s of [-1, 1]) {
      push(s * (dw + style.jambW / 2), style.jambW, jambH, trim);
    }

    // Head casing spanning the opening plus both jambs.
    push(0, 2 * dw + 2 * style.jambW, style.headH, trim, DOOR_H + style.headGap);

    // Commercial kick plates: sheet metal scuff guards at each jamb base.
    if (style.kickH > 0 && style.accentTint) {
      for (const s of [-1, 1]) {
        push(s * (dw + style.jambW / 2), style.jambW * 0.92, style.kickH, style.accentTint, 0.03);
      }
    }

    // Industrial angle-iron corner braces lap the jamb/head junction.
    if (style.brace > 0 && style.accentTint) {
      for (const s of [-1, 1]) {
        push(s * (dw + style.jambW / 2), style.brace, style.brace, style.accentTint, DOOR_H - style.brace);
      }
    }

    return boxes;
  },
};


