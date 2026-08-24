/**
 * Stamina embodiment tests (F9): drain/regen level machine and the three
 * monotonic presentation outputs.
 *
 * Runs with plain node (node test/stamina-test.mjs): the TypeScript source is
 * transpiled in-memory with the repo's own typescript dep - no browser needed.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// ---- tiny CJS-in-memory loader (stamina.ts has no imports) ----
function loadModule(filePath) {
  const cjs = ts.transpileModule(SRC(filePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', cjs)(
    () => { throw new Error('unexpected import'); },
    module,
    module.exports,
  );
  return module.exports;
}

const {
  Stamina,
  STAMINA_DRAIN_RATE, STAMINA_REGEN_RATE,
  BREATH_RATE_MUL_MAX, STRIDE_INTENSITY_MIN, FOV_PULSE_AMP_MAX,
} = loadModule('src/player/stamina.ts');

const DT = 1 / 60;
let n = 0;
const test = (name, fn) => { n++; fn(); console.log('ok  ' + name); };

test('fresh instance: level 1, outputs at their fresh bounds', () => {
  const s = new Stamina();
  assert.equal(s.level, 1);
  assert.equal(s.breathRateMul, 1);
  assert.equal(s.strideIntensity, 1);
  assert.equal(s.fovPulseAmp, 0);
});

test('sprinting drains at STAMINA_DRAIN_RATE', () => {
  const s = new Stamina();
  const secs = 1;
  for (let i = 0; i < Math.round(secs / DT); i++) s.update(DT, { sprinting: true });
  assert.ok(Math.abs(s.level - (1 - secs * STAMINA_DRAIN_RATE)) < 1e-9,
    'level=' + s.level);
});

test('AC sweep 100%->20%: all three outputs move monotonically', () => {
  const s = new Stamina();
  // sample the sweep on a fixed checkpoint ladder from 100% down to 20%
  const checkpoints = [];
  for (let i = 0; i <= 16; i++) checkpoints.push(+(1 - i * 0.05).toFixed(10)); // 1.0 ... 0.2
  const breath = [], stride = [], fov = [];
  for (const target of checkpoints) { // already descending 1.0 -> 0.2
    while (s.level > target + 1e-6) s.update(Math.min(DT, s.level - target), { sprinting: true });
    near2(s.level, target);
    breath.push(s.breathRateMul);
    stride.push(s.strideIntensity);
    fov.push(s.fovPulseAmp);
  }
  monotone('breathRateMul nondecreasing while fatiguing', breath, +1);
  monotone('strideIntensity nonincreasing while fatiguing', stride, -1);
  monotone('fovPulseAmp nondecreasing while fatiguing', fov, +1);
  assert.ok(Math.abs(checkpoints[checkpoints.length - 1] - 0.2) < 1e-9, 'sweep covered 100->20');
});

test('recovering on rest moves every output back toward fresh bounds monotonically', () => {
  const s = new Stamina();
  drainTo(s, 0.2);
  const breath = [], stride = [], fov = [], levels = [];
  for (let i = 0; i < Math.ceil(1 / DT); i++) {
    s.update(DT, { sprinting: false });
    levels.push(s.level);
    breath.push(s.breathRateMul);
    stride.push(s.strideIntensity);
    fov.push(s.fovPulseAmp);
  }
  monotone('level rises on rest', levels, +1);
  monotone('breathRateMul falls on rest', breath, -1);
  monotone('strideIntensity rises on rest', stride, +1);
  monotone('fovPulseAmp falls on rest', fov, -1);
});

test('full recovery returns exactly to fresh values', () => {
  const s = new Stamina();
  drainTo(s, 0.05);
  for (let i = 0; i < Math.ceil(14 / DT); i++) s.update(DT, { sprinting: false });
  assert.equal(s.level, 1);
  assert.equal(s.breathRateMul, 1);
  assert.equal(s.strideIntensity, 1);
  assert.equal(s.fovPulseAmp, 0);
});

test('walking/idle never drains below the current level', () => {
  const s = new Stamina();
  drainTo(s, 0.5);
  for (let i = 0; i < 120; i++) s.update(DT, { sprinting: false });
  assert.ok(s.level >= 0.5, 'rest must not reduce level');
});

test('clamp bounds: level pinned to [0,1], outputs stay inside documented bounds', () => {
  const s = new Stamina();
  for (let i = 0; i < Math.ceil(20 / DT); i++) s.update(10, { sprinting: true });
  assert.equal(s.level, 0);
  assert.equal(s.breathRateMul, BREATH_RATE_MUL_MAX);
  assert.equal(s.strideIntensity, STRIDE_INTENSITY_MIN);
  assert.equal(s.fovPulseAmp, FOV_PULSE_AMP_MAX);
  for (let i = 0; i < Math.ceil(20 / DT); i++) s.update(10, { sprinting: false });
  assert.equal(s.level, 1);
  assert.equal(s.breathRateMul, 1);
  assert.equal(s.strideIntensity, 1);
  assert.equal(s.fovPulseAmp, 0);
});

test('regen rate matches STAMINA_REGEN_RATE', () => {
  const s = new Stamina();
  drainTo(s, 0.5);
  for (let i = 0; i < Math.round(1 / DT); i++) s.update(DT, { sprinting: false });
  assert.ok(Math.abs(s.level - (0.5 + 1 * STAMINA_REGEN_RATE)) < 1e-6,
    'level=' + s.level);
});

// ---- helpers ----

function near2(a, b) {
  assert.ok(Math.abs(a - b) <= 5e-3, `${a} !~= ${b}`);
}

function drainTo(s, target) {
  while (s.level > target + 1e-6) {
    s.update(Math.min(DT, s.level - target), { sprinting: true });
  }
}

/** dir=+1 asserts nondecreasing, dir=-1 asserts nonincreasing. */
function monotone(name, seq, dir) {
  for (let i = 1; i < seq.length; i++) {
    const d = (seq[i] - seq[i - 1]) * dir;
    assert.ok(d >= -1e-12, `${name}: step ${i} moved wrong way (${seq[i - 1]} -> ${seq[i]})`);
  }
}

console.log('ok  ' + n + ' stamina tests passed');
process.exit(0);
