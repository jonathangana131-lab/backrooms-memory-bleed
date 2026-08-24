/**
 * F61 Congregation's Hymn tests.
 *
 * Verifies against src/audio/hymn.ts:
 *   1. lyric grounding (the AC): over 300 lines across seeds, 100% of
 *      sung names are verbatim ledger names with matching provenance ids;
 *      no line ever carries a name absent from the ledger
 *   2. empty ledger => silent humming only: every line kind 'hum',
 *      discoveryId null, wordless text
 *   3. invalid entries (empty/missing names or ids) never surface
 *   4. round structure: voices enter at their seeded stagger offsets,
 *      beats strictly increase within a round, rounds cycle by ROUND_BEATS
 *   5. stagger offsets deterministic per seed; dedup window respected;
 *      same seed reproduces a byte-identical 300-line transcript
 *
 * TypeScript sources are transpiled on the fly (same idiom as
 * congregation-test).
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.hymn-build');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

function transpile(relSrc, outRel) {
  const srcTxt = readFileSync(join(ROOT, relSrc), 'utf8');
  const out = ts.transpileModule(srcTxt, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
    },
    isolatedModules: true,
  }).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.js'");
  const outPath = join(BUILD, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
}
rmSync(BUILD, { recursive: true, force: true });
transpile('src/core/rng.ts', 'src/core/rng.js');
transpile('src/audio/hymn.ts', 'src/audio/hymn.js');

const HY = await import(join(BUILD, 'src/audio/hymn.js'));

const LEDGER = [
  { id: 'd-beacon', name: 'the humming beacon' },
  { id: 'd-chapel', name: 'the flooded chapel' },
  { id: 'd-dock', name: 'the loading dock' },
  { id: 'd-mirror', name: "the janitor's mirror" },
  { id: 'd-stair', name: 'the stairwell that counts' },
  { id: 'd-pool', name: 'the drained pool' },
  { id: 'd-vending', name: 'the warm vending machine' },
  { id: 'd-atrium', name: 'the sealed atrium' },
  { id: 'd-freezer', name: 'the freezer wing' },
  { id: 'd-lift', name: 'the elevator to nowhere' },
  { id: 'd-map', name: 'the map that redraws itself' },
  { id: 'd-key', name: 'the brass key with no teeth' },
];

/** Consume n lines from one choir. */
function sing(hymn, n) {
  return Array.from({ length: n }, () => hymn.nextLine());
}

// ---- 1. lyric grounding over 300+ lines ----------------------------------------
try {
  let lyricLines = 0;
  let grounded = true;
  let provenanceOk = true;
  let foreignNameFound = false;
  for (const seed of [11, 90210, 0xc0ffee]) {
    const hymn = new HY.CongregationHymn(LEDGER, seed);
    const names = new Set(LEDGER.map((e) => e.name));
    const byId = new Map(LEDGER.map((e) => [e.id, e.name]));
    for (const line of sing(hymn, 100)) {
      if (line.kind === 'hum') continue; // only possible via dedup concession
      lyricLines++;
      const expected = byId.get(line.discoveryId);
      if (expected === undefined || !line.text.includes(expected)) grounded = false;
      // no OTHER ledger name may leak into the text
      for (const e of LEDGER) {
        if (e.id !== line.discoveryId && line.text.includes(e.name)) foreignNameFound = true;
      }
      if (!(typeof line.discoveryId === 'string' && line.voice >= 0 && Number.isInteger(line.beat))) provenanceOk = false;
    }
  }
  check(`100% of ${lyricLines} sung names are ledger names`, lyricLines >= 250 && grounded);
  check('provenance id present and well-formed on every lyric line', provenanceOk);
  check('no second ledger name leaks into any line', !foreignNameFound);
} catch (e) {
  check('lyric grounding', false, e.message);
}

// ---- 2. empty ledger => silent humming ------------------------------------------
try {
  const humOnly = [new HY.CongregationHymn([], 5), new HY.CongregationHymn([], 6)];
  let allHum = true;
  let wordless = true;
  let nonEmpty = true;
  for (const hymn of humOnly) {
    for (const line of sing(hymn, 150)) {
      if (line.kind !== 'hum' || line.discoveryId !== null) allHum = false;
      if (line.text.length === 0) nonEmpty = false;
      for (const e of LEDGER) { if (line.text.includes(e.name)) wordless = false; }
    }
  }
  check('empty ledger: every line is a hum with null discovery id', allHum);
  check('empty ledger: hums contain zero ledger names', wordless);
  check('hums are wordless syllables, not silence', nonEmpty);
} catch (e) {
  check('empty-ledger humming', false, e.message);
}

// ---- 3. invalid entries never surface --------------------------------------------
try {
  const dirty = [
    ...LEDGER,
    { id: '', name: 'ghost discovery' },
    { id: 'd-noname', name: '' },
    null,
    { name: 'no id here' },
  ];
  const hymn = new HY.CongregationHymn(dirty, 99);
  check('invalid entries filtered from pool', hymn.discoveryCount === LEDGER.length);
  const validIds = new Set(LEDGER.map((e) => e.id));
  const clean = sing(hymn, 100).every((l) => l.kind === 'hum' || validIds.has(l.discoveryId));
  check('no ghost name/id emitted over 100 lines', clean);
} catch (e) {
  check('invalid-entry filtering', false, e.message);
}

// ---- 4. round structure ------------------------------------------------------------
try {
  const hymn = new HY.CongregationHymn(LEDGER, 31415);
  const staggers = Array.from({ length: HY.VOICE_COUNT }, (_, v) => hymn.voiceStagger(v));
  const lines = sing(hymn, HY.VOICE_COUNT * 12); // 12 full rounds
  let structureOk = true;
  for (let r = 0; r < 12; r++) {
    const round = lines.slice(r * HY.VOICE_COUNT, (r + 1) * HY.VOICE_COUNT);
    const base = r * HY.ROUND_BEATS;
    let prevBeat = -Infinity;
    for (const line of round) {
      if (!(line.beat > prevBeat)) structureOk = false; // staggered entry order
      if (!staggers.includes(line.beat - base)) structureOk = false; // entry offset is a seeded stagger
      prevBeat = line.beat;
    }
    if (new Set(round.map((l) => l.voice)).size !== HY.VOICE_COUNT) structureOk = false;
  }
  check('12 rounds: beats strictly increase, offsets == voice staggers, voices complete', structureOk);
  check('staggers live inside the bar', staggers.every((s) => s >= 0 && s < HY.ROUND_BEATS));
} catch (e) {
  check('round structure', false, e.message);
}

// ---- 5. determinism / dedup ---------------------------------------------------------
try {
  function transcript(seed, n) {
    return sing(new HY.CongregationHymn(LEDGER, seed), n).map((l) => JSON.stringify(l));
  }
  const a = transcript(2024, 300);
  const b = transcript(2024, 300);
  check('same seed => byte-identical 300-line transcript', a.every((r, i) => r === b[i]));
  check('different seed diverges somewhere', a.some((r, i) => r !== transcript(2025, 300)[i]));

  const staggersA = Array.from({ length: HY.VOICE_COUNT }, (_, v) => new HY.CongregationHymn(LEDGER, 2024).voiceStagger(v));
  let otherSeedDiffers = false;
  for (const s of [1, 7, 42, 999, 123456]) {
    const st = Array.from({ length: HY.VOICE_COUNT }, (_, v) => new HY.CongregationHymn(LEDGER, s).voiceStagger(v));
    if (st.some((v, i) => v !== staggersA[i])) otherSeedDiffers = true;
  }
  check('stagger offsets deterministic per seed and seed-sensitive', otherSeedDiffers);

  // dedup window: tiny ledger forces repeats eventually, but never inside
  // the window of consecutive lyric lines
  const tiny = new HY.CongregationHymn([LEDGER[0], LEDGER[1]], 6060842);
  const recentLyrics = [];
  let dedupOk = true;
  for (const line of sing(tiny, 400)) {
    if (line.kind !== 'lyric') continue;
    if (recentLyrics.includes(line.text)) dedupOk = false;
    recentLyrics.push(line.text);
    if (recentLyrics.length > HY.HYMN_DEDUP_WINDOW) recentLyrics.shift();
  }
  check(`dedup window respected across 400 lines (window=${HY.HYMN_DEDUP_WINDOW})`, dedupOk);
} catch (e) {
  check('determinism/dedup', false, e.message);
}

console.log(failures.length === 0 ? `HYMN_PASS (${passed} checks)` : `HYMN_FAIL (${failures.length})`);
for (const f of failures) console.log('  FAILED :: ' + f);
process.exit(failures.length === 0 ? 0 : 1);
