/**
 * Footstep DNA tests - pure Node, no audio device, no Babylon.
 * Verifies the F7 acceptance proof: per-archetype gait signatures are
 * identifiable BEFORE line of sight. The classifier is driven only by
 * step observations (interval + spectral balance); no LOS flag exists
 * anywhere in its input surface.
 * Run: node test/footstepdna-test.mjs  (prints ALL PASS, exits 0)
 */
import assert from 'node:assert/strict';
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
  FootstepDNA, synthesizeTrain, gaitSignature,
  ARCHETYPES, CLASSIFY_WINDOW,
} = await import('../src/audio/footstepdna.ts');

const SEEDS = [101, 2027, 90210];
const INDIVIDUALS = 8;      // distinct bodies per archetype
const STEPS_PER_BODY = 30;  // 240 steps/archetype/seed, >= 200 required
const TRAIN_FRACTION = 0.5; // first half of each body's train teaches it

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Teach one classifier on train splits and score held-out windows. */
function accuracyForSeed(seed) {
  const dna = new FootstepDNA(seed);
  const tests = [];
  for (const type of ARCHETYPES) {
    const trainCut = Math.floor(STEPS_PER_BODY * TRAIN_FRACTION);
    for (let body = 0; body < INDIVIDUALS; body++) {
      const steps = synthesizeTrain(type, seed, STEPS_PER_BODY, body);
      for (let i = 0; i < trainCut; i++) dna.observe(type, steps[i]);
      // held-out: slide a window over the rest as consecutive phrases
      for (let i = trainCut; i + CLASSIFY_WINDOW <= STEPS_PER_BODY; i += CLASSIFY_WINDOW) {
        tests.push({ type, window: steps.slice(i, i + CLASSIFY_WINDOW) });
      }
    }
  }
  let correct = 0;
  let singleStepCorrect = 0;
  for (const t of tests) {
    if (dna.classifyWindow(t.window).type === t.type) correct++;
    if (t.window.every((obs) => dna.classify(obs).type === t.type)) singleStepCorrect++;
  }
  return {
    accuracy: correct / tests.length,
    singleStepAccuracy: singleStepCorrect / tests.length,
    evaluated: tests.length,
  };
}

// --- 1. acceptance proof: >= 95% pre-LOS identification ----------------------
console.log('[classifier accuracy]');
for (const seed of SEEDS) {
  const r = accuracyForSeed(seed);
  ok(r.accuracy >= 0.95,
    `seed ${seed}: ${(r.accuracy * 100).toFixed(1)}% over ${r.evaluated} held-out windows` +
    ` (single-step agreement ${(r.singleStepAccuracy * 100).toFixed(1)}%)`);
}
{
  const totalPerArchetype = INDIVIDUALS * STEPS_PER_BODY;
  ok(totalPerArchetype >= 200,
    `${totalPerArchetype} synthetic steps per archetype per seed (>= 200 floor)`);
}

// --- 2. the classifier is blind to everything but sound -----------------------
console.log('[LOS blindness]');
{
  const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'audio', 'footstepdna.ts');
  const src = readFileSync(srcPath, 'utf8');
  // strip comments: the prose may discuss LOS; the code must never touch it
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\blos\b|lineOfSight|isVisible|visibility/i.test(code),
    'no line-of-sight concept in executable code');
  ok(/classify\(obs: StepObservation\)/.test(src),
    'classify takes only the step observation');
  ok(!src.includes('Math.random'), 'determinism via src/core/rng.ts only');
}

// --- 3. online lifecycle ------------------------------------------------------
console.log('[online learning]');
{
  const dna = new FootstepDNA(77);
  ok(dna.known === false, 'nothing known before evidence');
  const cold = dna.classify({ interval: 0.6, low: 0.5, mid: 0.3, high: 0.2 });
  ok(cold.type === null, 'cold classifier abstains instead of guessing');

  const first = synthesizeTrain('watcher', 77, 10, 0)[0];
  dna.observe('watcher', first);
  ok(dna.known && dna.observedCount('watcher') === 1, 'first footfall is absorbed');

  for (const obs of synthesizeTrain('watcher', 77, 40, 1)) dna.observe('watcher', obs);
  ok(dna.classify(first).type === 'watcher', 'commits after evidence');

  for (const obs of synthesizeTrain('helper', 77, 40, 0)) dna.observe('helper', obs);
  const strong = dna.classify(first);
  const rival = synthesizeTrain('helper', 77, 40, 0)[0];
  ok(strong.type === 'watcher' && strong.confidence > 0.2,
    'matching footfall still resolves to its archetype against a rival centroid');
  ok(dna.classify(rival).type === 'helper' && dna.classify(rival).confidence > 0.2,
    'rival archetype keeps its own footfalls');
  ok(dna.centroid('helper') !== null, 'second archetype tracked too');
}

// --- 4. determinism ------------------------------------------------------------
console.log('[determinism]');
{
  const a = synthesizeTrain('double', 314, 50, 3);
  const b = synthesizeTrain('double', 314, 50, 3);
  assert.deepEqual(a, b, 'train synthesis deterministic per seed/body');
  ok(true, 'same seed + body reproduces identical trains');
  ok(JSON.stringify(synthesizeTrain('double', 314, 50, 4)) !== JSON.stringify(a),
    'a different body gets a different jitter stream');

  const sigA = gaitSignature('believer', 555);
  assert.deepEqual(sigA, gaitSignature('believer', 555), 'signature derivation deterministic');
  const sigC = gaitSignature('believer', 556);
  ok(sigA.interval !== sigC.interval, 'signatures vary across world seeds');

  const d1 = new FootstepDNA(9);
  const d2 = new FootstepDNA(9);
  for (const obs of synthesizeTrain('wanderer', 9, 20, 0)) d1.observe('wanderer', obs);
  for (const obs of synthesizeTrain('wanderer', 9, 20, 0)) d2.observe('wanderer', obs);
  assert.deepEqual(d1.centroid('wanderer'), d2.centroid('wanderer'));
  ok(true, 'identical evidence streams build identical centroids');
}

// --- 5. bodies stay near their archetype ----------------------------------------
console.log('[body realism]');
for (const seed of SEEDS) {
  let allNear = true;
  let unitPartition = true;
  for (const type of ARCHETYPES) {
    const base = gaitSignature(type, seed);
    for (let body = 0; body < 4; body++) {
      const steps = synthesizeTrain(type, seed, 40, body);
      const meanInt = steps.reduce((s, o) => s + o.interval, 0) / steps.length;
      if (Math.abs(meanInt - base.interval) >= 0.06) allNear = false;
      const sum = steps.reduce((s, o) => s + o.low + o.mid + o.high, 0) / steps.length;
      if (Math.abs(sum - 1) > 1e-6) unitPartition = false;
    }
  }
  ok(allNear, `seed ${seed}: every body's mean stride stays near its seeded signature`);
  ok(unitPartition, `seed ${seed}: spectral fractions renormalize to a unit partition`);
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
