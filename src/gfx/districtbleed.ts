/**
 * F53 District color bleed — border chunks blend palettes over a one-chunk
 * gradient.
 *
 * Every chunk belongs to a district (injected chunk→ordinal map) and every
 * district has a palette colour (injected ordinal→{r,g,b} table). Interior
 * chunks — all four 4-neighbours in the same district — render their pure
 * palette colour. Border chunks blend toward the average colour of their
 * differing neighbours, weighted by the fraction of differing neighbours
 * times BLEED_GAIN, so a palette change fades across one chunk of width
 * instead of stepping at the border.
 *
 * Documented fallbacks:
 * - Chunk coordinates absent from the district map resolve to
 *   FALLBACK_DISTRICT; consequently an unmapped chunk adjacent to a mapped
 *   one counts as DIFFERING (map edges bleed into the fallback bedstone).
 * - Ordinals missing from the palette table (junk ordinals) and any
 *   non-finite or out-of-range channel values resolve to FALLBACK_COLOR.
 *   Two distinct junk ordinals still count as different districts (their
 *   border blends), but since both sides resolve to FALLBACK_COLOR the
 *   blend is visually a no-op.
 *
 * Continuity guarantee: every returned channel is `own × (1 − w) +
 * neighbourAvg × w` with w = BLEED_GAIN × differingFraction ≤ BLEED_GAIN,
 * so for two ADJACENT chunks (each counting the other as differing when
 * they differ) the worst-case channel delta is exactly
 * MAX_TINT_STEP_DELTA = 255 × (1 − BLEED_GAIN / 2); test/districtbleed-test.mjs
 * verifies that bound exhaustively over adversarial palettes. Weights are
 * symmetric: the difference predicate between two chunks does not depend
 * on which side queries.
 *
 * Pure logic — no engine dependencies, no state.
 */

/** One sRGB-ish colour channel triple, each channel clamped to [0, 255]. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Palette table: district ordinal → colour. */
export type DistrictPalette = Readonly<Record<number, RGB>>;

/** District ordinal standing in for chunk coordinates absent from the map. */
export const FALLBACK_DISTRICT = -1;

/**
 * Colour used for junk ordinals (not present in the palette table) and for
 * sanitising invalid palette entries — a neutral bedstone grey.
 */
export const FALLBACK_COLOR: Readonly<RGB> = { r: 64, g: 62, b: 58 };

/** How far a fully-bordering chunk shifts toward its neighbours' average. */
export const BLEED_GAIN = 0.5;

/**
 * Tight worst-case channel delta between two ADJACENT chunks under any
 * district layout and any clamped palette (see header derivation).
 */
export const MAX_TINT_STEP_DELTA = 255 * (1 - BLEED_GAIN / 2);

/** The four 4-neighbour offsets. */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> =
  [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Stable string key for a chunk coordinate pair (chunkDeltas idiom). */
export function chunkKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

/**
 * Resolve a chunk's district; coordinates absent from the map fall back to
 * FALLBACK_DISTRICT (documented above).
 */
export function resolveDistrict(
  districts: ReadonlyMap<string, number>,
  cx: number,
  cz: number,
): number {
  return districts.get(chunkKey(cx, cz)) ?? FALLBACK_DISTRICT;
}

/** @returns The channel value when finite and inside [0, 255], else null. */
function validChannel(v: number): number | null {
  return Number.isFinite(v) && v >= 0 && v <= 255 ? v : null;
}

/**
 * Resolve a district's palette colour. Junk ordinals and entries with any
 * non-finite or out-of-range channel fall back to FALLBACK_COLOR — any
 * single bad channel rejects the whole entry so partially-written palettes
 * stay consistent instead of rendering half-clamped colours.
 */
export function resolveColor(palette: DistrictPalette, ordinal: number): RGB {
  const c = palette[ordinal];
  if (!c || typeof c !== 'object') return { ...FALLBACK_COLOR };
  const r = validChannel(c.r);
  const g = validChannel(c.g);
  const b = validChannel(c.b);
  if (r === null || g === null || b === null) return { ...FALLBACK_COLOR };
  return { r, g, b };
}

/**
 * Number of this chunk's 4-neighbours whose resolved district differs from
 * the chunk's own resolved district. Symmetric in the pair sense: chunk A
 * counts B iff B counts A.
 */
export function countDifferingNeighbors(
  districts: ReadonlyMap<string, number>,
  cx: number,
  cz: number,
): number {
  const own = resolveDistrict(districts, cx, cz);
  let diff = 0;
  for (const [dx, dz] of NEIGHBOR_OFFSETS) {
    if (resolveDistrict(districts, cx + dx, cz + dz) !== own) diff++;
  }
  return diff;
}

/**
 * Blend weight for a chunk with `differingNeighbors` differing 4-neighbours:
 * fraction of differing neighbours scaled by BLEED_GAIN. Interior chunks
 * (0 differing) get weight 0 → exact palette.
 */
export function borderBlendWeight(differingNeighbors: number): number {
  return (Math.min(4, Math.max(0, differingNeighbors)) / 4) * BLEED_GAIN;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Tint of one chunk: exact own-palette colour for interiors; otherwise the
 * own colour blended toward the average colour of the differing neighbours
 * by borderBlendWeight. Deterministic pure function of its inputs.
 */
export function districtTint(
  palette: DistrictPalette,
  districts: ReadonlyMap<string, number>,
  cx: number,
  cz: number,
): RGB {
  const own = resolveDistrict(districts, cx, cz);
  const ownColor = resolveColor(palette, own);
  const differing: RGB[] = [];
  for (const [dx, dz] of NEIGHBOR_OFFSETS) {
    const nd = resolveDistrict(districts, cx + dx, cz + dz);
    if (nd !== own) differing.push(resolveColor(palette, nd));
  }
  if (differing.length === 0) return ownColor;
  const avg = differing.reduce(
    (acc, c) => ({ r: acc.r + c.r / differing.length, g: acc.g + c.g / differing.length, b: acc.b + c.b / differing.length }),
    { r: 0, g: 0, b: 0 },
  );
  const w = borderBlendWeight(differing.length);
  return {
    r: lerp(ownColor.r, avg.r, w),
    g: lerp(ownColor.g, avg.g, w),
    b: lerp(ownColor.b, avg.b, w),
  };
}

/** Stateless per-frame query surface over one palette + district map. */
export interface DistrictBleeder {
  /** Blended tint of the chunk containing this query. */
  tintAt(cx: number, cz: number): RGB;
  /** Differing-neighbour count of the chunk (border-strength probe). */
  borderStrengthAt(cx: number, cz: number): number;
}

/**
 * Build a district-bleed query over fixed inputs. Pure data in, pure
 * tints out; one instance can serve the whole frame loop.
 */
export function createDistrictBleeder(
  palette: DistrictPalette,
  districts: ReadonlyMap<string, number>,
): DistrictBleeder {
  return {
    tintAt(cx: number, cz: number): RGB {
      return districtTint(palette, districts, cx, cz);
    },
    borderStrengthAt(cx: number, cz: number): number {
      return countDifferingNeighbors(districts, cx, cz);
    },
  };
}
