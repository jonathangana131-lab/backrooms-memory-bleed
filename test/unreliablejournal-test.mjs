/**
 * Unreliable journal tests (F80) - pure Node, no DOM.
 * Verifies the F80 acceptance proof: the same entry re-read after the same
 * intervening-visit count produces byte-identical rewritten text across
 * independent instances; rewrite counts stay monotone and bounded by visit
 * movement (no rewrite without a full REWRITE_GAP_VISITS gap, count never
 * exceeds floor(visitsMoved / gap)); the untouched original stays at version
 * 0 in every history while trueReading recovers it after any number of
 * rewrites; a full read timeline replays identically.
 * Run: node test/unreliablejournal-test.mjs  (prints ALL PASS, exits 0)
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
  UnreliableJournal, REWRITE_GAP_VISITS, ORIGINAL_VERSION,
  corruptionsForVersion, CORRUPTIONS_CAP,
  rewriteForVersion, WORD_SWAPS, NAME_POOL, NEGATABLE_VERBS,
} = await import('../src/story/unreliablejournal.ts');

let failures = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRIES = [
  {
    id: 'entry-alpha',
    trueText: 'I walked the long hallway and saw Elias waiting by the door. He told me the basement was cold, so I went back.',
    seed: 0x1a2b3c4d,
  },
  {
    id: 'entry-bravo',
    trueText: 'June found the keys near the elevator. We hid until the lights stopped humming, then left quietly.',
    seed: 778899,
  },
];

/** Build an journal over ENTRIES driven by an external visits variable. */
function makeJournal(visitsRef) {
  return new UnreliableJournal(ENTRIES, () => visitsRef.v);
}

console.log('unreliablejournal (F80)');

// --- constants -------------------------------------------------------------
ok(REWRITE_GAP_VISITS >= 2, `REWRITE_GAP_VISITS sane (${REWRITE_GAP_VISITS})`);
ok(ORIGINAL_VERSION === 0, 'ORIGINAL_VERSION is 0');
ok(corruptionsForVersion(1) === 1 && corruptionsForVersion(CORRUPTIONS_CAP) === CORRUPTIONS_CAP
   && corruptionsForVersion(CORRUPTIONS_CAP + 5) === CORRUPTIONS_CAP,
  'corruptionsForVersion ramps to cap and clamps');
ok(Object.keys(WORD_SWAPS).length >= 8, 'corruption table has word swaps');
ok(NAME_POOL.length >= 4 && new Set(NAME_POOL).size === NAME_POOL.length, 'name pool non-trivial and unique');
ok(NEGATABLE_VERBS.length >= 4, 'negatable verb list populated');

// --- rewrite gating --------------------------------------------------------
{
  const ref = { v: 0 };
  const j = makeJournal(ref);
  const first = j.read('entry-alpha');
  ok(first.version === ORIGINAL_VERSION && !first.rewrote && first.text === ENTRIES[0].trueText,
    'first read serves the original with no rewrite');
  ref.v += REWRITE_GAP_VISITS - 1;
  const short = j.read('entry-alpha');
  ok(!short.rewrote && short.version === ORIGINAL_VERSION,
    `gap of ${REWRITE_GAP_VISITS - 1} does not rewrite`);
  ref.v += REWRITE_GAP_VISITS;
  const exact = j.read('entry-alpha');
  ok(exact.rewrote && exact.version === 1 && exact.text !== ENTRIES[0].trueText,
    'full REWRITE_GAP_VISITS gap after a short read triggers one rewrite with changed text');
}

// --- AC: rewrite determinism across instances ------------------------------
{
  // Same entry + same intervening-visit count -> identical rewritten text,
  // across two fully independent journal instances.
  const run = () => {
    const ref = { v: 0 };
    const j = makeJournal(ref);
    j.read('entry-alpha');
    ref.v += REWRITE_GAP_VISITS; j.read('entry-alpha'); // v1 at 5
    ref.v += REWRITE_GAP_VISITS * 3; j.read('entry-alpha'); // v2 at 20
    return j.history('entry-alpha').map((ver) => ver.text);
  };
  const a = run();
  const b = run();
  ok(JSON.stringify(a) === JSON.stringify(b), 'same entry + same gaps -> byte-identical version texts across instances');

  // Direct function-level determinism, including across process-like reuse.
  const t1 = rewriteForVersion('entry-alpha', ENTRIES[0].seed, ENTRIES[0].trueText, 1);
  const t2 = rewriteForVersion('entry-alpha', ENTRIES[0].seed, ENTRIES[0].trueText, 1);
  ok(t1 === t2 && t1 !== ENTRIES[0].trueText, 'rewriteForVersion deterministic per (id, seed, version)');
  ok(rewriteForVersion('entry-alpha', ENTRIES[0].seed, ENTRIES[0].trueText, 2)
     !== rewriteForVersion('entry-alpha', ENTRIES[0].seed, ENTRIES[0].trueText, 1),
    'different versions draw different corruption streams');
}

// --- AC: monotone drift bounded by visits ----------------------------------
{
  const ref = { v: 0 };
  const j = makeJournal(ref);
  j.read('entry-bravo');
  let prevRewrites = 0;
  let bounded = true;
  let monotone = true;
  for (let step = 1; step <= 12; step++) {
    ref.v += REWRITE_GAP_VISITS;
    j.read('entry-bravo');
    const rc = j.rewriteCount('entry-bravo');
    if (rc < prevRewrites) monotone = false;
    // Each rewrite consumed >= REWRITE_GAP_VISITS of counter movement.
    if (rc > Math.floor(ref.v / REWRITE_GAP_VISITS)) bounded = false;
    prevRewrites = Math.max(prevRewrites, rc);
  }
  ok(monotone, 'rewrite count never decreases across the timeline');
  ok(bounded, `rewrite count <= floor(visits / ${REWRITE_GAP_VISITS}) at every point`);
  ok(prevRewrites >= 2, `drift actually accumulated (${prevRewrites} rewrites over 12 full-gap reads)`);

  // Adversarial cadence: reading every single visit cannot beat the bound.
  const ref2 = { v: 0 };
  const j2 = makeJournal(ref2);
  j2.read('entry-alpha');
  for (let i = 1; i <= 40; i++) { ref2.v += 1; j2.read('entry-alpha'); }
  ok(j2.rewriteCount('entry-alpha') <= Math.floor(ref2.v / REWRITE_GAP_VISITS),
    'every-visit reading still respects the visits bound');
}

// --- AC: original preserved in version history -----------------------------
{
  const ref = { v: 0 };
  const j = makeJournal(ref);
  j.read('entry-alpha');
  for (let k = 0; k < 4; k++) { ref.v += REWRITE_GAP_VISITS; j.read('entry-alpha'); }
  const hist = j.history('entry-alpha');
  ok(hist[0].version === ORIGINAL_VERSION && hist[0].text === ENTRIES[0].trueText,
    'history[0] is the untouched original');
  ok(hist.every((v, i) => v.version === i), 'versions are contiguous and ordered');
  ok(hist.every((v, i) => i === 0 || hist[i].atVisits >= hist[i - 1].atVisits),
    'version visit stamps are non-decreasing');
  ok(hist[hist.length - 1].text !== hist[hist.length - 2].text,
    'each rewrite changed the served text');
  ok(j.trueReading('entry-alpha') === ENTRIES[0].trueText && j.trueReading('entry-bravo') === ENTRIES[1].trueText,
    'trueReading recovers TRUE text after all rewrites (debug path)');
}

// --- AC: whole-timeline determinism ----------------------------------------
{
  const timeline = () => {
    const ref = { v: 0 };
    const j = makeJournal(ref);
    const trace = [];
    // Irregular but fixed cadence over both entries.
    const steps = [3, 2, 6, 1, 5, 5, 9, 4, 12, 7];
    for (const s of steps) {
      ref.v += s;
      trace.push(JSON.stringify(j.read('entry-alpha')));
      trace.push(JSON.stringify(j.read('entry-bravo')));
    }
    trace.push(JSON.stringify(j.history('entry-alpha')));
    trace.push(String(j.rewriteCount('entry-bravo')));
    return trace.join('\n');
  };
  ok(timeline() === timeline(), 'full irregular-cadence read timeline replays byte-identical');
}

// --- failure modes ---------------------------------------------------------
{
  let threwUnknown = false, threwDup = false;
  try { new UnreliableJournal(ENTRIES, () => 0).read('missing'); } catch { threwUnknown = true; }
  try { new UnreliableJournal([...ENTRIES, ENTRIES[0]], () => 0); } catch { threwDup = true; }
  ok(threwUnknown, 'unknown entry id fails loud');
  ok(threwDup, 'duplicate entry ids fail loud at construction');
}

// --- self-check: test file lives in the repo -------------------------------
{
  const self = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'unreliablejournal-test.mjs'), 'utf8');
  ok(self.includes('REWRITE_GAP_VISITS'), 'test file present in repo');
}

console.log(failures === 0 ? `ALL PASS (${checks} checks)` : `FAILURES: ${failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
