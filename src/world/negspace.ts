/**
 * Negative-space rooms (F55): void silhouettes where furniture should be.
 *
 * Pure model, no Babylon imports. A room layout with furniture footprints is
 * injected; a seeded subset of rooms become negative-space per world seed.
 * In a negative-space room every furniture footprint is ABSENT from
 * collision - cells are fully walkable where furniture would stand - yet the
 * footprints are flagged as dark void silhouettes for the renderer. The
 * wrongness: collision matches absence, silhouettes match memory.
 */
import { hash3i } from '../core/rng';

/** Salt so negative-space draws never correlate with any other feature. */
const NEGSPACE_SALT = 0x0f55;

/** Grid cell size in metres used by classifyRoom. */
export const CELL_M = 0.5;

/** Axis-aligned furniture footprint in room-local metres. */
export interface FurnitureRect {
  /** Min corner x. */
  readonly x: number;
  /** Min corner z. */
  readonly z: number;
  /** Extent along x (>= 0). */
  readonly w: number;
  /** Extent along z (>= 0). */
  readonly h: number;
}

/** Injected room layout: dimensions plus furniture footprints. */
export interface RoomLayout {
  /** Stable room identifier within the world. */
  readonly roomId: number;
  /** Room extent along x in metres (> 0). */
  readonly w: number;
  /** Room extent along z in metres (> 0). */
  readonly h: number;
  /** Furniture footprints inside the room bounds. */
  readonly furnitureRects: readonly FurnitureRect[];
}

/** Classification of one grid cell of a room. */
export interface CellClass {
  /** Agents may occupy this cell. */
  readonly walkable: boolean;
  /** Collision world blocks movement through this cell. */
  readonly collider: boolean;
  /** Renderer draws a dark void silhouette here despite walkability. */
  readonly silhouette: boolean;
}

/** Full classification result for a classified room. */
export interface RoomClassification {
  /** Room id this classification belongs to. */
  readonly roomId: number;
  /** Whether the room became negative-space under the world seed. */
  readonly negative: boolean;
  /** World seed used for the subset draw. */
  readonly worldSeed: number;
  /**
   * Cell classes keyed "cellX,cellZ" in CELL_M grid units from the room's
   * min corner. Only cells covered by the room bounds appear.
   */
  readonly cells: Readonly<Record<string, CellClass>>;
}

/**
 * Seeded subset gate: does this room become negative-space? Deterministic
 * per (worldSeed, roomId); roughly one room in three qualifies.
 * @param worldSeed Master run seed.
 * @param roomId Stable room identifier.
 * @returns True when the room is negative-space.
 */
export function isNegativeSpace(worldSeed: number, roomId: number): boolean {
  return hash3i(roomId, 0x5eed, worldSeed ^ NEGSPACE_SALT) < (1 / 3) * 4294967296;
}

function key(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/** Whether a CELL_M grid cell intersects any furniture footprint. */
function rectIntersectsCell(r: FurnitureRect, px: number, pz: number): boolean {
  return r.x < px + CELL_M && r.x + r.w > px && r.z < pz + CELL_M && r.z + r.h > pz;
}

function validateLayout(layout: RoomLayout): void {
  if (!(layout.w > 0) || !(layout.h > 0)) {
    throw new Error(`negspace: room ${layout.roomId} has non-positive extent ${layout.w}x${layout.h}`);
  }
  for (const r of layout.furnitureRects) {
    if (r.w <= 0 || r.h <= 0 || !(r.x >= 0 && r.z >= 0 && r.x + r.w <= layout.w && r.z + r.h <= layout.h)) {
      throw new Error(
        `negspace: room ${layout.roomId} furniture rect ${JSON.stringify(r)} outside bounds ${layout.w}x${layout.h}`,
      );
    }
  }
}

/**
 * Classify every grid cell of an injected room layout.
 *
 * Negative rooms: furniture-rect cells are walkable + silhouette and carry NO
 * collider (collision matches absence); empty cells are plain walkable floor.
 * Non-negative rooms behave like ordinary rooms: furniture blocks movement,
 * nothing renders as silhouette.
 * @param layout Injected room layout.
 * @param worldSeed Master run seed driving the negative-subset draw.
 * @returns Full cell classification for the room.
 * @throws When the layout extent is non-positive or any rect escapes it -
 *   malformed layouts fail loud rather than classify partially.
 */
export function classifyRoom(layout: RoomLayout, worldSeed: number): RoomClassification {
  validateLayout(layout);
  const negative = isNegativeSpace(worldSeed, layout.roomId);
  const nx = Math.ceil(layout.w / CELL_M);
  const nz = Math.ceil(layout.h / CELL_M);
  const cells: Record<string, CellClass> = {};
  for (let cx = 0; cx < nx; cx++) {
    for (let cz = 0; cz < nz; cz++) {
      const px = cx * CELL_M;
      const pz = cz * CELL_M;
      let inFurniture = false;
      if (!negative) {
        for (const r of layout.furnitureRects) {
          if (rectIntersectsCell(r, px, pz)) { inFurniture = true; break; }
        }
      }
      cells[key(cx, cz)] = negative
        ? (layout.furnitureRects.some((r) => rectIntersectsCell(r, px, pz))
          ? { walkable: true, collider: false, silhouette: true }
          : { walkable: true, collider: false, silhouette: false })
        : (inFurniture
          ? { walkable: false, collider: true, silhouette: false }
          : { walkable: true, collider: false, silhouette: false });
    }
  }
  return { roomId: layout.roomId, negative, worldSeed, cells };
}

/**
 * Query one cell of a classification.
 * @param cls Classification returned by classifyRoom.
 * @param cellX Cell index along x in CELL_M units.
 * @param cellZ Cell index along z in CELL_M units.
 * @returns The cell class, or undefined outside the room.
 */
export function cellAt(cls: RoomClassification, cellX: number, cellZ: number): CellClass | undefined {
  return cls.cells[key(cellX, cellZ)];
}

/**
 * Serialize a classification to a plain JSON-ready record (stable key order).
 * @param cls Classification to serialize.
 * @returns JSON-stringifyable record.
 */
export function serializeClassification(cls: RoomClassification): Record<string, unknown> {
  return {
    roomId: cls.roomId,
    negative: cls.negative,
    worldSeed: cls.worldSeed,
    cells: Object.fromEntries(
      Object.entries(cls.cells).map(([k, v]) => [k, [v.walkable, v.collider, v.silhouette]]),
    ),
  };
}

/**
 * Deserialize a record produced by serializeClassification into a live
 * classification whose queries compare deep-equal to the original.
 * @param data Record from serializeClassification (e.g. parsed save JSON).
 * @returns Rebuilt classification.
 */
export function deserializeClassification(data: ReturnType<typeof serializeClassification>): RoomClassification {
  const cells: Record<string, CellClass> = {};
  for (const [k, v] of Object.entries(data.cells as Record<string, [boolean, boolean, boolean]>)) {
    const [walkable, collider, silhouette] = v;
    cells[k] = { walkable, collider, silhouette };
  }
  return { roomId: data.roomId as number, negative: data.negative as boolean, worldSeed: data.worldSeed as number, cells };
}
