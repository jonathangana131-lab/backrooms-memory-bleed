/**
 * Unit test for director personalities (src/director/persona.ts, F48).
 * Standalone (no browser): transpiles the module (+ its deps) into a temp
 * dir and drives the pure mapping API.
 *
 * Acceptance:
 *   1. temperament selection is deterministic per seed and covers all
 *      three temperaments across seeds; unknown tags fall back to
 *      'patient' (documented)
 *   2. differentiation — same base inputs across temperaments produce
 *      statistically distinct curves:
 *        patient calm/build mean > vindictive calm/build mean
 *        patient peak mean < vindictive and theatrical peak means
 *        theatrical duration variance > patient duration variance
 *        vindictive peak intensity > patient peak intensity by ~30%
 *        theatrical intensity variance > 0 and > vindictive's (flat)
 *        window-event rate ordering: theatrical > vindictive > patient
 *   3. vindictive builds compress monotonically with safety streak
 *      (floor ×0.5), other temperaments ignore the streak
 *   4. determinism per (seed, temperament): identical draw sequences
 *      replay identically; different seeds diverge somewhere
 *
 * Run: node test/persona-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-persona-'));
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
emit('src/director/persona.ts', 'director/persona.mjs');
emit('src/director/director.ts', 'director/director.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/core/events.ts', 'core/events.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'director', 'persona.mjs')).href);
const {
  temperamentForRun,
  normalizeTemperament,
  pacingRngFor,
  adjustPhase,
  adjustIntensity,
  windowEventChance,
  TEMPERAMENTS,
} = mod;

// ---- helpers -----------------------------------------------------------------
const N = 400;
/** Sample N adjusted durations for one (phase, temperament) with fresh streams. */
function sampleDurations(seed, phase, base, t) {
  const rng = pacingRngFor(seed, t);
  return Array.from({ length: N }, () => adjustPhase(phase, base, t, rng));
}
function sampleIntensities(seed, base, t) {
  const rng = pacingRngFor(seed ^ 0x51, t);
  return Array.from({ length: N }, () => adjustIntensity(base, 'peak', t, rng));
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const variance = (a) => {
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
};
const SEED = 0xc0ffee;

// ---- 1. selection + fallback ---------------------------------------------------
(() => {
  const seen = new Set();
  let deterministic = true;
  for (let s = 0; s < 500; s++) {
    const t = temperamentForRun(s * 7919);
    if (!TEMPERAMENTS.includes(t)) deterministic = false;
    if (t !== temperamentForRun(s * 7919)) deterministic = false;
    seen.add(t);
  }
  check('selection deterministic + valid per seed', deterministic);
  check('all three temperaments reachable across seeds', seen.size === 3,
    'seen=' + [...seen].join(','));

  check("unknown tag falls back to 'patient'", normalizeTemperament('bogus') === 'patient');
  check('undefined/null fall back to patient',
    normalizeTemperament(undefined) === 'patient' && normalizeTemperament(null) === 'patient');
  check('valid tags pass through unchanged',
    TEMPERAMENTS.every((t) => normalizeTemperament(t) === t));
})();

// ---- 2a. calm/build ordering: patient longer than vindictive --------------------
(() => {
  for (const phase of ['calm', 'build']) {
    const BASE = 100;
    const p = sampleDurations(SEED, phase, BASE, 'patient');
    const v = sampleDurations(SEED, phase, BASE, 'vindictive');
    check(`patient ${phase} durations all >= x1.15`, p.every((d) => d >= BASE * 1.15),
      'min=' + Math.min(...p).toFixed(2));
    check(`vindictive ${phase} durations all < base`, v.every((d) => d < BASE));
    check(`patient ${phase} mean > vindictive mean by >25%`,
      mean(p) > mean(v) * 1.25,
      `meanP=${mean(p).toFixed(1)} meanV=${mean(v).toFixed(1)}`);
  }
})();

// ---- 2b. peaks: patient shortest -----------------------------------------------
(() => {
  const BASE = 60;
  const p = sampleDurations(SEED, 'peak', BASE, 'patient');
  const v = sampleDurations(SEED, 'peak', BASE, 'vindictive');
  const th = sampleDurations(SEED, 'peak', BASE, 'theatrical');
  check('patient peaks all <= x0.75 (shorter)', p.every((d) => d <= BASE * 0.75));
  check('patient peak mean < vindictive peak mean', mean(p) < mean(v),
    `meanP=${mean(p).toFixed(1)} meanV=${mean(v).toFixed(1)}`);
  check('patient peak mean < theatrical peak mean', mean(p) < mean(th),
    `meanTh=${mean(th).toFixed(1)}`);
})();

// ---- 2c. variance: theatrical widest --------------------------------------------
(() => {
  const BASE = 100;
  const th = sampleDurations(SEED, 'calm', BASE, 'theatrical');
  const p = sampleDurations(SEED, 'calm', BASE, 'patient');
  const v = sampleDurations(SEED, 'calm', BASE, 'vindictive');
  const varTh = variance(th);
  check('theatrical calm spans wide range (<x0.7 .. >x1.3)',
    Math.min(...th) < BASE * 0.7 && Math.max(...th) > BASE * 1.3,
    `min=${Math.min(...th).toFixed(1)} max=${Math.max(...th).toFixed(1)}`);
  check('theatrical duration variance > patient variance',
    varTh > variance(p) * 3, `varTh=${varTh.toFixed(1)} varP=${variance(p).toFixed(1)}`);
  check('theatrical duration variance > vindictive variance',
    varTh > variance(v) * 3);
})();

// ---- 2d. intensity differentiation ------------------------------------------------
(() => {
  const BASE = 0.5;
  const p = sampleIntensities(SEED, BASE, 'patient');
  const v = sampleIntensities(SEED, BASE, 'vindictive');
  const th = sampleIntensities(SEED, BASE, 'theatrical');
  check('vindictive peak intensity ≈ +30% proxy (±2%)',
    Math.abs(mean(v) / BASE - 1.3) < 0.02, 'ratio=' + (mean(v) / BASE).toFixed(4));
  check('patient peak intensity softened below base', mean(p) < BASE);
  check('vindictive − patient gap ≥ 25% of base',
    mean(v) - mean(p) >= 0.25 * BASE,
    `gap=${(mean(v) - mean(p)).toFixed(3)}`);
  check('theatrical intensity swings (variance > 0, range wide)',
    variance(th) > 0 &&
      Math.min(...th) < BASE * 0.8 && Math.max(...th) >= Math.min(BASE * 1.2, 1),
    `min=${Math.min(...th).toFixed(3)} max=${Math.max(...th).toFixed(3)}`);
  check('theatrical intensity variance > vindictive (flat ×1.3)',
    variance(th) > variance(v) + 1e-6);
  check('intensity clamped to [0,1]',
    [...p, ...v, ...th].every((i) => i >= 0 && i <= 1));
})();

// ---- 2e. window-event rate ordering -------------------------------------------------
(() => {
  const base = 0.06;
  const w = (t) => windowEventChance(base, t);
  check('window rate theatrical > vindictive > patient',
    w('theatrical') > w('vindictive') && w('vindictive') > w('patient'),
    `${w('theatrical')} vs ${w('vindictive')} vs ${w('patient')}`);
  check('window multipliers exact (1.5 / 0.85 / 0.7)',
    Math.abs(w('theatrical') / base - 1.5) < 1e-12 &&
      Math.abs(w('vindictive') / base - 0.85) < 1e-12 &&
      Math.abs(w('patient') / base - 0.7) < 1e-12);
})();

// ---- 3. safety streak: vindictive build compression ---------------------------------
(() => {
  const BASE = 80;
  const streakMean = (streak) => {
    const rng = pacingRngFor(SEED ^ 0xabcd, 'vindictive');
    return mean(Array.from({ length: N },
      () => adjustPhase('build', BASE, 'vindictive', rng, { safetyStreak: streak })));
  };
  const m0 = streakMean(0), m3 = streakMean(3), m10 = streakMean(10), m50 = streakMean(50);
  check('build mean shrinks with growing safety streak',
    m0 > m3 && m3 > m10, `m0=${m0.toFixed(1)} m3=${m3.toFixed(1)} m10=${m10.toFixed(1)}`);
  check('compression floor ×0.5 reached by streak 10+',
    Math.abs(m10 / m0 - 0.5) < 0.02 && Math.abs(m50 / m0 - 0.5) < 0.02,
    `m10/m0=${(m10 / m0).toFixed(3)} m50/m0=${(m50 / m0).toFixed(3)}`);
  // Other temperaments ignore the streak entirely.
  for (const t of ['patient', 'theatrical']) {
    const rngA = pacingRngFor(SEED ^ 0x99, t);
    const rngB = pacingRngFor(SEED ^ 0x99, t);
    const noCtx = Array.from({ length: 50 }, () => adjustPhase('build', BASE, t, rngA));
    const withCtx = Array.from({ length: 50 }, () => adjustPhase('build', BASE, t, rngB, { safetyStreak: 9 }));
    check(`${t} ignores safetyStreak (identical draws)`,
      noCtx.every((d, i) => d === withCtx[i]));
  }
  // Missing context behaves like streak 0.
  const rngC = pacingRngFor(SEED ^ 0x31, 'vindictive');
  const rngD = pacingRngFor(SEED ^ 0x31, 'vindictive');
  const noCtxV = Array.from({ length: 50 }, () => adjustPhase('build', BASE, 'vindictive', rngC));
  const zeroV = Array.from({ length: 50 }, () => adjustPhase('build', BASE, 'vindictive', rngD, { safetyStreak: 0 }));
  check('missing context ≡ streak 0 for vindictive',
    noCtxV.every((d, i) => d === zeroV[i]));
})();

// ---- 4. determinism per (seed, temperament) ------------------------------------------
(() => {
  function curve(seed, t) {
    const rng = pacingRngFor(seed, t);
    const phases = ['calm', 'build', 'peak', 'release'];
    return Array.from({ length: 64 }, (_, i) =>
      adjustPhase(phases[i % 4], 100 + i, t, rng, { safetyStreak: i % 5 }));
  }
  let allDet = true;
  let anyDiff = false;
  for (let s = 0; s < 20; s++) {
    const seed = 1000 + s * 131;
    for (const t of TEMPERAMENTS) {
      if (JSON.stringify(curve(seed, t)) !== JSON.stringify(curve(seed, t))) allDet = false;
      if (JSON.stringify(curve(seed, t)) !== JSON.stringify(curve(seed + 1, t))) anyDiff = true;
    }
    if (JSON.stringify(curve(seed, 'patient')) !== JSON.stringify(curve(seed, 'theatrical'))) anyDiff = true;
  }
  check('identical (seed, temperament) ⇒ byte-identical curves', allDet);
  check('different seeds/temperaments diverge somewhere', anyDiff);

  // Fallback path is itself deterministic: bogus tag ≡ patient stream.
  const rngBogus = pacingRngFor(SEED, /** @type {any} */ ('bogus'));
  const rngPat = pacingRngFor(SEED, 'patient');
  const a = Array.from({ length: 32 }, () => adjustPhase('calm', 90, /** @type {any} */ ('bogus'), rngBogus));
  const b = Array.from({ length: 32 }, () => adjustPhase('calm', 90, 'patient', rngPat));
  check("unknown temperament behaves exactly as documented 'patient' fallback",
    a.every((d, i) => d === b[i]));
})();

console.log(failures === 0 ? 'PERSONA_PASS' : `PERSONA_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
