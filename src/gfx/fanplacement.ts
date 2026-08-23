import { hash2i, rand2 } from '../core/rng';

/** Room families that host ceiling fans. */
export type FanContext = 'office' | 'medical' | 'storage' | 'chapel';

/** All fan contexts, in table order. */
export const FAN_CONTEXTS: readonly FanContext[] = ['office', 'medical', 'storage', 'chapel'];

/** Blade-count menu and base sweep diameter for one room family. */
interface FamilyDef {
  bladeCounts: number[];
  baseSizeM: number;
}

/** Per-family standards: office uniform, chapel a real mix of big blades. */
const FAMILIES: Record<FanContext, FamilyDef> = {
  office:  { bladeCounts: [4],       baseSizeM: 1.32 },
  medical: { bladeCounts: [3],       baseSizeM: 1.52 },
  storage: { bladeCounts: [6],       baseSizeM: 2.40 },
  chapel:  { bladeCounts: [5, 6, 8], baseSizeM: 1.80 },
};

/** Independent lottery salt per concern so decisions never correlate. */
const BLADE_SALT = 0xb1ad;
const DIR_SALT = 0xd121;
const SIZE_SALT = 0x51e7;

/** Relative sweep jitter applied per fan (+/-8% of the family base). */
const SIZE_JITTER = 0.08;

/** Full spec of one placed fan, consumed by the mesh builder. */
export interface FanSpec {
  /** Number of blades bolted to the hub. */
  bladeCount: number;
  /** Spin sign about local Y: +1 clockwise (viewed from below), -1 counter. */
  rotationDir: 1 | -1;
  /** Full blade-disc sweep diameter in meters. */
  sizeM: number;
  /** Which visual style the builder should assemble. */
  style: FanContext;
}

/**
 * Validate a context string strictly so wiring typos fail loudly.
 * Throws TypeError for anything outside FAN_CONTEXTS.
 */
function familyFor(context: string): FamilyDef {
  const fam = (FAMILIES as Record<string, FamilyDef | undefined>)[context];
  if (!fam || !FAN_CONTEXTS.includes(context as FanContext)) {
    throw new TypeError('fanplacement.getFanSpec: unknown context "' + String(context) + '"');
  }
  return fam;
}

/**
 * Deterministic fan spec for chunk (cx, cz) in room 'context'.
 *
 * Same inputs always yield the exact same spec - any chunk can be
 * regenerated identically at any time, in any order. Roughly half of
 * all fans spin counterclockwise (rotationDir === -1).
 *
 * @param cx      chunk X coordinate
 * @param cz      chunk Z coordinate
 * @param context room-type key ('office' | 'medical' | 'storage' | 'chapel')
 */
export function getFanSpec(cx: number, cz: number, context: FanContext | string): FanSpec {
  const fam = familyFor(context);

  // One combined roll per concern, keyed by (chunk, roomType) so the
  // blade/dir/size decisions are independent of one another yet stable.
  const bladeH = hash2i(cx, cz, BLADE_SALT);
  const dirH = hash2i(cx, cz, DIR_SALT);
  const sizeR = rand2(cx, cz, SIZE_SALT);

  const idx = bladeH % fam.bladeCounts.length;
  const bladeCount = fam.bladeCounts[idx];
  const rotationDir: 1 | -1 = (dirH & 1) === 0 ? 1 : -1;

  // Soft mid-weighted spread: remap the uniform into +/-SIZE_JITTER.
  const jitter = (sizeR - 0.5) * 2 * SIZE_JITTER;
  const sizeM = Number((fam.baseSizeM * (1 + jitter)).toFixed(4));

  return { bladeCount, rotationDir, sizeM, style: context as FanContext };
}


