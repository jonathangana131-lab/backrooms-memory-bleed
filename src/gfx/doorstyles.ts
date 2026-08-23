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


