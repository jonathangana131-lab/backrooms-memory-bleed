/**
 * Forensic storytelling tests (F79) - pure Node, no browser.
 * Verifies the F79 acceptance proof: evidence fragments carry
 * {id, siteKey, kind, payloadSeed}; timeline timestamps are seeded-hash
 * derived and order-independent; fate selection is table-driven from kind
 * composition; the rendered summary is byte-identical for a given
 * collected set regardless of collection order; a set missing any required
 * kind reports verdict 'incomplete' with the documented missing kinds; and
 * everything replays byte-identically per seed with no unseeded randomness.
 * Run: node test/forensics-test.mjs  (prints ALL PASS, exits 0)
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const {
  REQUIRED_KINDS, ENDING_TABLE, TIMELINE_SPAN_S,
  deriveTimestampS, countKinds, selectEnding, assembleStory,
} = await import('../src/story/forensics.ts');
const { RNG } = await import('../src/core/rng.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Build one fragment. */
function frag(id, siteKey, kind, payloadSeed) {
  return { id, siteKey, kind, payloadSeed };
}

/** Seeded evidence set spanning every kind, drawn via src/core/rng.ts. */
function seededSet(seed) {
  const rng = new RNG(seed);
  const kinds = ['log', 'recording', 'photo', 'map', 'marker', 'belonging'];
  const sites = ['loading-dock', 'poolrooms', 'level-9-lobby', 'boiler-core'];
  const fragments = [];
  const n = Math.floor(rng.range(8, 16));
  for (let i = 0; i < n; i++) {
    fragments.push(frag(
      `f-${String(i).padStart(2, '0')}`,
      sites[Math.floor(rng.range(0, sites.length))],
      kinds[Math.floor(rng.range(0, kinds.length))],
      Math.floor(rng.range(0, 0xffffffff)),
    ));
  }
  return fragments;
}

// --- 1. fragment shape and derived timeline -------------------------------------
console.log('[timeline]');
{
  const seed = 4242;
  const f = frag('log-014', 'poolrooms', 'log', 12345);
  ok(typeof deriveTimestampS(f, seed) === 'number'
     && deriveTimestampS(f, seed) >= 0
     && deriveTimestampS(f, seed) < TIMELINE_SPAN_S,
    `derived timestamp lands in [0, TIMELINE_SPAN_S=${TIMELINE_SPAN_S})`);

  ok(deriveTimestampS(frag('x', 's', 'map', 1), seed)
     !== deriveTimestampS(frag('y', 's', 'map', 1), seed),
    'distinct ids derive distinct timestamps');
  ok(deriveTimestampS(frag('z', 's', 'map', 7), seed)
     !== deriveTimestampS(frag('z', 's', 'map', 8), seed),
    'payloadSeed perturbs the derived timestamp');

  // order-independence at the unit level
  ok(deriveTimestampS(f, seed) === deriveTimestampS({ ...f }, seed),
    'timestamp is a pure function of fragment identity + seed');

  const set = seededSet(seed);
  const report = assembleStory(set, seed);
  const stamps = report.timeline.map((e) => e.timestampS);
  let ascending = true;
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] < stamps[i - 1]
        || (stamps[i] === stamps[i - 1] && report.timeline[i].id <= report.timeline[i - 1].id)) ascending = false;
  }
  ok(report.timeline.length === set.length && ascending,
    `reconstructed timeline of ${report.timeline.length} entries sorts by (timestampS, id)`);

  const counts = countKinds(set);
  ok(Object.values(counts).reduce((a, b) => a + b, 0) === set.length,
    'countKinds partitions the whole collected set');
}

// --- 2. table-driven fate composition --------------------------------------------
console.log('[fate]');
{
  ok(ENDING_TABLE[ENDING_TABLE.length - 1]
     && Object.keys(ENDING_TABLE[ENDING_TABLE.length - 1].minCounts).length === 0,
    'ending table closes with an always-matching fallback row');

  const base = [frag('l1', 's', 'log', 1), frag('r1', 's', 'recording', 1)];
  ok(selectEnding(countKinds(base)).fate === ENDING_TABLE[ENDING_TABLE.length - 1].fate,
    'thin evidence falls through to the unrecorded fallback');

  ok(selectEnding(countKinds([...base, frag('g1', 's', 'map', 1), frag('g2', 's', 'map', 2),
    frag('p1', 's', 'photo', 1), frag('p2', 's', 'photo', 2)])).fate === 'found-something-exit-shaped',
    'map+photo composition selects its table row');

  ok(selectEnding(countKinds([frag('m1', 's', 'marker', 1), frag('m2', 's', 'marker', 2),
    ...Array.from({ length: 3 }, (_, i) => frag(`rr${i}`, 's', 'recording', i))])).fate === 'went-deeper',
    'first matching row wins in priority order (went-deeper beats exit-shaped)');

  // fate depends only on kind composition, never on payloadSeeds or ids
  const a = assembleStory([
    frag('l1', 's', 'log', 100), frag('r1', 's', 'recording', 200), frag('r2', 's', 'recording', 300),
    frag('m1', 's', 'marker', 400), frag('m2', 's', 'marker', 500),
  ], 9).fate;
  const b = assembleStory([
    frag('other-log', 'elsewhere', 'log', 999), frag('x', 'q', 'recording', 1),
    frag('y', 'q', 'recording', 2), frag('z', 'q', 'marker', 3), frag('w', 'q', 'marker', 4),
  ], 7777).fate;
  ok(a === b && a !== ENDING_TABLE[ENDING_TABLE.length - 1].fate,
    `same kind composition -> same fate '${a}' across totally different payloads`);
}

// --- 3. byte-identical summary regardless of collection order --------------------
console.log('[order independence]');
{
  let all = true;
  for (let trial = 0; trial < 6; trial++) {
    const seed = 500 + trial;
    const set = seededSet(seed);
    const canonical = assembleStory(set, seed).summary;

    // shuffle deterministically several ways
    for (let pass = 0; pass < 4; pass++) {
      const rng = new RNG(seed * 31 + pass);
      const shuffled = [...set];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng.range(0, i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      if (assembleStory(shuffled, seed).summary !== canonical) all = false;
    }
    // reversed collection order too
    if (assembleStory([...set].reverse(), seed).summary !== canonical) all = false;
  }
  ok(all, 'summary byte-identical across 6 seeds x 6 collection orders (incl. reversal)');
}

// --- 4. incomplete verdict --------------------------------------------------------
console.log('[incomplete verdict]');
{
  const full = [
    frag('l1', 's', 'log', 1), frag('r1', 's', 'recording', 1), frag('m1', 's', 'marker', 1),
    frag('p1', 's', 'photo', 1),
  ];
  ok(assembleStory(full, 3).verdict === 'complete'
     && assembleStory(full, 3).missingKinds.length === 0,
    'set containing every REQUIRED_KINDS kind reports complete');

  const partial = [frag('l1', 's', 'log', 1), frag('p1', 's', 'photo', 1)];
  const r = assembleStory(partial, 3);
  const expectedMissing = REQUIRED_KINDS.filter((k) => k !== 'log').sort();
  ok(r.verdict === 'incomplete', "missing key kinds -> verdict 'incomplete'");
  ok(JSON.stringify(r.missingKinds.slice().sort()) === JSON.stringify(expectedMissing),
     `missing kinds listed exactly (${r.missingKinds.join(', ')})`);
  ok(r.summary.includes('incomplete') || r.summary.includes('INCOMPLETE')
     && r.summary.includes('missing'),
    'rendered summary documents the missing key evidence');

  // still renders the timeline even when incomplete
  ok(r.timeline.length === partial.length && r.fate.length > 0,
    'incomplete reports still render a full timeline and a fallback fate');

  ok(assembleStory([], 3).verdict === 'incomplete',
    'the empty set is the degenerate incomplete case');
}

// --- 5. determinism per seed -------------------------------------------------------
console.log('[determinism]');
{
  const run = (seed) => JSON.stringify(assembleStory(seededSet(seed), seed));
  ok(run(8080) === run(8080), 'same set + same seed -> byte-identical report');
  ok(run(8080) !== run(8081), 'different seeds decorrelate the reconstruction');

  const seed = 909;
  ok(JSON.stringify(assembleStory(seededSet(seed), seed))
     === JSON.stringify(assembleStory(seededSet(seed), seed)),
    'full structured report (not just summary) replays identically');

  ok(!readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'story', 'forensics.ts'), 'utf8').includes('Math.random'),
    'module contains no unseeded randomness at all');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
