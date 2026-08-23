/**
 * Placement tuning for the expanded environmental vignette set
 * (src/world/vignettes.ts).
 *
 * The vignette catalog grew from 5 to 10 micro-story scenes, so the
 * per-chunk placement probability was retuned from 0.02 to 0.03 to keep
 * individual finds rare while making the wider catalogue actually show up
 * across a playthrough (~3% of eligible chunks instead of ~2%).
 *
 * Kept in its own module so the tuning knob lives beside the expansion
 * work without touching architect.ts: vignettes.ts re-exports the chance
 * constant and consults districtEligibility() inside placeVignette.
 */

/**
 * Per-suitable-chunk probability that one vignette spawns.
 * Tuned so roughly 3 in 100 eligible open-floor chunks contain a scene.
 */
export const EXPANDED_VIGNETTE_CHANCE = 0.03;

/** Eligible districts get full weight; everything else never qualifies. */
const DISTRICT_WEIGHT: Readonly<Record<number, number>> = {
  [1]: 1.0, // OPEN_OFFICE
  [2]: 1.0, // HONEYCOMB
  [3]: 1.0, // CORRIDOR_GRID
};

/**
 * Relative spawn weight for a chunk's district (0 = never eligible).
 * Deterministic pure function of the district id.
 */
export function districtEligibility(district: number): number {
  return DISTRICT_WEIGHT[district] ?? 0;
}


