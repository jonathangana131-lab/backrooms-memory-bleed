/**
 * District door-frame styles: per-district families of trim variants rolled
 * deterministically per doorway. Pure data and geometry - no engine
 * dependencies, so any chunk regenerates identically in any order.
 */
import { CELL } from '../world/constants';
import { hash2i } from '../core/rng';

/** RGB vertex-color multiplier, one 0..1 value per channel. */
export type Tint = [number, number, number];

/** Wall-run axis of the host edge: 0 = wall runs along X, 1 = along Z. */
export type Orientation = 0 | 1;

/** Clear doorway width in world units (matches mesher.ts openings). */
export const DOOR_W = 1.24;
/** Clear doorway height in world units. */
const DOOR_H = 2.14;

/** Salt keeping frame-variant rolls independent of other hashed decisions. */
const FRAME_SALT = 0xd00f;

/** One axis-aligned trim box in world space (see generateForDoorway). */
export interface BoxSpec {
  /** World-space center along X. */
  x: number;
  /** World-space center along Z. */
  z: number;
  /** Size along the wall run. */
  w: number;
  /** Height above the box base. */
  h: number;
  /** Base height above the floor; defaults to floor level. */
  y?: number;
  /** Vertex tint multiplied into the box's vertices. */
  tint: Tint;
}

/** One door-frame look within a district family. */
export interface StyleDef {
  /** Stable identifier, '<district>-<look>[-b]'. */
  id: string;
  /** Trim tint shared by jambs and head casing. */
  tint: Tint;
  /** Width of each side jamb along the wall run. */
  jambW: number;
  /** Height of the head casing box. */
  headH: number;
  /** Gap between door-leaf top and the casing base. */
  headGap: number;
  /** Kick-plate height; 0 disables kick plates. */
  kickH: number;
  /** Angle-brace square size; 0 disables corner braces. */
  brace: number;
  /** Darker tint for kick plates and braces; required when either is set. */
  accentTint?: Tint;
}

/** MAZE: bare utility openings, flat narrow trim, no accents. */
const MAZE_FAMILY: StyleDef[] = [
  { id: 'maze-flat', tint: [0.42, 0.4, 0.37], jambW: 0.1, headH: 0.1, headGap: 0.05, kickH: 0, brace: 0 },
  { id: 'maze-flat-b', tint: [0.38, 0.36, 0.34], jambW: 0.08, headH: 0.09, headGap: 0.06, kickH: 0, brace: 0 },
];

/** OPEN_OFFICE / HONEYCOMB: wider commercial casings with scuff-guard kick plates. */
const OFFICE_FAMILY: StyleDef[] = [
  { id: 'office-commercial', tint: [0.5, 0.48, 0.45], jambW: 0.14, headH: 0.12, headGap: 0.04, kickH: 0.35, brace: 0, accentTint: [0.3, 0.29, 0.28] },
  { id: 'office-commercial-b', tint: [0.46, 0.44, 0.42], jambW: 0.12, headH: 0.14, headGap: 0.03, kickH: 0.4, brace: 0, accentTint: [0.32, 0.3, 0.28] },
];

/** STORAGE: heavy jambs lapped by angle-iron corner braces, no kick plates. */
const STORAGE_FAMILY: StyleDef[] = [
  { id: 'storage-industrial', tint: [0.35, 0.33, 0.31], jambW: 0.16, headH: 0.14, headGap: 0.02, kickH: 0, brace: 0.25, accentTint: [0.33, 0.31, 0.29] },
  { id: 'storage-industrial-b', tint: [0.32, 0.31, 0.29], jambW: 0.13, headH: 0.16, headGap: 0.02, kickH: 0, brace: 0.22, accentTint: [0.3, 0.28, 0.27] },
];

/**
 * Style family for a district. Unspecified districts fall back to the bare
 * MAZE trim so unknown values yield simple frames instead of throwing.
 */
function familyFor(district: number): StyleDef[] {
  switch (district) {
    case 0: return MAZE_FAMILY;
    case 1:
    case 2: return OFFICE_FAMILY;
    case 4: return STORAGE_FAMILY;
    default: return MAZE_FAMILY;
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


