/**
 * Volumetric god-rays (F38): shafts through missing ceiling tiles, dust
 * lit per-shaft.
 *
 * Pure model -- no engine dependency. The mesher/particle consumer feeds a
 * ceiling-gap layout query (world-space cells where the ceiling is
 * missing) plus the current sun angle; emit() returns at most maxShafts
 * (hard cap 8) shaft descriptors:
 *
 *   { originX, originZ, dirAngle, widthM, lengthM, intensity,
 *     dustDensity }
 *
 * intensity is a strictly decreasing function of shaft length alone, so
 * longer shafts are always dimmer; dustDensity scales mote density along
 * each shaft with its light level plus a per-cell hashed variation.
 *
 * DETERMINISM: output is a pure function of (canonical layout hash,
 * quantized sun angle). Gap cells are sorted canonically before hashing
 * and priority selection, so query order never matters; sun angles are
 * quantized to 1-degree steps so sub-degree jitter cannot change the
 * result.
 */
// --- mirrored deterministic helpers (tiledisplace.ts precedent: local copy
// --- of src/core/rng.ts hash2i so the module stays dependency-free under
// --- direct node strip-types test imports; algorithm identical to the RNG law)

function hash32(x: number): number {
  x |= 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2i(x: number, y: number, salt = 0): number {
  let h = salt | 0;
  h = Math.imul(h ^ hash32(x | 0), 0x9e3779b1);
  h = Math.imul(h ^ hash32(y | 0), 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Hard frame-cost budget: never more than this many shafts. */
export const MAX_SHAFTS_HARD_CAP = 8;

/** Sun-angle quantum for determinism (radians). */
export const SUN_ANGLE_QUANTUM_RAD = Math.PI / 180;

/** Reference length for the exponential intensity falloff (meters). */
export const SHAFT_FALLOFF_REF_M = 6;

/** Default gap width when a cell omits widthM (typical tile, meters). */
export const DEFAULT_GAP_WIDTH_M = 1.2;
/** Default ceiling height (meters). */
export const DEFAULT_CEILING_HEIGHT_M = 3.0;

/** Elevation clamp: near-horizontal suns would make absurd shafts. */
export const MIN_ELEVATION_RAD = 0.15;

/** Salt separating god-ray hashing from every other feature. */
export const GODRAY_SALT = 0x60d;

/** One missing-ceiling cell in world space. */
export interface GodrayGapCell {
  /** Cell center X in meters. */
  x: number;
  /** Cell center Z in meters. */
  z: number;
  /** Optional opening width in meters (defaults to DEFAULT_GAP_WIDTH_M). */
  widthM?: number;
}

/** Injected layout query for ceiling gaps. */
export interface GodrayLayoutQuery {
  /**
   * Current missing-ceiling cells. Called once per emit(); order is
   * irrelevant (canonically sorted internally).
   */
  gaps(): GodrayGapCell[];
}

/** Sun direction input; azimuth/elevation in radians. */
export interface SunAngle {
  /** Plan direction the light travels toward (radians). */
  azimuthRad: number;
  /** Height above the horizon (radians, clamped to >= MIN_ELEVATION_RAD). */
  elevationRad: number;
}

/** One emitted volumetric shaft descriptor. */
export interface GodrayShaft {
  /** Shaft origin X in meters (upstream edge of the opening). */
  originX: number;
  /** Shaft origin Z in meters. */
  originZ: number;
  /** Plan direction of the shaft in radians (quantized azimuth). */
  dirAngle: number;
  /** Opening width projected by the sun elevation (meters). */
  widthM: number;
  /** Floor-to-ceiling slant path length (meters). */
  lengthM: number;
  /** Light level [0..1]; strictly decreasing in lengthM. */
  intensity: number;
  /** Dust-mote density multiplier along this shaft (> 0). */
  dustDensity: number;
}

/** Construction options; every field has a procedural default. */
export interface GodraysConfig {
  /** Shaft budget, clamped hard to MAX_SHAFTS_HARD_CAP. */
  maxShafts?: number;
  /** Deterministic seed for per-cell priority + dust variation. */
  seed?: number;
  /** Ceiling height in meters. */
  ceilingHeightM?: number;
}

/**
 * Canonical layout identity: order-independent hash of the quantized gap
 * cells. Two queries describing the same layout always agree.
 * @param cells gap cells in any order
 * @returns 32-bit layout hash
 */
export function layoutHash(cells: readonly GodrayGapCell[]): number {
  const canon = canonicalCells(cells);
  let acc = GODRAY_SALT ^ canon.length;
  for (const c of canon) {
    acc = hash2i(acc, Math.round(c.x * 100), 0x1a2b);
    acc = hash2i(acc, Math.round(c.z * 100), 0x3c4d);
    acc = hash2i(acc, Math.round((c.w ?? 0) * 1000), 0x5e6f);
  }
  return acc >>> 0;
}

function canonicalCells(cells: readonly GodrayGapCell[]): { x: number; z: number; w: number }[] {
  const out: { x: number; z: number; w: number }[] = [];
  for (const c of cells ?? []) {
    if (!c || typeof c !== 'object') continue;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
    const w = Number.isFinite(c.widthM as number)
      ? Math.max(0.05, c.widthM as number)
      : DEFAULT_GAP_WIDTH_M;
    out.push({ x: c.x, z: c.z, w });
  }
  out.sort((a, b) => (a.x - b.x) || (a.z - b.z));
  // de-duplicate coincident cells so double-registered layouts stay stable
  return out.filter((c, i) => i === 0 || c.x !== out[i - 1].x || c.z !== out[i - 1].z);
}

function quantizeAngle(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  const steps = Math.round(rad / SUN_ANGLE_QUANTUM_RAD);
  return steps * SUN_ANGLE_QUANTUM_RAD;
}

/**
 * God-ray model over an injected ceiling-gap layout. Any number of
 * instances may share one layout query.
 */
export class Godrays {
  private readonly layout: GodrayLayoutQuery;
  private readonly maxShafts: number;
  private readonly seed: number;
  private readonly heightM: number;

  constructor(layout: GodrayLayoutQuery, config: GodraysConfig = {}) {
    this.layout = layout;
    const m = config.maxShafts ?? MAX_SHAFTS_HARD_CAP;
    this.maxShafts = Number.isFinite(m)
      ? Math.max(0, Math.min(MAX_SHAFTS_HARD_CAP, Math.floor(m)))
      : MAX_SHAFTS_HARD_CAP;
    this.seed = (config.seed ?? 0) | 0;
    const h = config.ceilingHeightM ?? DEFAULT_CEILING_HEIGHT_M;
    this.heightM = Number.isFinite(h) ? Math.max(0.5, h) : DEFAULT_CEILING_HEIGHT_M;
  }

  /**
   * Emit the shaft set for one sun angle. Pure function of (layout hash,
   * quantized sun angle); deterministic and allocation-light.
   * @param sun current sun direction
   * @returns up to maxShafts descriptors; empty with no gaps or junk sun
   */
  emit(sun: SunAngle): GodrayShaft[] {
    if (!sun || typeof sun !== 'object') return [];
    if (!Number.isFinite(sun.azimuthRad) || !Number.isFinite(sun.elevationRad)) return [];
    const azimuth = quantizeAngle(sun.azimuthRad);
    const elevation = Math.max(
      MIN_ELEVATION_RAD,
      Math.min(Math.PI / 2, quantizeAngle(sun.elevationRad)),
    );

    const cells = canonicalCells(this.layout.gaps());
    if (cells.length === 0) return [];
    const sinE = Math.sin(elevation);

    const candidates = cells.map((c) => {
      // slant path from ceiling plane to floor grows as the sun lowers;
      // bounded so grazing suns cannot run away
      const lengthM = Math.min(this.heightM / sinE, this.heightM * 3.8);
      // strictly decreasing in length: pure exponential falloff
      const intensity = Math.exp(-(lengthM - this.heightM) / SHAFT_FALLOFF_REF_M);
      // deterministic per-cell priority decides who wins the budget
      const priority = hash2i(
        hash2i(Math.round(c.x * 100), Math.round(c.z * 100), this.seed ^ GODRAY_SALT),
        Math.round(elevation * 1000),
      ) / 4294967296;
      return { c, lengthM, intensity, priority };
    });

    candidates.sort((a, b) => (b.priority - a.priority) || (a.c.x - b.c.x) || (a.c.z - b.c.z));

    return candidates.slice(0, this.maxShafts).map(({ c, lengthM, intensity }) => {
      const widthM = c.w * (0.35 + 0.65 * sinE);
      const dustHash = hash2i(Math.round(c.x * 7), Math.round(c.z * 7), this.seed ^ 0xd057);
      const dustDensity = (0.4 + 1.6 * intensity) * (0.75 + 0.5 * (dustHash / 4294967296));
      return {
        originX: c.x - Math.cos(azimuth) * c.w * 0.5,
        originZ: c.z - Math.sin(azimuth) * c.w * 0.5,
        dirAngle: azimuth,
        widthM,
        lengthM,
        intensity,
        dustDensity,
      };
    });
  }
}
