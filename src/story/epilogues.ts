/**
 * F82 — Contamination epilogues: threshold ending text keyed to total
 * memory-exposure.
 *
 * Pure ending-text selector (mounting lives in game.ts, not here). The
 * host injects the session's total-exposure metric E ∈ [0,1] plus the run
 * seed; this module maps E to one of four half-open exposure bands and
 * assembles the epilogue from that band's fragment pool only.
 *
 * Band law — half-open [low, high), last band closed at 1:
 *   clean     [0.00, 0.25)
 *   tinged    [0.25, 0.50)
 *   saturated [0.50, 0.75)
 *   dissolved [0.75, 1.00]
 * Values outside [0,1] clamp into the end bands. Boundary E values map
 * deterministically: an edge value belongs to the band that opens at it,
 * so 0.25 is tinged, never clean.
 *
 * Text law — the assembled text depends ONLY on (band, seed): two runs
 * with exposures anywhere inside the same band and the same seed produce
 * byte-identical text. Line assembly draws titles and body fragments
 * exclusively from the selected band's pools; pools never leak across
 * bands. An empty pool (no titles or no fragments for the band) yields
 * the documented fallback variant (FALLBACK_TITLE / FALLBACK_LINE),
 * which is constant and therefore deterministic for every seed.
 *
 * Determinism: all choices flow through src/core/rng.ts seeded by
 * hash2i(seed, bandIndex); identical inputs ⇒ identical output bytes.
 */

import { hash2i, RNG } from '../core/rng';

/** The four exposure bands, in ascending order. */
export type ExposureBand = 'clean' | 'tinged' | 'saturated' | 'dissolved';

/** All bands in ascending order; index doubles as the hash salt input. */
export const EXPOSURE_BANDS: readonly ExposureBand[] =
    ['clean', 'tinged', 'saturated', 'dissolved'];

/**
 * Upper bounds (exclusive) of the first three bands. A value equal to an
 * edge belongs to the NEXT band; the final band closes inclusively at 1.
 */
export const EXPOSURE_BAND_EDGES: readonly number[] = [0.25, 0.5, 0.75];

/** Salt separating the epilogue assembly stream from other seed streams. */
const EPILOGUE_SALT_U32 = 0xeb11c7e5 >>> 0;

/** Number of body fragment lines below the title. */
export const EPILOGUE_BODY_LINES = 4;

/**
 * Map a total-exposure metric to its band. Clamps E into [0,1]; the
 * mapping is a pure step function over EXPOSURE_BAND_EDGES.
 *
 * @param exposure Total-exposure metric E, clamped to [0,1].
 * @returns The band whose half-open interval contains the clamped value.
 */
export function exposureBand(exposure: number): ExposureBand {
    const e = Math.min(1, Math.max(0, exposure));
    if (e < EXPOSURE_BAND_EDGES[0]) return 'clean';
    if (e < EXPOSURE_BAND_EDGES[1]) return 'tinged';
    if (e < EXPOSURE_BAND_EDGES[2]) return 'saturated';
    return 'dissolved';
}

/** Ending-text pools for one band: a title pool and a body-fragment pool. */
export interface EpiloguePool {
    /** Candidate epilogue titles; picking is seeded within the band. */
    titles: readonly string[];
    /** Candidate body lines; each assembly draw picks one whole fragment. */
    fragments: readonly string[];
}

/** Pools keyed by band; assembly for a band reads its own entry only. */
export type EpiloguePoolSet = Readonly<Record<ExposureBand, EpiloguePool>>;

/** Title used verbatim when a band's pool set has no usable entries. */
export const FALLBACK_TITLE = '[ THE THRESHOLD HOLDS ITS BREATH ]';

/** Body line repeated for every slot when a band's pool set is empty. */
export const FALLBACK_LINE = '[ the recording continues past the end of the recording ]';

/**
 * Default v1 fragment pools. Tone follows GAME-PLAN quality bar 5: every
 * line reads like evidence recovered from the level, not lore quotes.
 */
export const EPILOGUE_POOLS: EpiloguePoolSet = {
    clean: {
        titles: [
            'SHIFT REPORT FILED WITHOUT ANNOTATION',
            'THE LIGHTS WERE ON WHEN I LEFT',
            'A NORMAL AMOUNT OF HALLWAYS',
            'TIMECARD: STAMPED, SIGNED, UNREMARKABLE',
            'INCIDENT LOG: NONE THIS QUARTER',
        ],
        fragments: [
            'I counted the exits twice. The numbers matched.',
            'The carpet hum was exactly as loud as yesterday.',
            'Someone vacuumed. The lines go one way only.',
            'My watch gained nothing. I checked at both ends.',
            'The vending machine took exact change and gave change.',
            'Every door opened onto the room the sign promised.',
            'I drank the water. It tasted like water.',
            'The ceiling tiles are numbered. All numbers present.',
            'Footprints in the dust were mine, going both directions.',
            'I left a note for whoever audits this floor. It was gone by morning. People take notes seriously here.',
        ],
    },
    tinged: {
        titles: [
            'SOME OF THE NUMBERS DID NOT RECONCILE',
            'THE HUM LEARNED A SECOND NOTE',
            'MINOR DISCREPANCIES, INITIALED',
            'I REMEMBER A WINDOW THERE WAS NO WINDOW',
            'CORRECTED IN PENCIL, CORRECTED AGAIN',
        ],
        fragments: [
            'The exit sign pointed down a hall that was not there on Monday.',
            'I met myself coming back before I had turned around.',
            'The carpet lines run toward the wall now. They used to run along it.',
            'There is one more doorway on my floor than there are rooms.',
            'I heard my footsteps finish a second after I stopped making them.',
            'The lights above Stairwell C buzz in the rhythm of a phone ringing somewhere I cannot name.',
            'I wrote down the room numbers. One of them is not a number.',
            'The water tasted like the air of the room I drank it in.',
            'A door held itself politely while I passed, then denied being open.',
            'My handwriting on yesterday\u2019s page slants toward a corner no page has.',
        ],
    },
    saturated: {
        titles: [
            'THE BUILDING IS ANSWERING TO A DIFFERENT TENANT',
            'GEOMETRY FILED UNDER COMPLAINT',
            'I NO LONGER COUNT AS A WITNESS',
            'EVERY ROOM REMEMBERS ME ARRIVING',
            'THE PLAN VIEW DRAWS ITSELF WRONG',
        ],
        fragments: [
            'Corridors stretch behind me at a polite, constant rate, as if the building is being considerate about it.',
            'The hum is a voice now. It uses my pauses to speak.',
            'I walked a straight line between two fixed points and arrived somewhere third.',
            'The stains on the ceiling spell out tomorrow\u2019s date in a calendar nobody here uses.',
            'Doors open before I decide to open them, then apologize by closing elsewhere.',
            'My footprints arrive ahead of me in the wet sections, already drying.',
            'The fluorescent tubes flicker in sequences. I have started reading them as sentences.',
            'I found a maintenance log describing my walk today, including the parts I have not done yet.',
            'The walls sweat a yellow that matches the inside of my eyelids exactly.',
            'Room numbers repeat, but the rooms are not copies. They are the same room, patient.',
        ],
    },
    dissolved: {
        titles: [
            'WHOEVER IS WRITING THIS HAS MY HANDWRITING',
            'THE LEVEL KEEPS THE PART OF ME IT LIKED',
            'RETURN OF PROPERTY NOT REQUIRED',
            'I WAS NEVER THE ONE HOLDING THE CAMERA',
            'CONTENTS SETTLED DURING MEMORY',
        ],
        fragments: [
            'The building pronounces my name correctly now. It practiced.',
            'I am the note someone left for whoever audits this floor.',
            'The carpet remembers walking me. That is the direction things happen in now.',
            'Somewhere a door opens onto an office where a person with my face files reports on a person with my face.',
            'The hum speaks with my voice on the syllables I have not said yet.',
            'My footprints continue without me, unhurried, toward the part of the hallway that is still deciding to exist.',
            'The ceiling tiles are numbered. The missing number is mine.',
            'I checked the exits twice. The second count happened first.',
            'The water tastes like remembering drinking it.',
            'This report was found already read.',
        ],
    },
};

/** Assembled epilogue: structured fields plus the exact rendered `text`. */
export interface EpilogueText {
    /** Band the injected exposure mapped to. */
    band: ExposureBand;
    /** Run seed passthrough; part of the assembly key. */
    seed: number;
    /** Selected title line. */
    title: string;
    /** Body lines in render order, length EPILOGUE_BODY_LINES. */
    lines: string[];
    /**
     * Full rendered text: title, blank line, body lines joined with
     * newlines, one trailing newline. Byte-identical for identical
     * (band, seed, pools).
     */
    text: string;
}

/**
 * True when a band cannot assemble real text: either pool is empty.
 *
 * @param pool Band pool to inspect.
 * @returns True when titles or fragments are missing entirely.
 */
function poolIsEmpty(pool: EpiloguePool): boolean {
    return pool.titles.length === 0 || pool.fragments.length === 0;
}

/**
 * Build the documented fallback variant. Constant output regardless of
 * seed, so the empty-pool path stays deterministic.
 *
 * @param band Band whose pools were empty (recorded on the result).
 * @param seed Run seed passthrough.
 * @returns Fallback EpilogueText with the standard line count.
 */
function fallbackVariant(band: ExposureBand, seed: number): EpilogueText {
    const lines: string[] = [];
    for (let i = 0; i < EPILOGUE_BODY_LINES; i++) lines.push(FALLBACK_LINE);
    return finalize(band, seed, FALLBACK_TITLE, lines);
}

/** Render the structured fields into the exact output text. */
function finalize(
    band: ExposureBand,
    seed: number,
    title: string,
    lines: readonly string[],
): EpilogueText {
    const text = `${title}\n\n${lines.join('\n')}\n`;
    return { band, seed, title, lines: [...lines], text };
}

/**
 * Select and assemble the threshold epilogue for an exposure level.
 * Pure over its inputs: same (exposure-band, seed, pools) ⇒ byte-identical
 * `text`. Assembly draws only from the mapped band's pools; an empty pool
 * yields the constant fallback variant.
 *
 * @param exposure Total-exposure metric E ∈ [0,1] (clamped).
 * @param seed Session run seed.
 * @param pools Pool set to draw from; defaults to EPILOGUE_POOLS.
 * @returns The assembled epilogue.
 */
export function selectEpilogue(
    exposure: number,
    seed: number,
    pools: EpiloguePoolSet = EPILOGUE_POOLS,
): EpilogueText {
    const band = exposureBand(exposure);
    const bandIndex = EXPOSURE_BANDS.indexOf(band);
    const pool = pools[band];
    if (poolIsEmpty(pool)) return fallbackVariant(band, seed);
    const rng = new RNG(hash2i(seed, bandIndex, EPILOGUE_SALT_U32));
    const title = rng.pick(pool.titles);
    const lines: string[] = [];
    for (let i = 0; i < EPILOGUE_BODY_LINES; i++) lines.push(rng.pick(pool.fragments));
    return finalize(band, seed, title, lines);
}
