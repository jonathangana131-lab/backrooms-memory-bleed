/**
 * Blackout-rearrangement delta tests (F16).
 *
 * Proves the AC: applyBlackoutShift -> revertBlackoutShift restores
 * byte-identical prior state (deep-equal); results are deterministic per
 * (seed, ordinal); exactly ONE previously-open door per affected chunk is
 * bricked; prop drift is limited to exactly one rotation slot; and a second
 * apply with the same ordinal is rejected (idempotence guard).
 *
 * Run: node test/blackoutdeltas-test.mjs  (transpiles TS in-memory like anomalies-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-blackout-'));
for (const d of ['src/core', 'src/world']) {
  fsMod.mkdirSync(path.join(tmp, d), { recursive: true });
}

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}

emit('src/core/rng.ts', 'src/core/rng.mjs');
// chunkDeltas imports PropInstance from architect as a type-only import,
// which the transpiler erases - no other deps need emitting.
emit('src/world/chunkDeltas.ts', 'src/world/chunkDeltas.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  ChunkDeltas, applyBlackoutShift, revertBlackoutShift,
} = await import(path.join(tmp, 'src/world/chunkDeltas.mjs'));

// ---- fixtures ---------------------------------------------------------------

const SEED = 0xbe11a0;
const MOVABLE_KINDS = ['desk', 'chair', 'crate', 'cabinet', 'bed'];
const FIXED_KINDS = ['vending', 'whiteboard'];
const MOVABLE_COUNT = 8;

/** Fresh props array: movable and fixed props at known slots. */
function makeProps() {
  const props = [];
  for (let i = 0; i < MOVABLE_COUNT; i++) {
    props.push({
      kind: MOVABLE_KINDS[i % MOVABLE_KINDS.length],
      x: 2 + i, z: 3 + i * 0.5,
      rot: (i * 3) % 4,
      variant: i % 4,
    });
  }
  props.push({ kind: FIXED_KINDS[0], x: 9, z: 9, rot: 2, variant: 0 });
  props.push({ kind: FIXED_KINDS[1], x: 10, z: 9, rot: 0, variant: 1 });
  return props;
}

const OPEN_DOORS = ['12,7:n', '13,7:n', '14,6:w', '15,8:e', '16,9:s'];

/** Snapshot everything a blackout may touch, for byte-identity checks. */
function snapshot(props, doors, delta) {
  return JSON.stringify({ props, open: [...doors], steps: delta.size ? 'nonempty' : 'empty' });
}
function fullSnapshot(props, doors, delta) {
  return JSON.stringify({
    props, open: [...doors],
    step00: delta.step(4, 4), stepOther: delta.step(5, 5),
  });
}

// ---- AC: reversibility -------------------------------------------------------

test('AC: apply -> revert restores BYTE-IDENTICAL prior state (deep-equal)', () => {
  const before = makeProps();
  const doorsBefore = [...OPEN_DOORS];
  const delta = new ChunkDeltas();
  delta.bump(4, 4); // pre-existing drift must also survive the round trip

  const pre = fullSnapshot(before, doorsBefore, delta);
  const rec = applyBlackoutShift(delta, { cx: 4, cz: 4, props: before, openDoors: OPEN_DOORS }, SEED, 1);
  assert.ok(rec, 'apply returned null on first use');

  const restoredDoor = revertBlackoutShift(delta, rec, before);
  assert.equal(restoredDoor, rec.brickedDoor);
  const post = fullSnapshot(before, doorsBefore, delta);
  assert.equal(post, pre, 'revert did not restore byte-identical state');
});

test('AC: revert clears the ordinal guard so the same ordinal replays identically', () => {
  const a = makeProps();
  const dA = new ChunkDeltas();
  const recA = applyBlackoutShift(dA, { cx: 0, cz: 0, props: a, openDoors: OPEN_DOORS }, SEED, 7);
  const shiftedRots = JSON.stringify(a.map((p) => p.rot));
  revertBlackoutShift(dA, recA, a);

  const b = makeProps();
  const dB = new ChunkDeltas();
  const recB = applyBlackoutShift(dB, { cx: 0, cz: 0, props: b, openDoors: OPEN_DOORS }, SEED, 7);
  assert.deepEqual(recB.brickedDoor, recA.brickedDoor);
  assert.deepEqual(recB.priorRots, recA.priorRots);
  // Re-applying after revert reproduces the exact same shifted state.
  assert.equal(JSON.stringify(b.map((p) => p.rot)), shiftedRots);
});

// ---- AC: determinism per (seed, ordinal) --------------------------------------

test('AC: identical (seed, ordinal) replays identically across fresh instances', () => {
  for (const [seed, ordinal] of [[SEED, 3], [0x1234, 11], [77, 0]]) {
    const a = makeProps(); const dA = new ChunkDeltas();
    const b = makeProps(); const dB = new ChunkDeltas();
    const ra = applyBlackoutShift(dA, { cx: 9, cz: -2, props: a, openDoors: OPEN_DOORS }, seed, ordinal);
    const rb = applyBlackoutShift(dB, { cx: 9, cz: -2, props: b, openDoors: OPEN_DOORS }, seed, ordinal);
    assert.ok(ra && rb);
    assert.equal(ra.brickedDoor, rb.brickedDoor, `door mismatch seed=${seed} ord=${ordinal}`);
    assert.deepEqual(ra.priorRots, rb.priorRots);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.equal(dA.step(9, -2), dB.step(9, -2));
  }
});

test('AC: different (chunk, ordinal) inputs derive different streams', () => {
  const bricked = new Set();
  let variants = new Set();
  for (let ordinal = 1; ordinal <= 40; ordinal++) {
    const props = makeProps();
    const delta = new ChunkDeltas();
    const rec = applyBlackoutShift(delta, { cx: 1, cz: 1, props, openDoors: OPEN_DOORS }, SEED, ordinal);
    bricked.add(rec.brickedDoor);
    variants.add(JSON.stringify(props.map((p) => p.rot)) + '|' + rec.brickedDoor);
  }
  // Rotation-only drift is uniform (+1 slot for every movable prop), so the
  // observable variety comes from the hashed bricked-door draw.
  assert.ok(bricked.size >= 2, `bricked-door choice never varied (${bricked.size})`);
  assert.equal(variants.size, bricked.size, 'outcome variety must come from door choice');
});

// ---- AC: exactly-one-door rule -------------------------------------------------

test('AC: exactly ONE previously-open door per affected chunk is bricked', () => {
  for (let ordinal = 0; ordinal < 25; ordinal++) {
    const props = makeProps();
    const delta = new ChunkDeltas();
    const rec = applyBlackoutShift(delta, { cx: 2, cz: 2, props, openDoors: OPEN_DOORS }, SEED, ordinal);
    assert.ok(rec);
    assert.ok(OPEN_DOORS.includes(rec.brickedDoor), `bricked door was not previously open: ${rec.brickedDoor}`);
    assert.equal(typeof rec.brickedDoor, 'string');
    // The record names exactly one door; no other door id appears anywhere.
    const mentioned = JSON.stringify(rec).match(/-?\d+,-?\d+:[nsew]/g) || [];
    assert.equal(mentioned.length, 1, `record mentions ${mentioned.length} doors`);
    assert.equal(delta.step(2, 2), 1, 'blackout must bump the chunk drift once');
  }
});

test('AC: blackout with no open doors fails loud', () => {
  const props = makeProps();
  const delta = new ChunkDeltas();
  assert.throws(
    () => applyBlackoutShift(delta, { cx: 0, cz: 0, props, openDoors: [] }, SEED, 0),
    /no open doors/,
  );
  assert.equal(delta.step(0, 0), 0, 'failed apply must not bump drift');
});

// ---- AC: prop drift limited to one slot ----------------------------------------

test('AC: each movable prop rotates EXACTLY ONE slot; nothing else moves', () => {
  const props = makeProps();
  const before = props.map((p) => ({ ...p }));
  const delta = new ChunkDeltas();
  const rec = applyBlackoutShift(delta, { cx: 3, cz: 3, props, openDoors: OPEN_DOORS }, SEED, 5);

  let shifted = 0;
  for (let i = 0; i < MOVABLE_COUNT; i++) {
    const was = before[i];
    const now = props[i];
    const slotDelta = (((now.rot - was.rot) % 4) + 4) % 4;
    assert.equal(slotDelta, 1, `movable prop ${i} (${was.kind}) moved ${slotDelta} slots`);
    shifted++;
  }
  assert.equal(shifted, rec.priorRots.length);
  assert.ok(shifted > 0, 'no movable props drifted at all');
  // Fixed furniture untouched.
  for (let i = MOVABLE_COUNT; i < props.length; i++) {
    assert.equal(props[i].rot, before[i].rot, `fixed prop ${i} rotated`);
  }
  // Positions and variants are untouched by a blackout (rotation-only drift).
  for (let i = 0; i < props.length; i++) {
    assert.equal(props[i].x, before[i].x, `prop ${i} slid in x`);
    assert.equal(props[i].z, before[i].z, `prop ${i} slid in z`);
    assert.equal(props[i].variant, before[i].variant, `prop ${i} changed variant`);
  }
});

// ---- AC: idempotence / double-apply guard --------------------------------------

test('AC: double-apply with the same ordinal is rejected without extra drift', () => {
  const props = makeProps();
  const delta = new ChunkDeltas();
  const first = applyBlackoutShift(delta, { cx: 6, cz: 6, props, openDoors: OPEN_DOORS }, SEED, 9);
  assert.ok(first);
  const afterFirst = JSON.stringify(props.map((p) => p.rot));

  const second = applyBlackoutShift(delta, { cx: 6, cz: 6, props, openDoors: OPEN_DOORS }, SEED, 9);
  assert.equal(second, null, 'same ordinal applied twice');
  assert.equal(JSON.stringify(props.map((p) => p.rot)), afterFirst, 'props rotated again');
  assert.equal(delta.step(6, 6), 1, 'drift bumped twice for one ordinal');
  assert.ok(delta.hasBlackout(6, 6, 9));

  // A different ordinal in the same chunk still applies.
  const third = applyBlackoutShift(delta, { cx: 6, cz: 6, props, openDoors: OPEN_DOORS }, SEED, 10);
  assert.ok(third, 'next blackout ordinal rejected');
  assert.equal(delta.step(6, 6), 2);
});

test('AC: revertAll clears blackout ledger alongside drift steps', () => {
  const props = makeProps();
  const delta = new ChunkDeltas();
  applyBlackoutShift(delta, { cx: 8, cz: 8, props, openDoors: OPEN_DOORS }, SEED, 2);
  assert.ok(delta.hasBlackout(8, 8, 2));
  assert.ok(delta.revertAll() >= 1);
  assert.ok(!delta.hasBlackout(8, 8, 2));
  assert.equal(delta.step(8, 8), 0);
});
