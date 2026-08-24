/**
 * Forensic storytelling (F79).
 *
 * The previous expedition's story assembled purely from scene evidence:
 * callers inject the collected evidence fragments {id, siteKey, kind,
 * payloadSeed} and this module derives everything else. Each fragment gets
 * a seeded hash-derived timestamp placing it on a reconstructed timeline;
 * the composition of fragment kinds selects an ending from a table of
 * fates; and a summary text is rendered that is byte-identical for any
 * given collected set regardless of the order pieces were found in.
 *
 * A set missing any REQUIRED_KINDS is reported with verdict 'incomplete'
 * and names the missing kinds - the timeline still renders, but the
 * expedition's fate stays unproven unless the key evidence exists.
 *
 * Pure simulation logic: no Babylon imports; all randomness flows from
 * src/core/rng.ts keyed by the run seed, so the same set + seed replays
 * byte-identically.
 */
import { hash32, hash2i, seedFromString } from '../core/rng';

/** The kinds of evidence fragments the expedition left behind. */
export type EvidenceKind =
  | 'log'
  | 'recording'
  | 'photo'
  | 'map'
  | 'marker'
  | 'belonging';

/** One piece of scene evidence injected by the collector. */
export interface EvidenceFragment {
  /** Unique stable identifier, e.g. "log-014". */
  id: string;
  /** Site key naming where the fragment was found. */
  siteKey: string;
  /** Evidence kind driving timeline flavor and fate composition. */
  kind: EvidenceKind;
  /** Seed salt personalizing this fragment's derived content. */
  payloadSeed: number;
}

/**
 * Kinds that must be present for the reconstruction to count as complete;
 * each one carries an irreplaceable strand of the chain of evidence.
 */
export const REQUIRED_KINDS: readonly EvidenceKind[] = ['log', 'recording', 'marker'];

/** One table-driven ending: first row whose minimum kind counts are met wins. */
export interface EndingRule {
  /** Short fate identifier used in reports and journal entries. */
  fate: string;
  /** Rendered fate sentence closing the summary. */
  text: string;
  /** Minimum fragment count per kind required for this fate. */
  minCounts: Partial<Record<EvidenceKind, number>>;
}

/**
 * Fate table in priority order; the final row has empty requirements and
 * always matches, standing in when the evidence is too thin to conclude.
 */
export const ENDING_TABLE: readonly EndingRule[] = [
  {
    fate: 'went-deeper',
    text: 'They marked the way down and kept recording past the point of return.',
    minCounts: { marker: 2, recording: 2 },
  },
  {
    fate: 'found-something-exit-shaped',
    text: 'Their maps and photos converge on a door none of them describe opening twice.',
    minCounts: { map: 2, photo: 2 },
  },
  {
    fate: 'scattered-and-lost',
    text: 'The belongings were found apart, each far from the last known camp.',
    minCounts: { belonging: 3 },
  },
  {
    fate: 'held-position-too-long',
    text: 'The logs continue on schedule long after the supplies should have run out.',
    minCounts: { log: 3 },
  },
  {
    fate: 'unrecorded',
    text: 'Too little survives to say what became of them.',
    minCounts: {},
  },
];

/** Reconstructed expedition span in seconds; timestamps land inside it. */
export const TIMELINE_SPAN_S = 60 * 60 * 6;

const KIND_LABEL: Record<EvidenceKind, string> = {
  log: 'field log',
  recording: 'tape recording',
  photo: 'photograph',
  map: 'map scrap',
  marker: 'waypoint marker',
  belonging: 'personal effect',
};

const KIND_FLAVOR: Record<EvidenceKind, readonly string[]> = {
  log: [
    'handwriting steady, entries timed to the minute',
    'last lines smudged as if read again and again',
    'pages tally distances that repeat every seventh hall',
    'margins full of counts: doors, tiles, breaths',
  ],
  recording: [
    'voices calm, then two speakers answering the same question',
    'background hum dips whenever a name is said',
    'a second recorder echoes this one half a beat late',
    'the last minute is room tone and nothing else',
  ],
  photo: [
    'exposure doubled, as if the light refused to settle',
    'the corridor repeats into the frame without end',
    'a figure-shaped absence stands at the edge of the flash',
    'the same corner photographed from angles that cannot coexist',
  ],
  map: [
    'ink revisions over ink, all claiming to be current',
    'a stair drawn where the surveyor swore there was none',
    'the route home is traced and traced until the paper thins',
    'annotations measure rooms larger on the way back',
  ],
  marker: [
    'chalk arrow pointing deeper, refreshed over an older one',
    'three markers within sight of each other, all saying onward',
    'a knot of radio cord tied to a pipe, frayed but deliberate',
    'the count scratched beside it does not match its neighbors',
  ],
  belonging: [
    'a name taped inside a boot, worn blind',
    'ration wrappers folded into careful squares, saved not dropped',
    'a family photograph turned face-down on purpose',
    'keys still ringed together, left in an unlocked door',
  ],
};

/**
 * Seeded reconstruction timestamp for one fragment, in [0,
 * TIMELINE_SPAN_S). Derived purely from the fragment identity + run seed
 * via src/core/rng.ts hashes, so it never depends on collection order.
 */
export function deriveTimestampS(fragment: EvidenceFragment, seed: number): number {
  const idHash = hash32(seedFromString(fragment.id));
  const kindSalt = hash32(seedFromString(fragment.kind));
  return hash2i(idHash ^ fragment.payloadSeed, kindSalt, seed >>> 0) % Math.round(TIMELINE_SPAN_S * 1000) / 1000;
}

/** Count fragments per kind; order-independent by construction. */
export function countKinds(fragments: readonly EvidenceFragment[]): Record<EvidenceKind, number> {
  const counts: Record<EvidenceKind, number> = {
    log: 0, recording: 0, photo: 0, map: 0, marker: 0, belonging: 0,
  };
  for (const fragment of fragments) counts[fragment.kind] += 1;
  return counts;
}

/**
 * First row of ENDING_TABLE whose minimum kind counts are all met.
 * The final zero-requirement row guarantees a match.
 */
export function selectEnding(counts: Record<EvidenceKind, number>): EndingRule {
  for (const rule of ENDING_TABLE) {
    let met = true;
    for (const kind of Object.keys(rule.minCounts) as EvidenceKind[]) {
      if (counts[kind] < (rule.minCounts[kind] ?? 0)) { met = false; break; }
    }
    if (met) return rule;
  }
  return ENDING_TABLE[ENDING_TABLE.length - 1];
}

/** Rendered forensic report for one collected evidence set. */
export interface StoryReport {
  /** 'complete' only when every REQUIRED_KINDS kind is present. */
  verdict: 'complete' | 'incomplete';
  /** Required kinds absent from the set, sorted, empty when complete. */
  missingKinds: EvidenceKind[];
  /** Selected fate identifier from the ending table. */
  fate: string;
  /** Rendered fate sentence. */
  fateText: string;
  /** Chronological reconstruction; ascending timestampS, id tiebreak. */
  timeline: Array<{ id: string; siteKey: string; kind: EvidenceKind; timestampS: number; line: string }>;
  /** Full rendered summary text, deterministic per set + seed. */
  summary: string;
}

/**
 * Assemble the previous expedition's story from a collected evidence set.
 * The result depends only on the SET of fragments and the seed - never on
 * their order - because timestamps are derived per fragment and the
 * timeline is totally ordered by (timestampS, id). Same inputs produce
 * byte-identical output.
 */
export function assembleStory(
  fragments: readonly EvidenceFragment[],
  seed: number,
): StoryReport {
  const s = seed >>> 0;
  const counts = countKinds(fragments);
  const missingKinds = REQUIRED_KINDS.filter((kind) => counts[kind] === 0);
  const verdict = missingKinds.length === 0 ? 'complete' : 'incomplete';
  const ending = selectEnding(counts);

  const timeline = [...fragments]
    .map((fragment) => ({
      id: fragment.id,
      siteKey: fragment.siteKey,
      kind: fragment.kind,
      timestampS: deriveTimestampS(fragment, s),
      line: renderLine(fragment, s),
    }))
    .sort((p, q) => p.timestampS - q.timestampS || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  const header = `RECONSTRUCTION ${verdict.toUpperCase()} - ${fragments.length} fragments recovered`;
  const missingLine = missingKinds.length > 0
    ? `missing key evidence: ${missingKinds.join(', ')}`
    : 'evidence chain intact';
  const body = timeline.map(
    (entry) => `t+${formatTimestamp(entry.timestampS)} [${entry.siteKey}] ${entry.line}`,
  );
  const summary = [header, missingLine, ...body, `FATE: ${ending.fate} - ${ending.text}`].join('\n');

  return { verdict, missingKinds, fate: ending.fate, fateText: ending.text, timeline, summary };
}

// ---------------------------------------------------------------------------

/** One evidence-flavored timeline line, seeded per fragment. */
function renderLine(fragment: EvidenceFragment, seed: number): string {
  const flavors = KIND_FLAVOR[fragment.kind];
  const pick = hash32(seedFromString(fragment.id) ^ fragment.payloadSeed ^ seed) % flavors.length;
  return `${KIND_LABEL[fragment.kind]} #${fragment.id}: ${flavors[pick]}`;
}

/** Zero-padded mm:ss rendering of a timeline offset. */
function formatTimestamp(timestampS: number): string {
  const totalSeconds = Math.floor(timestampS);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(3, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
