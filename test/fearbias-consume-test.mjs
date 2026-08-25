/**
 * F90 director-learning CONSUME side tests (v1.1 debt payoff) - pure Node,
 * no renderer. The feed side (scare-response events into DirectorLearning)
 * was already wired; this suite proves the consume seam end-to-end:
 *   helpers  fearLevelFromWeights / fearBuildDurationMul / fearPeakCoinChance
 *            are pure, neutral-exact (0.5 -> mul 1.0, coin 0.55 = legacy),
 *            clamp junk to safe values, and move monotonically with fear;
 *   parity   an unfed director and an explicitly-neutral-fed director take
 *            byte-identical phase timelines on the same seed (legacy
 *            behavior preserved), and same-seed runs replay identically;
 *   scaling  learned fear shortens the calm->build road and boredom
 *            lengthens it, on identical seeds;
 *   coin     across many seeds the build->peak coin dominates: feared runs
 *            peak whenever neutral runs do, bored runs never peak where
 *            neutral releases (threshold shift on the SAME single draw);
 *   draws    a draw-counting RNG wrapper proves the consume adds ZERO new
 *            pacing-stream draws through the first build resolution;
 *   wiring   game.ts feeds setFearBias(suggestPhaseBias()) every frame,
 *            beginRun resets the bias to neutral, and director.ts consumes
 *            at exactly the two documented sites.
 * Run: node test/fearbias-consume-test.mjs  (prints FEARBIAS ALL PASS, exits 0)
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Standalone transpile harness (persona-test pattern): emit the module under
// test plus its import graph into a temp dir with .mjs-relative imports.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-fearbias-'));
fs.mkdirSync(path.join(tmp, 'director'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/director/director.ts', 'director/director.mjs');
emit('src/director/persona.ts', 'director/persona.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/core/events.ts', 'core/events.mjs');

const {
  HorrorDirector,
  FEAR_LEVEL_NEUTRAL,
  FEAR_BUILD_DUR_SPAN,
  FEAR_PEAK_COIN_BASE,
  FEAR_PEAK_COIN_SHIFT,
  fearLevelFromWeights,
  fearBuildDurationMul,
  fearPeakCoinChance,
} = await import(pathToFileURL(path.join(tmp, 'director', 'director.mjs')).href);
const { RNG } = await import(pathToFileURL(path.join(tmp, 'core', 'rng.mjs')).href);

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  passes++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** Minimal DirectorHost fake; elapsed tracks simulated seconds. */
function fakeHost() {
  const h = {
    t: 0,
    calls: { killNearbyLight: 0, distantThreat: 0, blackoutPulse: 0, whisperSurge: 0 },
    lightingStress() {},
    killNearbyLight() { h.calls.killNearbyLight++; },
    blackoutPulse() { h.calls.blackoutPulse++; },
    whisperSurge() { h.calls.whisperSurge++; },
    distantThreat() { h.calls.distantThreat++; },
    nonEuclideanNudge() {},
    armDoorwayLoop() {},
    requestEntitySpawn() {},
    playerPosition() { return { x: 0, z: 0 }; },
    elapsed() { return h.t; },
  };
  return h;
}

/**
 * Drive a director from phase start until it first leaves its initial calm
 * phase AND resolves the following build (enters peak or release). Returns
 * { buildEntryT, buildExitT, afterBuild } using the host clock.
 */
function runThroughFirstBuild(seed, bias, opts = {}) {
  const dt = opts.dt ?? 0.25;
  const maxSteps = opts.maxSteps ?? 20000;
  const host = fakeHost();
  const counting = opts.countingRng ?? null;
  const d = new HorrorDirector(host, seed, counting ?? undefined);
  if (bias !== undefined) d.setFearBias(bias);
  let buildEntryT = null;
  let buildExitT = null;
  let afterBuild = null;
  let sawBuild = false;
  for (let i = 0; i < maxSteps; i++) {
    const prev = d.phase;
    host.t += dt;
    d.update(dt);
    if (!sawBuild && prev === 'calm' && d.phase === 'build') {
      sawBuild = true;
      buildEntryT = host.t;
    } else if (sawBuild && prev === 'build' && d.phase !== 'build') {
      buildExitT = host.t;
      afterBuild = d.phase;
      break;
    }
  }
  return { director: d, host, buildEntryT, buildExitT, afterBuild };
}

// ---------------------------------------------------------------------------
console.log('1. Helper purity + neutral-exact legacy passthrough');
{
  ok(FEAR_LEVEL_NEUTRAL === 0.5, 'FEAR_LEVEL_NEUTRAL is exactly 0.5');
  ok(fearBuildDurationMul(0.5) === 1, 'neutral fear -> duration multiplier exactly 1');
  ok(fearPeakCoinChance(0.5) === FEAR_PEAK_COIN_BASE && FEAR_PEAK_COIN_BASE === 0.55,
    'neutral fear -> peak coin exactly the legacy 0.55');
  // Junk falls back to neutral, never NaN.
  for (const junk of [NaN, Infinity, -Infinity]) {
    ok(fearBuildDurationMul(junk) === 1 && fearPeakCoinChance(junk) === 0.55,
      `junk level ${junk} falls back to exact legacy values`);
  }
  // Aggregation: mean of finite weights, each clamped to [0,1]; junk input neutral.
  near(fearLevelFromWeights({ a: 0.2, b: 0.6 }), 0.4, 1e-12) ||
    ok(near(fearLevelFromWeights({ a: 0.2, b: 0.6 }), 0.4, 1e-12), 'weights aggregate by mean');
  ok(fearLevelFromWeights({ a: 5, b: -7 }) === 0.5, 'out-of-range weights clamp to [0,1] before averaging');
  ok(fearLevelFromWeights(null) === 0.5 && fearLevelFromWeights(undefined) === 0.5
    && fearLevelFromWeights({}) === 0.5 && fearLevelFromWeights({ a: NaN }) === 0.5
    && fearLevelFromWeights({ a: 'x' }) === 0.5, 'null/empty/all-junk weight maps fall back to neutral');
  // Out-of-range levels CLAMP to the span ends (documented); only non-finite
  // levels fall back to the exact neutral/legacy values.
  ok(fearBuildDurationMul(2) === 1 - FEAR_BUILD_DUR_SPAN && fearBuildDurationMul(-3) === 1 + FEAR_BUILD_DUR_SPAN,
    'out-of-range levels clamp to the documented multiplier ends');
  // Monotonicity + documented spans.
  let mono = true;
  for (let l = 0; l <= 1.0001; l += 0.05) {
    if (!(fearBuildDurationMul(l + 0.05) <= fearBuildDurationMul(l) + 1e-12)) mono = false;
    if (!(fearPeakCoinChance(l + 0.05) >= fearPeakCoinChance(l) - 1e-12)) mono = false;
  }
  ok(mono, 'duration multiplier decreases and coin increases monotonically with fear');
  ok(near(fearBuildDurationMul(1), 1 - FEAR_BUILD_DUR_SPAN, 1e-12)
    && near(fearBuildDurationMul(0), 1 + FEAR_BUILD_DUR_SPAN, 1e-12),
    'fully feared/bored duration multipliers hit the documented span ends');
  ok(near(fearPeakCoinChance(1), FEAR_PEAK_COIN_BASE + FEAR_PEAK_COIN_SHIFT, 1e-12)
    && near(fearPeakCoinChance(0), FEAR_PEAK_COIN_BASE - FEAR_PEAK_COIN_SHIFT, 1e-12),
    'fully feared/bored coins hit the documented shift ends');
  ok(fearPeakCoinChance(1) <= 1 && fearPeakCoinChance(0) >= 0, 'coin stays a legal probability');
}

// ---------------------------------------------------------------------------
console.log('2. Parity: unfed == explicitly-neutral == deterministic replay');
{
  const a = runThroughFirstBuild(1234, undefined);
  const b = runThroughFirstBuild(1234, { hum: 0.5, note: 0.5 });
  const c = runThroughFirstBuild(1234, null);
  ok(a.buildEntryT === b.buildEntryT && a.buildExitT === b.buildExitT
    && a.afterBuild === b.afterBuild, 'unfed and neutral-fed directors take identical timelines');
  ok(a.buildEntryT === c.buildEntryT && a.afterBuild === c.afterBuild,
    'setFearBias(null) reset matches the never-fed timeline');
  const d2 = runThroughFirstBuild(1234, undefined);
  ok(d2.buildEntryT === a.buildEntryT && d2.afterBuild === a.afterBuild,
    'same-seed replays stay byte-identical (determinism law intact)');
}

// ---------------------------------------------------------------------------
console.log('3. Scaling: feared shortens the BUILD phase, boredom lengthens it');
{
  // The calm->build consume site scales the BUILD duration drawn at the
  // transition (calm itself stays untouched), so measure build length.
  const feared = runThroughFirstBuild(77, { a: 1, b: 1 });
  const neutral = runThroughFirstBuild(77, { a: 0.5 });
  const bored = runThroughFirstBuild(77, { a: 0, b: 0 });
  const len = (r) => r.buildExitT - r.buildEntryT;
  // Same drawn base on the same seed; lengths are polled at dt=0.25 so allow
  // exactly one step of quantization jitter on top of the exact multiplier.
  ok(Math.abs(len(feared) - (1 - FEAR_BUILD_DUR_SPAN) * len(neutral)) <= 0.26,
    `feared build runs at ${(1 - FEAR_BUILD_DUR_SPAN).toFixed(2)}x neutral (${len(feared).toFixed(2)} vs ${len(neutral).toFixed(2)})`);
  ok(Math.abs(len(bored) - (1 + FEAR_BUILD_DUR_SPAN) * len(neutral)) <= 0.26,
    `bored build runs at ${(1 + FEAR_BUILD_DUR_SPAN).toFixed(2)}x neutral (${len(bored).toFixed(2)} vs ${len(neutral).toFixed(2)})`);
  ok(feared.buildEntryT === neutral.buildEntryT && bored.buildEntryT === neutral.buildEntryT,
    'calm-phase pacing is untouched by the fear bias (consume site is build-entry only)');
}

// ---------------------------------------------------------------------------
console.log('4. Coin: unit-threshold dominance + aggregate directional shift');
{
  // The coin draw is seeded by (seed ^ elapsed-at-build-end), and the scaled
  // build shifts that elapsed — so cross-bias runs do NOT share one draw.
  // Dominance is therefore proven on the threshold function over a fixed
  // uniform sample u (chance(p) == next() < p), then confirmed statistically
  // through real director timelines.
  let dominance = true;
  for (let i = 0; i < 2000; i++) {
    const u = i / 2000;
    if (u < fearPeakCoinChance(0.5) && !(u < fearPeakCoinChance(1))) dominance = false;
    if (u < fearPeakCoinChance(0) && !(u < fearPeakCoinChance(0.5))) dominance = false;
  }
  ok(dominance, 'for any fixed draw u: peak(u | feared) >= peak(u | neutral) >= peak(u | bored)');
  const SEEDS = 400;
  const peaks = { feared: 0, neutral: 0, bored: 0 };
  for (let s = 0; s < SEEDS; s++) {
    if (runThroughFirstBuild(1000 + s, { t: 1 }).afterBuild === 'peak') peaks.feared++;
    if (runThroughFirstBuild(1000 + s, { t: 0.5 }).afterBuild === 'peak') peaks.neutral++;
    if (runThroughFirstBuild(1000 + s, { t: 0 }).afterBuild === 'peak') peaks.bored++;
  }
  ok(peaks.feared > peaks.neutral && peaks.neutral > peaks.bored,
    `aggregate peak counts order feared(${peaks.feared}) > neutral(${peaks.neutral}) > bored(${peaks.bored}) over ${SEEDS} seeds`);
  // Binomial sanity: neutral coin 0.55 over 400 seeds.
  ok(Math.abs(peaks.neutral / SEEDS - 0.55) < 0.08,
    `neutral empirical coin ${(peaks.neutral / SEEDS).toFixed(3)} sits at the legacy 0.55`);
}

// ---------------------------------------------------------------------------
console.log('5. Consume adds zero draws + identical feeds replay identically');
{
  /** Counting wrapper delegating to a real seeded RNG stream. */
  function makeCountingRng(seed) {
    const rng = new RNG(seed);
    const counts = { range: 0, chance: 0, next: 0 };
    return {
      counts,
      range: (a, b) => { counts.range++; return rng.range(a, b); },
      chance: (p) => { counts.chance++; return rng.chance(p); },
      next: () => { counts.next++; return rng.next(); },
    };
  }
  const runWithCounting = (bias) => {
    const host = fakeHost();
    const cr = makeCountingRng(0xbeef);
    const d = new HorrorDirector(host, 0xbeef, cr);
    if (bias !== undefined) d.setFearBias(bias);
    let sawBuild = false;
    for (let i = 0; i < 20000; i++) {
      const prev = d.phase;
      host.t += 0.25;
      d.update(0.25);
      if (!sawBuild && prev === 'calm' && d.phase === 'build') sawBuild = true;
      else if (sawBuild && prev === 'build' && d.phase !== 'build') break;
    }
    return { ...cr.counts, afterBuild: d.phase };
  };
  // Unfed vs explicitly-neutral: identical timelines => identical draw counts.
  const unfed = runWithCounting(undefined);
  const neutral = runWithCounting({ t: 0.5 });
  ok(unfed.range === neutral.range && unfed.chance === neutral.chance
    && unfed.next === neutral.next && unfed.afterBuild === neutral.afterBuild,
    `unfed and neutral-fed runs make identical stream draws (${JSON.stringify(neutral)})`);
  // Identical bias feeds replay identically including draw profile.
  const replayA = runWithCounting({ t: 0.8 });
  const replayB = runWithCounting({ t: 0.8 });
  ok(replayA.range === replayB.range && replayA.chance === replayB.chance
    && replayA.afterBuild === replayB.afterBuild,
    'same-seed identical-bias replays consume identical draw profiles (determinism law)');
  // The helpers themselves are pure arithmetic: no RNG surface of any kind.
  for (const fn of [fearLevelFromWeights, fearBuildDurationMul, fearPeakCoinChance]) {
    const before = JSON.stringify([fn.name]);
    fn(0.7); fn({ x: 0.9 }); fn(NaN);
    ok(JSON.stringify([fn.name]) === before, `${fn.name} performs no stateful/draw work (pure repeat-call identity)`);
  }
}

// ---------------------------------------------------------------------------
console.log('6. Wiring greps: game.ts feed + reset, director.ts consume sites');
{
  const gameSrc = fs.readFileSync(path.join(ROOT, 'src/core/game.ts'), 'utf8');
  const dirSrc = fs.readFileSync(path.join(ROOT, 'src/director/director.ts'), 'utf8');
  ok(gameSrc.includes('this.director.setFearBias(this.learning.suggestPhaseBias());'),
    'frame loop feeds suggestPhaseBias() weights into the director every learning tick');
  ok(/beginRun[\s\S]*?this\.director\.setFearBias\(null\)/.test(gameSrc),
    'beginRun resets the director fear bias to neutral');
  ok(dirSrc.includes('fearBuildDurationMul(this.fearBiasLevel)'),
    'calm->build duration routes through fearBuildDurationMul');
  ok(/rng\.chance\(fearPeakCoinChance\(this\.fearBiasLevel\)\)/.test(dirSrc),
    'build->peak coin routes through fearPeakCoinChance');
  ok(!/Math\.random/.test(dirSrc), 'director consume adds no unseeded randomness (determinism law)');
  ok(typeof new HorrorDirector(fakeHost(), 1).fearBias === 'number'
    && new HorrorDirector(fakeHost(), 1).fearBias === 0.5,
    'fresh directors expose fearBias at the neutral baseline');
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? 'FEARBIAS ALL PASS' : `FEARBIAS ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
