/**
 * Panic breathing control tests (F78) - pure Node, no browser.
 * Verifies the F78 acceptance proof: a perfectly executed rhythm scores
 * >= 0.95 steadiness, seeded random mashing stays < 0.3, the response is
 * monotone (with exact values) over graded inputs, the stabilization
 * multiplier maps [0,1] -> [1 -> 0.4] monotonically, and everything is
 * deterministic per seed with no unseeded randomness anywhere.
 * Run: node test/panicbreath-test.mjs  (prints ALL PASS, exits 0)
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
  TARGET_PERIOD_S, TARGET_DUTY, STABILIZATION_MIN_MULTIPLIER,
  targetHeldAt, targetHeldDurationS, alignmentScore,
  steadinessFromAlignment, stabilizationMultiplier,
  phaseOffsetFromSeed, PanicBreathMinigame,
} = await import('../src/player/panicbreath.ts');
const { RNG } = await import('../src/core/rng.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Perfect rhythm events on the prompted edges k*P + phase, optionally delayed releases. */
function perfectInputs(cycles, phaseOffsetS, delayPerCycleS = 0, firstCycle = 0) {
  const events = [];
  for (let k = firstCycle; k < firstCycle + cycles; k++) {
    const cycleStart = phaseOffsetS + k * TARGET_PERIOD_S;
    events.push({ t: cycleStart, held: true });
    events.push({ t: cycleStart + TARGET_DUTY * TARGET_PERIOD_S + delayPerCycleS, held: false });
  }
  return events;
}

/** Seeded random masher: flips held state at uniformly random short intervals. */
function mashedInputs(tEnd, seed, phaseOffsetS) {
  const rng = new RNG(seed);
  const events = [];
  let t = rng.range(0.05, 0.5);
  let held = false;
  while (t < tEnd) {
    held = !held;
    events.push({ t, held });
    t += rng.range(0.05, 0.5);
  }
  return { events, phaseOffsetS };
}

// --- 1. square-wave geometry ---------------------------------------------------
console.log('[target wave]');
{
  ok(targetHeldAt(0, 0) === true && targetHeldAt(TARGET_PERIOD_S / 2, 0) === false &&
     targetHeldAt(TARGET_PERIOD_S, 0) === true,
     'square wave holds first half, releases second half');
  ok(targetHeldDurationS(0, TARGET_PERIOD_S, 0) === TARGET_DUTY * TARGET_PERIOD_S,
     `full-period held duration is exactly ${TARGET_DUTY * TARGET_PERIOD_S}s`);
  const phiS = 1.25;
  ok(Math.abs(targetHeldDurationS(phiS, phiS + 100 * TARGET_PERIOD_S, phiS)
    - 100 * TARGET_PERIOD_S * TARGET_DUTY) < 1e-9,
     'held duration integrates exactly across 100 whole cycles under a phase offset');
  ok(Math.abs(targetHeldDurationS(-7.3, 91.7, 1.234) - 99 * TARGET_DUTY) < TARGET_PERIOD_S,
     'held duration of an arbitrary span lands within one period of the duty-cycle expectation');
}

// --- 2. acceptance proof: perfect rhythm stabilizes -----------------------------
console.log('[perfect rhythm]');
{
  const seed = 42;
  const phase = phaseOffsetFromSeed(seed);
  const score = alignmentScore(perfectInputs(31, phase, 0, -1), 0, 30 * TARGET_PERIOD_S, phase);
  ok(score === 1, 'perfect rhythm aligns 100% of the window');
  ok(steadinessFromAlignment(score) >= 0.95,
     `perfect rhythm steadiness ${steadinessFromAlignment(score)} >= 0.95`);
}

// --- 3. acceptance proof: random mashing fails ----------------------------------
console.log('[random mashing]');
{
  const T = 240;
  const traces = [];
  let all = true;
  let sum = 0;
  for (let seed = 100; seed < 108; seed++) {
    const { events, phaseOffsetS } = mashedInputs(T, seed, phaseOffsetFromSeed(seed));
    const s = steadinessFromAlignment(alignmentScore(events, 0, T, phaseOffsetS));
    traces.push(`seed${seed}:${s.toFixed(3)}`);
    sum += s;
    if (s >= 0.3) all = false;
  }
  ok(all, `mashing steadiness < 0.3 across 8 seeds (${traces.join(' ')})`);
  ok(sum / 8 < 0.08, `mean mashing steadiness ${(sum / 8).toFixed(4)} << chance-derived ceiling`);

  // an exactly inverted performance is total failure
  const phase = 0;
  const inverted = perfectInputs(22, phase, 0, -1).map((e) => ({ t: e.t, held: !e.held }));
  ok(alignmentScore(inverted, 0, 20 * TARGET_PERIOD_S, phase) === 0,
     'anti-phase play aligns 0% and scores steadiness 0');
}

// --- 4. monotone graded response with exact values -------------------------------
console.log('[graded response]');
{
  // Grade g holds an extra (g/20)-of-period into the release half: alignment
  // must fall exactly linearly 1 - g/20 -> steadiness 1 - g/10.
  const phase = 0;
  const cycles = 40;
  let prev = Infinity;
  let monotone = true;
  let exact = true;
  for (let g = 0; g <= 10; g++) {
    const inputs = perfectInputs(cycles, phase, (g / 20) * TARGET_PERIOD_S);
    const s = steadinessFromAlignment(alignmentScore(inputs, 0, cycles * TARGET_PERIOD_S, phase));
    if (s >= prev) monotone = false;
    if (Math.abs(s - Math.max(0, 1 - g / 10)) > 1e-9) exact = false;
    prev = s;
  }
  ok(monotone, 'steadiness strictly decreases across the 11-point graded sweep');
  ok(exact, 'each grade lands its exact predicted value 1 - g/10 (linear remap)');
}

// --- 5. stabilization multiplier -------------------------------------------------
console.log('[multiplier]');
{
  ok(stabilizationMultiplier(0) === 1, 'no steadiness -> multiplier exactly 1 (no help)');
  ok(stabilizationMultiplier(1) === STABILIZATION_MIN_MULTIPLIER,
     `perfect steadiness -> multiplier exactly ${STABILIZATION_MIN_MULTIPLIER}`);
  let prev = Infinity;
  let monotone = true;
  for (let i = 0; i <= 20; i++) {
    const m = stabilizationMultiplier(i / 20);
    if (m >= prev) monotone = false;
    if (m < STABILIZATION_MIN_MULTIPLIER || m > 1) monotone = false;
    prev = m;
  }
  ok(monotone, `multiplier strictly decreases 1 -> ${STABILIZATION_MIN_MULTIPLIER}, never out of band`);
}

// --- 6. live minigame easing ------------------------------------------------------
console.log('[easing]');
{
  const game = new PanicBreathMinigame(42);
  const phase = game.phaseOffsetS;
  for (const e of perfectInputs(110, phase, 0, -40)) game.onInput(e);
  const rise = [];
  for (let i = 0; i < 480; i++) { game.update(0.05); rise.push(game.steadiness); }
  const risesMonotone = rise.every((s, i) => i === 0 || s >= rise[i - 1] - 1e-12);
  ok(risesMonotone && rise[rise.length - 1] >= 0.95 && rise.every((s) => s <= 1),
     `steadiness eases monotonically up to ${rise[rise.length - 1].toFixed(4)} without overshoot`);
  ok(game.multiplier <= 1 && game.multiplier > STABILIZATION_MIN_MULTIPLIER - 1e-12,
     `live multiplier settles near the calm floor (${game.multiplier.toFixed(3)})`);

  // panic returns: mashing drags the eased score back down
  for (const e of mashedInputs(60, 777, phase).events.filter((e) => e.t > 24)) game.onInput(e);
  const fall = [];
  for (let i = 0; i < 720; i++) { game.update(0.05); fall.push(game.steadiness); }
  ok(fall[fall.length - 1] < 0.3,
     `mashing after a calm stretch pulls steadiness back under 0.3 (${fall[fall.length - 1].toFixed(3)})`);
  ok(fall[fall.length - 1] < rise[rise.length - 1],
     'the breath meter actually loses its gained stabilization');
}

// --- 7. determinism per seed -------------------------------------------------------
console.log('[determinism]');
{
  const replay = (seed) => {
    const game = new PanicBreathMinigame(seed);
    const { events, phaseOffsetS } = mashedInputs(30, seed ^ 0xbeef, phaseOffsetFromSeed(seed));
    for (const e of events) game.onInput(e);
    const trace = [];
    for (let i = 0; i < 600; i++) { game.update(0.05); trace.push(game.steadiness.toFixed(12)); }
    return JSON.stringify({ phase: game.phaseOffsetS, trace });
  };
  ok(replay(1234) === replay(1234), 'same seed + same injected stream -> byte-identical session trace');
  ok(replay(1234) !== replay(1235), 'different seeds decorrelate the prompted-rhythm phase');

  ok(phaseOffsetFromSeed(42) !== phaseOffsetFromSeed(43),
     'adjacent seeds derive distinct prompt phase offsets');
  ok(phaseOffsetFromSeed(7) >= 0 && phaseOffsetFromSeed(7) < TARGET_PERIOD_S,
     'phase offset lands inside one prompt period');

  ok(!readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'player', 'panicbreath.ts'), 'utf8').includes('Math.random'),
    'module contains no unseeded randomness at all');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
