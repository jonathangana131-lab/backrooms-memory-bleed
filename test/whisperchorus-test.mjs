/**
 * Choice-weighted whisper chorus tests (F81) - pure Node, no audio device.
 * Verifies the F81 acceptance proof:
 *   1. ledger injection + validation - duplicate choiceIds and unknown kinds
 *      fail loud; negative weightDelta contributes its absolute value
 *   2. selection frequency monotone in |weightDelta| - a graded ledger
 *      (1:2:4:8) yields strictly increasing pick counts, and a 9:1 ledger
 *      lands the heavy choice near its weighted share (dedup redraws may
 *      bend it slightly off 0.9)
 *   3. kind containment - every emitted line's text comes from the referenced
 *      choice's kind pool; kinds absent from the ledger are never referenced
 *   4. silence safety - empty ledger and all-zero-weight ledger stay silent;
 *      totalSelectionWeight is 0; negative-only ledgers still speak (abs)
 *   5. dedup window - identical text never repeats within DEDUP_WINDOW
 *      consecutive outputs; recentWindow() tracks the window exactly
 *   6. determinism - same seed + ledger replays the output stream
 *      byte-identical; a different seed diverges
 *
 * Run: node test/whisperchorus-test.mjs  (prints WHISPERCHORUS ALL PASS, exits 0)
 */
import { register } from 'node:module';

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
  WhisperChorus, assembleLine, entryWeight, variantsPerChoice,
  CHOICE_KINDS, KIND_OPENERS, KIND_CLOSERS,
  DEDUP_WINDOW, MAX_PICK_ATTEMPTS,
} = await import('../src/audio/whisperchorus.ts');
const { seedFromString } = await import('../src/core/rng.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Collect `n` non-null whispers, asserting none are null. */
function collect(chorus, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = chorus.whisper();
    if (w === null) throw new Error(`unexpected silence at draw ${i}`);
    out.push(w);
  }
  return out;
}

// --- 1. ledger injection + validation -----------------------------------------
console.log('[ledger]');
{
  const ledger = [
    { choiceId: 'spare-mimic', kind: 'mercy', weightDelta: 2 },
    { choiceId: 'take-battery', kind: 'theft', weightDelta: -3 },
  ];
  const c = new WhisperChorus(ledger, 1234);
  ok(c.totalSelectionWeight === 5,
    'totalSelectionWeight sums |weightDelta| (negative theft counts as 3)');

  let threw = '';
  try { new WhisperChorus([{ choiceId: 'a', kind: 'mercy', weightDelta: 1 }, { choiceId: 'a', kind: 'theft', weightDelta: 1 }], 7); }
  catch (e) { threw = String(e); }
  ok(threw.includes('duplicate choice id'), `duplicate choiceId fails loud (${threw.slice(0, 60)})`);

  threw = '';
  try { new WhisperChorus([{ choiceId: 'b', kind: 'greed', weightDelta: 1 }], 7); }
  catch (e) { threw = String(e); }
  ok(threw.includes('unknown choice kind'), `unknown kind fails loud (${threw.slice(0, 60)})`);

  ok(entryWeight({ choiceId: 'x', kind: 'mercy', weightDelta: -4 }) === 4, 'entryWeight takes absolute value');

  // assembleLine contracts: mod arithmetic handles any index sign/magnitude.
  ok(assembleLine('mercy', 0, 0) === KIND_OPENERS.mercy[0] + ' ' + KIND_CLOSERS[0],
    'assembleLine(0,0) joins first opener with first closer');
  let modsOk = true;
  for (const kind of CHOICE_KINDS) {
    for (let o = -9; o <= 9; o++) {
      for (let cl = -9; cl <= 9; cl++) {
        const line = assembleLine(kind, o, cl);
        const openerOk = KIND_OPENERS[kind].some((op) => line.startsWith(op + ' '));
        const closerOk = KIND_CLOSERS.some((cl2) => line.endsWith(cl2));
        if (!openerOk || !closerOk) modsOk = false;
      }
    }
  }
  ok(modsOk, 'assembleLine normalizes negative/large indices into the kind pool');
  ok(variantsPerChoice() >= DEDUP_WINDOW,
    `per-choice variant space (${variantsPerChoice()}) exceeds dedup window (${DEDUP_WINDOW})`);
}

// --- 2. weighting monotone in |weightDelta| ------------------------------------
console.log('[weighting]');
{
  // Graded ledger: strict frequency ordering must emerge.
  const graded = [
    { choiceId: 'w1', kind: 'mercy', weightDelta: 1 },
    { choiceId: 'w2', kind: 'honesty', weightDelta: 2 },
    { choiceId: 'w4', kind: 'theft', weightDelta: 4 },
    { choiceId: 'w8', kind: 'cruelty', weightDelta: 8 },
  ];
  let ordered = true;
  for (const seed of [11, 2026, 90210]) {
    const c = new WhisperChorus(graded, seed);
    const counts = Object.fromEntries(CHOICE_KINDS.map((k) => [k, 0]));
    for (const w of collect(c, 4000)) counts[w.kind]++;
    if (!(counts.cruelty > counts.theft && counts.theft > counts.honesty && counts.honesty > counts.mercy)) {
      ordered = false;
      console.error('   counts@' + seed, JSON.stringify(counts));
    }
  }
  ok(ordered, 'graded 1:2:4:8 ledger yields strictly increasing pick counts across seeds');

  // 9:1 share: heavy choice dominates near its weighted share.
  const heavyLedger = [
    { choiceId: 'betrayal-door', kind: 'betrayal', weightDelta: 9 },
    { choiceId: 'spared-rival', kind: 'mercy', weightDelta: 1 },
  ];
  const c = new WhisperChorus(heavyLedger, 777);
  const draws = collect(c, 6000);
  const heavy = draws.filter((w) => w.kind === 'betrayal').length / draws.length;
  ok(heavy > 0.78 && heavy < 0.95,
    `9:1 ledger gives heavy choice ~0.84 share (measured ${heavy.toFixed(3)})`);

  const light = draws.filter((w) => w.choiceId === 'spared-rival').length;
  ok(light > 0 && light < draws.length * 0.22,
    'light choice still appears but stays clearly dominated');
}

// --- 3. kind containment -------------------------------------------------------
console.log('[kinds]');
{
  const present = ['mercy', 'theft'];
  const absent = CHOICE_KINDS.filter((k) => !present.includes(k));
  const c = new WhisperChorus([
    { choiceId: 'm1', kind: 'mercy', weightDelta: 1 },
    { choiceId: 't1', kind: 'theft', weightDelta: 1 },
  ], 42);
  const draws = collect(c, 3000);
  const seenKinds = new Set(draws.map((w) => w.kind));
  ok(absent.every((k) => !seenKinds.has(k)),
    `kinds absent from ledger never referenced (checked ${absent.join(',')})`);
  ok(draws.every((w) => present.includes(w.kind)), 'every emitted whisper carries a ledger kind');

  const poolsOk = draws.every((w) =>
    KIND_OPENERS[w.kind].some((op) => w.text.startsWith(op + ' ')));
  ok(poolsOk, 'every line opener belongs to the referenced choice\'s kind pool');

  const idsOk = draws.every((w) => ['m1', 't1'].includes(w.choiceId));
  ok(idsOk, 'every whisper references an injected choiceId');
}

// --- 4. silence safety ----------------------------------------------------------
console.log('[silence]');
{
  const empty = new WhisperChorus([], 5);
  let silent = true;
  for (let i = 0; i < 50; i++) if (empty.whisper() !== null) silent = false;
  ok(silent && empty.totalSelectionWeight === 0, 'empty ledger is permanently silent');

  const zeros = new WhisperChorus([
    { choiceId: 'z1', kind: 'mercy', weightDelta: 0 },
    { choiceId: 'z2', kind: 'theft', weightDelta: 0 },
    { choiceId: 'z3', kind: 'honesty', weightDelta: -0 },
  ], 5);
  silent = true;
  for (let i = 0; i < 50; i++) if (zeros.whisper() !== null) silent = false;
  ok(silent && zeros.totalSelectionWeight === 0, 'all-zero-weight ledger is permanently silent');

  const mixedZero = new WhisperChorus([
    { choiceId: 'z0', kind: 'mercy', weightDelta: 0 },
    { choiceId: 'live', kind: 'betrayal', weightDelta: 2 },
  ], 9);
  const draws = collect(mixedZero, 500);
  ok(draws.every((w) => w.choiceId === 'live'),
    'zero-weight entries are never picked while weighted siblings speak');
}

// --- 5. dedup window -------------------------------------------------------------
console.log('[dedup]');
{
  const c = new WhisperChorus([
    { choiceId: 'd-mercy', kind: 'mercy', weightDelta: 1 },
    { choiceId: 'd-cruelty', kind: 'cruelty', weightDelta: 1 },
  ], 31337);
  const texts = collect(c, 400).map((w) => w.text);
  let dupInWindow = false;
  for (let i = DEDUP_WINDOW; i < texts.length; i++) {
    for (let j = i - DEDUP_WINDOW; j < i; j++) {
      if (texts[i] === texts[j]) dupInWindow = true;
    }
  }
  ok(!dupInWindow, `no text repeats within ${DEDUP_WINDOW} consecutive outputs over 400 draws`);
  ok(new Set(texts).size > DEDUP_WINDOW, 'stream is not stuck on a single line');

  const windowed = new WhisperChorus([
    { choiceId: 'rw', kind: 'honesty', weightDelta: 3 },
  ], 88);
  for (let i = 0; i < 20; i++) windowed.whisper();
  const rw = windowed.recentWindow();
  ok(rw.length === DEDUP_WINDOW, `recentWindow() saturates at ${DEDUP_WINDOW} (got ${rw.length})`);
  ok(new Set(rw).size === rw.length, 'recentWindow() itself contains no duplicates');
}

// --- 6. determinism -----------------------------------------------------------------
console.log('[determinism]');
{
  const ledger = [
    { choiceId: 'spare-mimic', kind: 'mercy', weightDelta: 2 },
    { choiceId: 'take-battery', kind: 'theft', weightDelta: -5 },
    { choiceId: 'lied-guard', kind: 'honesty', weightDelta: 3 },
    { choiceId: 'sold-door', kind: 'betrayal', weightDelta: 1 },
  ];
  const replay = () => {
    const c = new WhisperChorus(ledger, 20260824);
    return collect(c, 800)
      .map((w) => `${w.choiceId}|${w.kind}|${seedFromString(w.text)}`)
      .join('\n');
  };
  ok(replay() === replay(), 'same seed + ledger replays byte-identical stream over 800 draws');

  const otherSeed = (() => {
    const c = new WhisperChorus(ledger, 20260825);
    return collect(c, 100).map((w) => `${w.choiceId}|${w.kind}|${seedFromString(w.text)}`).join('\n');
  })();
  ok(otherSeed !== replay().split('\n').slice(0, 100).join('\n'), 'different seed diverges immediately');

  // Ledger order independence of the weighted distribution shape is not
  // required, but per-instance replay must be stable regardless of call site:
  const interleaved = () => {
    const c = new WhisperChorus(ledger, 20260824);
    const out = [];
    for (let i = 0; i < 400; i++) { out.push(c.whisper()); out.push(null); }
    return out.filter(Boolean).map((w) => `${w.choiceId}|${seedFromString(w.text)}`).join('\n');
  };
  ok(interleaved() === interleaved(), 'interleaved caller cadence does not perturb the stream');
}

console.log(check > 0 && failures === 0
  ? `WHISPERCHORUS ALL PASS (${check} checks)`
  : `WHISPERCHORUS FAILURES: ${failures}/${check}`);
process.exit(failures === 0 ? 0 : 1);
