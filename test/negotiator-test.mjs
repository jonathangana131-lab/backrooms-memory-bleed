/**
 * Negotiator tests (src/entities/negotiator.ts, F64).
 * Standalone (no browser): transpiles rng.ts + negotiator.ts into a temp dir
 * and drives the trade machine directly, same idiom as tourguide-test.
 *
 * Acceptance:
 *   1. full accept path across seeds - the whole demand sequence answered
 *      with the item in hand consumes exactly one offer, opens the passage
 *      for exactly DEFAULT_PASSAGE_SECONDS, advances the trade counter, and
 *      returns the machine to idle;
 *   2. wrong-gesture reset + hysteresis exact - a mismatch zeroes progress
 *      and arms exactly HYSTERESIS_SECONDS of dead time; every input inside
 *      the window is swallowed without re-arming or extending it; input
 *      counts again the moment it drains;
 *   3. escalation bounds - demand length grows by one per completed trade
 *      and clamps at maxDemandLen forever;
 *   4. passage window expiry - passageActive flips false after exactly T
 *      seconds of advance();
 *   5. determinism - same seed replays byte-identical demand sequences;
 *      different seeds decorrelate;
 *   6. serialize round-trip - mid-trade state survives serialize/restore
 *      and continues identically to an unrestored twin;
 *   7. fail-loud junk - bad deps, unknown gestures, hostile dt, double
 *      beginTrade, and corrupt save data all throw.
 *
 * Run: node test/negotiator-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-negotiator-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/entities'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/entities/negotiator.ts', 'src/entities/negotiator.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const ng = await import(pathToFileURL(path.join(tmp, 'src/entities/negotiator.mjs')).href);

// ---- fixture: recording host ---------------------------------------------------

/** Host double that records every seam call. */
function makeHost({ hasOffer = true } = {}) {
  return {
    taken: 0,
    opened: [],
    hasOffer() { return hasOffer; },
    takeOffer() { this.taken++; },
    openPassage(id, seconds) { this.opened.push({ id, seconds }); },
  };
}

function makeDeps(seed, host, extra = {}) {
  return { id: 'neg-7', seed, itemId: 'batteries', host, ...extra };
}

/** Answer every demanded gesture in order; returns all respond results. */
function playThrough(neg) {
  const results = [];
  for (const g of [...neg.currentDemand]) results.push(neg.respond(g));
  return results;
}

// ---- 1. full accept path across seeds ------------------------------------------
{
  let clean = 0;
  for (let seed = 0; seed < 60; seed++) {
    const host = makeHost();
    const neg = new ng.Negotiator(makeDeps(seed, host));
    neg.beginTrade();
    const len0 = neg.currentDemand.length;
    const results = playThrough(neg);
    const last = results[results.length - 1];
    const ok =
      len0 >= 1 &&
      last.accepted === true &&
      host.taken === 1 &&
      host.opened.length === 1 &&
      host.opened[0].id === 'neg-7' &&
      host.opened[0].seconds === ng.DEFAULT_PASSAGE_SECONDS &&
      neg.completedTrades === 1 &&
      neg.status.phase === 'idle' &&
      neg.status.passageActive === true &&
      Math.abs(neg.status.passageRemainingSec - ng.DEFAULT_PASSAGE_SECONDS) < 1e-12 &&
      // Every intermediate response counted and none was wrong.
      results.every((r) => r.counted && !r.wrongGesture && !r.missingOffer);
    if (ok) clean++;
  }
  check('F64 accept: 60/60 seeds complete the full accept path with an exact grant',
    clean === 60, `clean=${clean}`);

  // Missing offer: sequence matched but nothing settles; the same demand
  // restarts from zero and stays on the table.
  const host0 = makeHost({ hasOffer: false });
  const neg0 = new ng.Negotiator(makeDeps(3, host0));
  neg0.beginTrade();
  const demandBefore = [...neg0.currentDemand];
  const res = playThrough(neg0);
  const last0 = res[res.length - 1];
  check('F64 accept: matched sequence without the item never opens a passage',
    last0.missingOffer === true && host0.taken === 0 && host0.opened.length === 0 &&
    neg0.completedTrades === 0 &&
    JSON.stringify([...neg0.currentDemand]) === JSON.stringify(demandBefore) &&
    neg0.status.progressIndex === 0 &&
    neg0.status.phase === 'demanding');

  // Responding while idle is a counted:false no-op, not a crash.
  const negIdle = new ng.Negotiator(makeDeps(5, makeHost()));
  const rIdle = negIdle.respond('point');
  check('F64 accept: idle-phase responses are swallowed no-ops',
    rIdle.counted === false && rIdle.accepted === false && negIdle.status.phase === 'idle');
}

// ---- 2. wrong-gesture reset + hysteresis exact ----------------------------------
{
  const host = makeHost();
  const neg = new ng.Negotiator(makeDeps(11, host));
  neg.beginTrade();
  const demand = [...neg.currentDemand];
  // Build real progress: at least one correct answer.
  neg.respond(demand[0]);
  const hadProgress = neg.status.progressIndex >= 1;

  // Answer wrongly: anything except the next demanded gesture.
  const wanted = neg.currentDemand[neg.status.progressIndex];
  const wrong = ng.GESTURES.find((g) => g !== wanted);
  const rWrong = neg.respond(wrong);
  check('F64 reset: progress existed before the wrong answer', hadProgress,
    `progressIndex=${neg.status.progressIndex}`);
  check('F64 reset: wrong gesture zeroes progress and arms EXACT hysteresis',
    rWrong.wrongGesture === true && rWrong.counted === true &&
    neg.status.progressIndex === 0 &&
    Math.abs(neg.status.hysteresisRemainingSec - ng.HYSTERESIS_SECONDS) < 1e-12 &&
    neg.status.hysteresisActive === true,
    `remaining=${neg.status.hysteresisRemainingSec}`);

  // Inside the window: correct answers are swallowed and do not re-arm or
  // extend the dead time; only advance() drains it.
  const step = 0.003;
  let swallowedCleanly = true;
  let advanced = 0;
  while (neg.status.hysteresisActive) {
    const before = neg.status.hysteresisRemainingSec;
    const r = neg.respond(neg.currentDemand[0]);
    if (r.counted || r.wrongGesture || r.accepted) swallowedCleanly = false;
    if (Math.abs(neg.status.hysteresisRemainingSec - before) > 1e-15) {
      swallowedCleanly = false; // a respond changed the timer: extension/re-arm
    }
    neg.advance(step);
    advanced += step;
    if (advanced > ng.HYSTERESIS_SECONDS + 1) break; // safety net
  }
  check('F64 hysteresis: window swallows all input for >= HYSTERESIS_SECONDS without re-arm',
    swallowedCleanly && advanced >= ng.HYSTERESIS_SECONDS - step * 2,
    `advanced=${advanced.toFixed(4)}`);

  // The moment it drains, correct answers count again toward a fresh accept.
  let recovered = false;
  for (const g of [...neg.currentDemand]) {
    const r = neg.respond(g);
    if (!r.counted) break;
    recovered = r.accepted;
  }
  check('F64 hysteresis: input counts again immediately after the window drains',
    recovered && host.taken === 1 && host.opened.length === 1);
}

// ---- 3. escalation bounds --------------------------------------------------------
{
  const host = makeHost();
  const neg = new ng.Negotiator(makeDeps(21, host, { baseDemandLen: 2, maxDemandLen: 4 }));
  const lens = [];
  for (let t = 0; t < 6; t++) {
    neg.beginTrade();
    lens.push(neg.currentDemand.length);
    playThrough(neg);
  }
  check('F64 escalation: length grows by one per trade then clamps at maxDemandLen',
    JSON.stringify(lens) === JSON.stringify([2, 3, 4, 4, 4, 4]), `lens=${lens.join(',')}`);
  check('F64 escalation: tradesCompleted tracks accepted trades',
    neg.completedTrades === 6);

  // Pure helper: monotone, bounded, floor at 1.
  const mono = [];
  for (let t = 0; t <= 8; t++) mono.push(ng.demandLengthFor(t, 3, 5));
  const monotone = mono.every((v, i) => i === 0 || (v >= mono[i - 1] && v <= 5));
  check('F64 escalation: demandLengthFor is monotone and bounded',
    monotone && mono[0] === 3 && mono[mono.length - 1] === 5, `mono=${mono.join(',')}`);
}

// ---- 4. passage window expiry -----------------------------------------------------
{
  const host = makeHost();
  const neg = new ng.Negotiator(makeDeps(31, host, { passageSeconds: 20 }));
  neg.beginTrade();
  playThrough(neg);
  const T = ng.DEFAULT_PASSAGE_SECONDS; // not used here; grant was 20
  void T;
  const granted = host.opened[0].seconds;

  // One half-second under the grant: still open (halves are float-exact).
  neg.advance(granted - 0.5);
  const stillOpen = neg.status.passageActive &&
    Math.abs(neg.status.passageRemainingSec - 0.5) < 1e-12;
  // The final half second closes it exactly.
  neg.advance(0.5);
  const closedExactly = !neg.status.passageActive &&
    neg.status.passageRemainingSec === 0;
  // Long-horizon drift can never resurrect it.
  neg.advance(3600);
  check('F64 expiry: window stays open until exactly T seconds then closes for good',
    stillOpen && closedExactly && !neg.status.passageActive,
    `open=${stillOpen} closed=${closedExactly}`);

  // Exactness at default T too: advance(DEFAULT_PASSAGE_SECONDS) in one frame.
  const neg2 = new ng.Negotiator(makeDeps(32, makeHost()));
  neg2.beginTrade();
  playThrough(neg2);
  neg2.advance(ng.DEFAULT_PASSAGE_SECONDS);
  check('F64 expiry: single-frame advance of exactly DEFAULT_PASSAGE_SECONDS closes the window',
    !neg2.status.passageActive && neg2.status.passageRemainingSec === 0);
}

// ---- 5. determinism -----------------------------------------------------------------
{
  /** Collect the demand sequences of the first nTrades trades for one seed. */
  function demandScript(seed, nTrades) {
    const neg = new ng.Negotiator(makeDeps(seed, makeHost()));
    const out = [];
    for (let t = 0; t < nTrades; t++) {
      neg.beginTrade();
      out.push([...neg.currentDemand]);
      playThrough(neg);
    }
    return out;
  }

  const a = JSON.stringify(demandScript(777, 5));
  const b = JSON.stringify(demandScript(777, 5));
  check('F64 determinism: same seed replays byte-identical demand scripts', a === b);

  let distinct = new Set();
  for (let seed = 0; seed < 40; seed++) distinct.add(JSON.stringify(demandScript(seed, 1)));
  check('F64 determinism: seeds decorrelate (first-trade demands spread)',
    distinct.size > 10, `distinct=${distinct.size}`);
  distinct = null;

  // Demand length never exceeds the catalog-driven ceiling even at huge seeds.
  let bounded = true;
  for (let seed = 100; seed < 140; seed++) {
    const neg = new ng.Negotiator(makeDeps(seed, makeHost()));
    neg.beginTrade();
    if (neg.currentDemand.length !== ng.demandLengthFor(0, ng.DEFAULT_BASE_DEMAND_LEN, ng.DEFAULT_MAX_DEMAND_LEN)) {
      bounded = false;
      break;
    }
  }
  check('F64 determinism: first-trade length matches the escalation law across seeds', bounded);
}

// ---- 6. serialize round-trip --------------------------------------------------------
{
  const hostA = makeHost();
  const orig = new ng.Negotiator(makeDeps(42, hostA));
  orig.beginTrade();
  const demand = [...orig.currentDemand];
  // Partial progress, then a wrong answer to arm hysteresis, plus some elapsed time.
  orig.respond(demand[0]);
  const wanted = orig.currentDemand[orig.status.progressIndex];
  orig.respond(ng.GESTURES.find((g) => g !== wanted));
  orig.advance(1.25);

  const saved = orig.serialize();

  // Restored twin over a fresh host continues identically to the original.
  const hostB = makeHost();
  const twin = ng.Negotiator.restore(saved, makeDeps(42, hostB));
  const stateEqual =
    twin.status.tradesCompleted === orig.status.tradesCompleted &&
    twin.status.phase === orig.status.phase &&
    twin.status.progressIndex === orig.status.progressIndex &&
    Math.abs(twin.status.hysteresisRemainingSec - orig.status.hysteresisRemainingSec) < 1e-15 &&
    JSON.stringify([...twin.currentDemand]) === JSON.stringify([...orig.currentDemand]);

  // Drive both with identical future inputs; compare full result traces.
  const traceOf = (n) => {
    const lines = [];
    lines.push(n.respond(n.currentDemand[0])); // finish draining under hysteresis
    n.advance(2); // cross the window boundary
    for (const g of [...n.currentDemand]) lines.push(n.respond(g));
    n.advance(5);
    lines.push(JSON.parse(JSON.stringify(n.serialize())));
    return lines;
  };
  const ta = traceOf(orig);
  const tb = traceOf(twin);
  check('F64 round-trip: restored state matches the original field-for-field', stateEqual);
  check('F64 round-trip: restored machine replays byte-identical futures',
    JSON.stringify(ta) === JSON.stringify(tb));

  // Round-trip through JSON text (the real save path): serialize → parse →
  // restore → serialize must be byte-identical to the original snapshot.
  const reviver = ng.Negotiator.restore(JSON.parse(JSON.stringify(saved)), makeDeps(42, makeHost()));
  check('F64 round-trip: survives a JSON.stringify/parse cycle',
    JSON.stringify(reviver.serialize()) === JSON.stringify(saved));
}

// ---- 7. fail-loud junk -----------------------------------------------------------------
{
  let threw = 0;
  const tryThrow = (fn) => { try { fn(); } catch { threw++; } };

  // Constructor junk.
  tryThrow(() => new ng.Negotiator(null));
  tryThrow(() => new ng.Negotiator(makeDeps(1, undefined)));
  tryThrow(() => new ng.Negotiator(makeDeps(1, {}))); // host lacks seam methods
  tryThrow(() => new ng.Negotiator({ seed: 1, itemId: 'x', host: makeHost() })); // no id
  tryThrow(() => new ng.Negotiator(makeDeps(NaN, makeHost())));
  tryThrow(() => new ng.Negotiator(makeDeps(1, makeHost(), { maxDemandLen: -3 })));

  // Command junk.
  const neg = new ng.Negotiator(makeDeps(1, makeHost()));
  tryThrow(() => neg.respond('high-five')); // off-catalog gesture
  tryThrow(() => neg.respond(42));
  tryThrow(() => neg.advance(-1));
  tryThrow(() => neg.advance(NaN));
  neg.beginTrade();
  tryThrow(() => neg.beginTrade()); // double-open

  // Restore junk.
  const goodSave = (() => {
    const n = new ng.Negotiator(makeDeps(9, makeHost()));
    n.beginTrade();
    return n.serialize();
  })();
  tryThrow(() => ng.Negotiator.restore(undefined, makeDeps(9, makeHost())));
  tryThrow(() => ng.Negotiator.restore([goodSave], makeDeps(9, makeHost())));
  tryThrow(() => ng.Negotiator.restore({ ...goodSave, version: 99 }, makeDeps(9, makeHost())));
  tryThrow(() => ng.Negotiator.restore({ ...goodSave, phase: 'sated' }, makeDeps(9, makeHost())));
  tryThrow(() => ng.Negotiator.restore({ ...goodSave, demand: ['wave'] }, makeDeps(9, makeHost())));
  tryThrow(() => ng.Negotiator.restore({ ...goodSave, progressIndex: -2 }, makeDeps(9, makeHost())));
  tryThrow(() => ng.Negotiator.restore({ ...goodSave, id: 'other' }, makeDeps(9, makeHost())));
  tryThrow(() => ng.Negotiator.restore({ ...goodSave, phase: 'demanding', demand: [] }, makeDeps(9, makeHost())));

  check(`F64 fail-loud: 19 junk injections all throw`, threw === 19, `threw=${threw}`);

  // And a healthy restore still works right after all that abuse.
  const ok = ng.Negotiator.restore(goodSave, makeDeps(9, makeHost()));
  check('F64 fail-loud: valid restore unaffected by rejected junk',
    ok instanceof ng.Negotiator && ok.status.phase === 'demanding');
}

console.log(failures === 0 ? 'NEGOTIATOR_PASS' : `NEGOTIATOR_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
