/** World scale constants. All units are meters. */
export const CELL = 2.5;                 // grid cell size
export const CHUNK_CELLS = 12;           // cells per chunk side
export const CHUNK_SIZE = CELL * CHUNK_CELLS; // 30 m
export const WALL_H = 3.05;              // floor(0) to ceiling
export const WALL_T = 0.16;              // wall thickness

export const enum EdgeCode {
  OPEN = 0,
  SOLID = 1,
  DOORWAY = 2,
}

/** Architectural districts (macro-scale variation). */
export const enum District {
  MAZE = 0,
  OPEN_OFFICE = 1,
  HONEYCOMB = 2,
  CORRIDOR_GRID = 3,
  STORAGE = 4,
}

export const DISTRICT_NAMES = ['MAZE', 'OPEN_OFFICE', 'HONEYCOMB', 'CORRIDOR_GRID', 'STORAGE'] as const;

/** Salt offsets so independent features never correlate. */
export const SALTS = {
  district: 0x11,
  density: 0x22,
  edgeH: 0x33,
  edgeV: 0x44,
  door: 0x55,
  pillar: 0x66,
  light: 0x77,
  blackout: 0x88,
  prop: 0x99,
  flicker: 0xaa,
  room: 0xbb,
} as const;

export function worldToCell(w: number): number {
  return Math.floor(w / CELL);
}
export function cellToWorld(c: number): number {
  return (c + 0.5) * CELL;
}
export function worldToChunk(w: number): number {
  return Math.floor(w / CHUNK_SIZE);
}


