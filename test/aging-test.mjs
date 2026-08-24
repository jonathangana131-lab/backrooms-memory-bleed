/**
 * Aging-corridor tests (F24).
 *
 * Proves the AC: stage is monotone non-decreasing with visit count and
 * bounded by AGING_MAX_STAGE even for adversarial inputs; identical inputs
 * produce identical stage + decor params across instances; the ledger
 * serializes and deserializes to an identical ledger; and malformed save
 * payloads fail loud.
 *
 * Run: node test/aging-test.mjs  (transpiles TS in-memory like blackoutdeltas-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-aging-'));
fsMod.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fsMod.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}

emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/aging.ts', 'src/world/aging.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const { decayStage, AgingLedger, AGING_MAX_STAGE } =
  await import(path.join(tmp, 'src/world/aging.mjs'));

const SEED = 0x4a9e11;
const KEYS = ['0,0', '3,-2', '-7,12', '1000,1000', 'chunk-with-a-long-name'];

// ---- AC: stage monotone non-decreasing in visits ------------------------------

test('stage never decreases as visits grow', () => {
  for (const key of KEYS) {
    let prev = -1;
    for (let v = 0; v <= 80; v++) {
      const { stage } = decayStage(key, v, SEED);
      assert.ok(stage >= prev, `${key}: stage dropped ${prev} -> ${stage} at visits=${v}`);
      prev = stage;
    }
  }
});

test('decor multipliers are monotone per corridor alongside stage', () => {
  for (const key of KEYS) {
    let prevCrack = 1;
    let prevStain = 0;
    for (let v = 0; v <= 60; v++) {
      const p = decayStage(key, v, SEED);
      assert.ok(p.crackDensityMul >= prevCrack - 1e-9, `${key} crack regressed at ${v}`);
      assert.ok(p.stainSpreadFactor >= prevStain - 1e-9, `${key} stain regressed at ${v}`);
      prevCrack = Math.max(prevCrack, p.crackDensityMul);
      prevStain = Math.max(prevStain, p.stainSpreadFactor);
    }
  }
});

// ---- AC: bounded max stage ------------------------------------------------------

test('stage bounded by AGING_MAX_STAGE under adversarial visit counts', () => {
  for (const key of KEYS) {
    for (const v of [1e6, 1e9, Number.MAX_SAFE_INTEGER]) {
      const { stage } = decayStage(key, v, SEED);
      assert.ok(stage >= 0 && stage <= AGING_MAX_STAGE, `stage ${stage} out of range`);
    }
    // Negative / fractional garbage clamps instead of misbehaving:
    assert.deepEqual(decayStage(key, -5, SEED), decayStage(key, 0, SEED));
    assert.equal(decayStage(key, 7.9, SEED).stage, decayStage(key, 7, SEED).stage);
    assert.deepEqual(decayStage(key, NaN, SEED), decayStage(key, 0, SEED));
  }
});

test('every corridor eventually reaches max stage within a sane revisit budget', () => {
  for (const key of KEYS) {
    let reached = Infinity;
    for (let v = 0; v <= 40; v++) {
      if (decayStage(key, v, SEED).stage === AGING_MAX_STAGE) { reached = v; break; }
    }
    assert.ok(reached <= 40, `${key} never aged to max within 40 revisits`);
  }
});

// ---- AC: same inputs -> identical outputs across instances ---------------------

test('determinism: identical (key, visits, seed) give deep-equal params everywhere', () => {
  for (const key of KEYS) {
    for (const v of [0, 1, 3, 9, 25]) {
      const a = decayStage(key, v, SEED);
      const b = decayStage(key, v, SEED);
      assert.deepEqual(a, b);
      assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    }
  }
  // Different seeds age the same corridor differently:
  const seen = new Set();
  for (let seed = 0; seed < 6; seed++) seen.add(JSON.stringify(decayStage(KEYS[0], 4, seed)));
  assert.ok(seen.size > 1, 'seed must influence decay params');
});

// ---- AC: serialize/deserialize identical ----------------------------------------

test('ledger round-trips through plain JSON identically', () => {
  const a = new AgingLedger();
  for (const key of KEYS) {
    const n = key.length % 7 + 1;
    for (let i = 0; i < n; i++) a.recordVisit(key);
  }
  const json = a.toJSON();
  const b = AgingLedger.fromJSON(json);
  assert.equal(json, b.toJSON(), 'serialization not byte-identical after round-trip');
  for (const key of KEYS) {
    for (const seed of [SEED, 99]) {
      assert.deepEqual(a.stageOf(key, seed), b.stageOf(key, seed));
      assert.equal(a.visitCount(key), b.visitCount(key));
    }
  }
  // Fresh ledger is valid JSON and empty:
  const fresh = new AgingLedger();
  assert.equal(fresh.size, 0);
  assert.equal(fresh.stageOf('0,0', SEED).stage, 0);
  assert.deepEqual(AgingLedger.fromJSON(fresh.toJSON()).toJSON(), fresh.toJSON());
});

test('ledger drives stages through recordVisit like sessions would', () => {
  const led = new AgingLedger();
  const stages = [];
  for (let i = 0; i < 30; i++) {
    led.recordVisit('5,5');
    stages.push(led.stageOf('5,5', SEED).stage);
  }
  for (let i = 1; i < stages.length; i++) {
    assert.ok(stages[i] >= stages[i - 1], 'ledger-driven stage regressed');
  }
});

// ---- persistence fails loud on malformed payloads --------------------------------

test('fromJSON rejects malformed envelopes and entries', () => {
  assert.throws(() => AgingLedger.fromJSON('not json'), Error);
  assert.throws(() => AgingLedger.fromJSON('{}'), Error);
  assert.throws(() => AgingLedger.fromJSON('{"formatVersion":2,"visits":[]}'), Error);
  assert.throws(() => AgingLedger.fromJSON('{"formatVersion":1,"visits":[["0,0"]]}'), Error);
  assert.throws(() => AgingLedger.fromJSON('{"formatVersion":1,"visits":[["0,0","lots"]]}'), Error);
});
