/**
 * Doppelgänger letters tests (src/story/doubleletters.ts, F66).
 * Standalone (no browser): transpiles rng.ts + doubleletters.ts into a temp
 * dir and drives the drafter directly, same idiom as crawlspaces-test.
 *
 * Acceptance:
 *   1. choice reference - every letter across a sweep of landmarks/seeds
 *      cites >=1 real ledger choice id, quoted verbatim in the text
 *   2. escalation - tone rises monotonically with same-kind repeat counts
 *   3. empty ledger - no letters at all
 *   4. determinism per seed - same (ledger, seed) replays byte-identical
 *      letters; different seeds decorrelate
 *   5. dedup - one letter max per landmark visit; repeated queries return
 *      the identical letter; distinct visits may each get one
 *
 * Run: node test/doubleletters-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-doubleletters-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/story'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/story/doubleletters.ts', 'src/story/doubleletters.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const dl = await import(pathToFileURL(path.join(tmp, 'src/story/doubleletters.mjs')).href);
const KINDS = dl.CHOICE_KINDS;

// ---- fixtures ---------------------------------------------------------------

function entry(id, kind, detailSeed) {
  return { choiceId: id, kind, detailSeed };
}
function mixedLedger(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(entry(`ch-${i}`, KINDS[i % KINDS.length], 1000 + i * 7));
  }
  return out;
}
const LANDMARKS = ['elevator-lobby', 'poolroom-bench', 'boiler-note-desk', 'exit-door-mockup', 'wet-office-cubicle'];

// ---- 1. every letter references a real ledger choice --------------------------
{
  let letters = 0;
  let allRefReal = true;
  let allQuoted = true;
  for (const seed of [11, 4242, 909527]) {
    const ledger = mixedLedger(12);
    const ids = new Set(ledger.map((e) => e.choiceId));
    const d = new dl.DoubleLetters({ ledger, seed });
    for (const lm of LANDMARKS) {
      for (let visitSeq = 1; visitSeq <= 3; visitSeq++) {
        const note = d.letterFor({ landmarkId: lm, visitSeq });
        if (!note) continue;
        letters++;
        if (note.references.length < 1) allRefReal = false;
        for (const ref of note.references) {
          if (!ids.has(ref)) allRefReal = false;
          if (!note.text.includes(ref)) allQuoted = false;
        }
      }
    }
  }
  check(`choice-reference: ${letters} letters across seeds all cite real ids`, letters >= 45 && allRefReal);
  check('choice-reference: cited ids appear verbatim in text', allQuoted);
}

// ---- 2. escalation monotone with repeat counts ---------------------------------
{
  // Single-kind ledgers force the criticized kind; grow counts, watch tone.
  let monotone = true;
  let roseSomewhere = false;
  const tones = [];
  let prev = 0;
  for (let count = 1; count <= 9; count++) {
    const ledger = [];
    for (let i = 0; i < count; i++) ledger.push(entry(`m-${i}`, KINDS[0], i * 13));
    const d = new dl.DoubleLetters({ ledger, seed: 777 });
    const note = d.letterFor({ landmarkId: 'escalation-hall', visitSeq: 1 });
    if (!note || note.kind !== KINDS[0]) { monotone = false; break; }
    tones.push(note.tone);
    if (note.tone < prev) monotone = false;
    if (note.tone > prev) roseSomewhere = true;
    prev = note.tone;
  }
  check(`escalation monotone non-decreasing over counts 1..9 (${tones.join(',')})`, monotone);
  check('escalation actually climbs across repeats', roseSomewhere && tones[tones.length - 1] > tones[0]);
  check('tone helper monotone + clamped', (() => {
    let ok = true;
    for (let c = 0; c <= 40; c++) {
      const t = dl.toneForRepeatCount(c);
      if (t < dl.TONE_FLOOR || t > dl.TONE_CEILING) ok = false;
      if (c > 1 && dl.toneForRepeatCount(c) < dl.toneForRepeatCount(c - 1)) ok = false;
    }
    return ok && dl.toneForRepeatCount(0) === dl.TONE_FLOOR && dl.toneForRepeatCount(999) === dl.TONE_CEILING;
  })());
}

// ---- 3. empty ledger -> no notes ------------------------------------------------
{
  const d = new dl.DoubleLetters({ ledger: [], seed: 42 });
  let anyNote = false;
  for (const lm of LANDMARKS) {
    for (let v = 1; v <= 2; v++) if (d.letterFor({ landmarkId: lm, visitSeq: v })) anyNote = true;
  }
  check('empty ledger produces zero notes', !anyNote && d.letterCount === 0);

  const junk = new dl.DoubleLetters({
    ledger: [entry('', 'mercy', 1), null, { choiceId: '', kind: 'curiosity', detailSeed: 2 }],
    seed: 42,
  });
  const junkNote = junk.letterFor({ landmarkId: 'junk-wing', visitSeq: 1 });
  check('ledger with only unusable entries yields no notes', junkNote === null);
}

// ---- 4. determinism per seed -----------------------------------------------------
{
  const ledger = mixedLedger(10);
  function collect(seed) {
    const d = new dl.DoubleLetters({ ledger, seed });
    const out = [];
    for (const lm of LANDMARKS) for (let v = 1; v <= 2; v++) {
      const n = d.letterFor({ landmarkId: lm, visitSeq: v });
      if (n) out.push(`${n.id}|${n.kind}|${n.tone}|${n.references.join(',')}|${n.text}`);
    }
    return out.join('\n');
  }
  const a = collect(31415);
  const b = collect(31415);
  const c = collect(27182);
  check('same seed replays byte-identical letters', a === b && a.length > 0);
  check('different seed decorrelates', a !== c);

  // Per-choice detailSeed steers details independently of session seed.
  let detailDiffs = 0;
  for (let li = 0; li < 10; li++) {
    const lm = 'detail-room-' + li;
    const t1 = new dl.DoubleLetters({ ledger: [entry('fixed-id', 'cruelty', 111)], seed: 8 })
      .letterFor({ landmarkId: lm, visitSeq: 1 }).text;
    const t2 = new dl.DoubleLetters({ ledger: [entry('fixed-id', 'cruelty', 999)], seed: 8 })
      .letterFor({ landmarkId: lm, visitSeq: 1 }).text;
    if (t1 !== t2) detailDiffs++;
  }
  check('detailSeed changes incidental detail at fixed session seed', detailDiffs > 0);
}

// ---- 5. dedup / one note per landmark visit --------------------------------------
{
  const d = new dl.DoubleLetters({ ledger: mixedLedger(8), seed: 555 });
  const first = d.letterFor({ landmarkId: 'dedup-locker', visitSeq: 1 });
  const second = d.letterFor({ landmarkId: 'dedup-locker', visitSeq: 1 });
  const thirdVisit = d.letterFor({ landmarkId: 'dedup-locker', visitSeq: 2 });
  check('repeat query returns the identical letter object', first === second && !!first);
  check('distinct visit of same landmark gets its own single letter', thirdVisit !== first && !!thirdVisit);
  check('issued count matches unique visits with letters', d.letterCount >= 2);

  // Null results are also memoized (still max one draft attempt per visit).
  const empty = new dl.DoubleLetters({ ledger: [], seed: 1 });
  const e1 = empty.letterFor({ landmarkId: 'x', visitSeq: 1 });
  const e2 = empty.letterFor({ landmarkId: 'x', visitSeq: 1 });
  check('empty-ledger nulls stay stable across queries', e1 === null && e2 === null);
}

console.log(failures === 0 ? 'DOUBLELETTERS_PASS' : `DOUBLELETTERS_FAIL failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
