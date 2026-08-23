/**
 * World radio props — the physical anchors for the tuning minigame
 * (src/ui/radiotune.ts).
 *
 * An OPEN_OFFICE chunk wins an 8% lottery and grows exactly one radio:
 * a small bakelite box sitting ON TOP of a desk surface (the mesher's
 * desk prop tops out at y=0.70..0.76, so the radio rests at desk-top
 * height), with a thin whip antenna and a warm emissive dial face so it
 * reads as "alive" in the dark from across the office carpet.
 *
 * Placement is a pure function of (cx, cz, district) through a private
 * salt, so the same chunk always hosts the same radio at the same spot,
 * independent of load order or session. Every radio carries a stable
 * SEED STRING ('radio:<cx>:<cz>') which is what the interaction system
 * hands to RadioTuner.open(seed) - the tuner derives the hidden carrier
 * frequency and lore fragment from that string via hashSeed(), so a
 * given radio always hides the same station forever.
 *
 * Pure data + logic - no Babylon dependency. The mesher consumes the
 * geometry constants below (box body + antenna cylinder + emissive dial
 * quad); game wiring consumes RadioProps.tryPlace / getPlacements.
 */

/** District.OPEN_OFFICE ordinal in constants.ts (kept local: dependency-free). */
const OPEN_OFFICE = 1;

/** Grid cell size in meters (mirrors constants.CELL). */
const CELL = 2.5;
/** Cells per chunk side (mirrors constants.CHUNK_CELLS). */
const CHUNK_CELLS = 12;

/**
 * Top surface of the mesher's 'desk' prop in meters (mesher.ts draws the
 * desktop slab from y 0.70 to 0.76). The radio rests on this plane.
 */
export const DESK_TOP_Y = 0.76;

/**
 * Per-chunk probability that one radio spawns in an eligible
 * OPEN_OFFICE chunk (~1 radio per 12-13 open-office chunks).
 */
export const RADIO_CHANCE = 0.08;

/** Private salt so radio placement never correlates with other features. */
const RADIO_SALT = 0x7ad10;

/** Keep the spawn plaza clear, matching architect.generateProps. */
const SPAWN_CLEAR_RADIUS = 9;

/* ------------------------------------------------------------------ */
/* Geometry (consumed by the mesher / gfx layer)                       */
/* ------------------------------------------------------------------ */

/** What the renderer needs to build one radio mesh. */
export interface RadioPropSpec {
  /** Body box footprint along local X, meters. */
  width: number;
  /** Body box footprint along local Z, meters. */
  depth: number;
  /** Body box height above its resting surface, meters. */
  height: number;
  /** Whip antenna: radius, length, mount offset from body center. */
  antenna: { radius: number; height: number; offsetX: number; offsetZ: number };
  /** Dial face: emissive quad size and center height above the surface. */
  dial: { width: number; height: number; centerY: number };
}

/**
 * Shared radio shape. Small enough to sit on a desk without blocking the
 * walk grid; the dial faces +Z so rot 0 presents it toward open floor.
 */
export const RADIO_PROP: RadioPropSpec = {
  width: 0.26,
  depth: 0.12,
  height: 0.15,
  antenna: { radius: 0.006, height: 0.34, offsetX: -0.09, offsetZ: -0.03 },
  dial: { width: 0.18, height: 0.07, centerY: 0.08 },
};

/** Warm amber glow for the dial quad (hex), matching the tuner UI accent. */
export const DIAL_COLOR = '#d6b254';

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

/**
 * One placed radio, shaped for the interaction system: world position
 * plus the tuner seed. Interaction code calls RadioTuner.open(seed).
 */
export interface RadioPlacement {
  x: number;
  z: number;
  y: number;
  /** Stable tuner seed string - flows straight into RadioTuner.open(). */
  seed: string;
}

// --- deterministic hashing (local copy so the module stays dependency-free) ---

function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(a: number, b: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(a | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(b | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

function frac(h: number): number {
  return h / 4294967296;
}

/**
 * Static registry of every radio decided this session, keyed by
 * '<cx>,<cz>'. Interaction systems scan this instead of re-hashing.
 */
const placements = new Map<string, RadioPlacement>();

/** Chunk key used by the placement registry. */
export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

export class RadioProps {
  /**
   * Deterministic placement decision for one chunk. Returns the radio
   * (registered into the placement map) when this chunk hosts one, null
   * otherwise. Safe to call repeatedly - the same inputs always yield
   * the same radio, and repeat wins do not duplicate entries.
   */
  static tryPlace(cx: number, cz: number, district: number): RadioPlacement | null {
    const key = chunkKey(cx, cz);
    const known = placements.get(key);
    if (known) return known;

    // Only open offices host radios.
    if (district !== OPEN_OFFICE) return null;

    // Rarity gate: ~8% of open-office chunks win the lottery.
    const h = hash2(cx, cz, RADIO_SALT);
    if (frac(h) >= RADIO_CHANCE) return null;

    // Pick an interior cell away from the chunk rim so the desk it lands
    // on is never clipped by the neighbour dressing pass, then jitter the
    // radio toward one edge of that cell (radios sit at desk corners).
    const hx = hash2(cx, cz, RADIO_SALT ^ 0xc01a);
    const hz = hash2(cx, cz, RADIO_SALT ^ 0x21ce);
    const jx = hash2(cx, cz, RADIO_SALT ^ 0x07ff);
    const jz = hash2(cx, cz, RADIO_SALT ^ 0x33aa);
    const lx = 2 + (hx % (CHUNK_CELLS - 4)); // local cell 2..9
    const lz = 2 + (hz % (CHUNK_CELLS - 4));
    const wx = (cx * CHUNK_CELLS + lx + 0.3 + frac(jx) * 0.4) * CELL;
    const wz = (cz * CHUNK_CELLS + lz + 0.3 + frac(jz) * 0.4) * CELL;

    // Never put a radio where the player wakes up.
    if (Math.hypot(wx, wz) < SPAWN_CLEAR_RADIUS) return null;

    const placement: RadioPlacement = {
      x: Math.round(wx * 100) / 100,
      z: Math.round(wz * 100) / 100,
      y: DESK_TOP_Y,
      seed: 'radio:' + cx + ':' + cz,
    };
    placements.set(key, placement);
    return placement;
  }

  /**
   * Every radio decided so far, keyed by '<cx>,<cz>'. The map is live -
   * later tryPlace calls appear in it - so interaction wiring can hold
   * one reference for the whole session.
   */
  static getPlacements(): Map<string, RadioPlacement> {
    return placements;
  }

  /** The radio hosted by one specific chunk, if any (registry lookup). */
  static getAt(cx: number, cz: number): RadioPlacement | undefined {
    return placements.get(chunkKey(cx, cz));
  }
}


