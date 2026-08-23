/**
 * Fan placement variety: context-aware fan style selection.
 *
 * Every ceiling fan used to be stamped from the same die - four flat
 * blades, one dull-metal hub - regardless of what kind of room it hung
 * in. This module layers deterministic variety on top of placement:
 * each chunk's room context decides WHICH KIND of fan hangs there, how
 * many blades it has, how wide its sweep is, and which way it turns.
 *
 * Contexts (room-type families):
 *   office   - standard commercial 4-blade, modest sweep
 *   medical  - 3-blade hospital paddle, long clean sweep
 *   storage  - large industrial 6-blade, HVLS-style slow monster
 *   chapel   - ornate decorative, extra blades for silhouette detail
 *
 * Selection is pure hashing (salted so fan-style rolls never correlate
 * with any other hashed world feature): hash(cx, cz, context) picks the
 * blade count within the family, the rotation direction (~half the fans
 * spin counterclockwise), and a small sweep-size jitter of +/-8%, so
 * regenerating the same chunk always reproduces identical fans.
 *
 * Pure logic - no engine dependencies. The mesh builder consumes the
 * returned FanSpec when assembling geometry (see ceilingfan.ts).
 */
import { hash2i, rand2 } from '../core/rng';

/** Salt so fan-placement hashes never correlate with other hashed features. */
const FAN_PLACEMENT_SALT = 0xf4ce;

/** Independent sub-salts for the per-fan rolls (blades / dir / size). */
const BLADE_SALT = FAN_PLACEMENT_SALT ^ 0xb1ad;
const DIR_SALT = FAN_PLACEMENT_SALT ^ 0x00d1;
const SIZE_SALT = FAN_PLACEMENT_SALT ^ 0x51de;

/** Room contexts that host fans. */
export type FanContext = 'office' | 'medical' | 'storage' | 'chapel';

/** All valid contexts, for validation and iteration. */
export const FAN_CONTEXTS: readonly FanContext[] = ['office', 'medical', 'storage', 'chapel'];

/**
 * Static description of one context's fan family.
 * bladeCounts lists every blade tally the hash may pick from; the first
 * entry is the family standard.
 */
interface FamilyDef {
  /** Candidate blade tallies, hashed pick per chunk. */
  bladeCounts: number[];
  /** Nominal full-sweep diameter in meters (before jitter). */
  baseSizeM: number;
}

/* ------------------------------------------------------------------ */
/* Family tables                                                       */
/* ------------------------------------------------------------------ */

/** Standard commercial 4-blade - the familiar office hummer. */
const OFFICE_FAMILY: FamilyDef = {
  bladeCounts: [4],
  baseSizeM: 1.32,
};

/** Hospital paddle - three long quiet blades, easy to sterilize. */
const MEDICAL_FAMILY: FamilyDef = {
  bladeCounts: [3],
  baseSizeM: 1.52,
};

/** Industrial HVLS - six broad blades moving serious air. */
const STORAGE_FAMILY: FamilyDef = {
  bladeCounts: [6],
  baseSizeM: 2.40,
};

/** Ornate decorative - extra blades for a dense, formal silhouette. */
const CHAPEL_FAMILY: FamilyDef = {
  bladeCounts: [5, 6, 8],
  baseSizeM: 1.80,
};

const FAMILIES: Readonly<Record<FanContext, FamilyDef>> = {
  office: OFFICE_FAMILY,
  medical: MEDICAL_FAMILY,
  storage: STORAGE_FAMILY,
  chapel: CHAPEL_FAMILY,
};

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


