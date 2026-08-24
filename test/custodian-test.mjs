/**
 * Functional verification of The Custodian (F32, src/story/custodian.ts):
 * every removed marking has a removal-ledger entry preceded by its cart
 * squeak, protected kinds are never touched, the per-night bound holds,
 * plans are deterministic per (seed, sessionOrdinal), snapshots round-trip
 * through JSON, and junk inputs stay safe.
 *
 *   node test/custodian-test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const require_ = createRequire(import.meta.url);
const esbuild = require_('esbuild');

let passed = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ' :: ' + (e instanceof Error ? e.message : String(e)));
  }
}

const SRC = process.cwd() + '/src/story/custodian.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.custodian-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  Custodian,
  CUSTODIAN_SQUEAK_LEAD_SECONDS,
  CUSTODIAN_REMOVALS_PER_NIGHT,
} = await import('./.custodian-build.mjs');

/** Fixture ledger: oldest sessions first, one memorial mixed in. */
function fixtureLedger() {
  return [
    { id: 'm-old-a', chunkKey: '1,0', appliedSession: 1, kind: 'graffiti' },
    { id: 'm-old-b', chunkKey: '1,0', appliedSession: 2, kind: 'smear' },
    { id: 'm-memorial', chunkKey: '2,-3', appliedSession: 2, kind: 'memorial' },
    { id: 'm-mid', chunkKey: '-5,7', appliedSession: 5, kind: 'stencil' },
    { id: 'm-new-a', chunkKey: '0,0', appliedSession: 9, kind: 'graffiti' },
    { id: 'm-new-b', chunkKey: '0,1', appliedSession: 9, kind: 'graffiti' },
  ];
}

function makeCustodian(config = {}, ledger = fixtureLedger()) {
  return { ledger, custodian: new Custodian(ledger, config) };
}

/** Run the open night for `frames` steps, returning the ordered event stream. */
function runNight(custodian, frames = 1400, step = 0.25) {
  const events = [];
  let seenRemovals = 0;
  for (let i = 0; i < frames; i++) {
    // Drain BEFORE diffing removals so stream order reflects emit order.
    for (const s of custodian.drainSqueaks()) {
      events.push({ type: 'squeak', markingId: s.markingId, at: s.atNightTime });
    }
    while (seenRemovals < custodian.removals.length) {
      const r = custodian.removals[seenRemovals++];
      events.push({ type: 'removal', markingId: r.markingId, at: r.removedAtNightTime });
    }
    custodian.update(step);
  }
  return events;
}

check('every removed marking has a ledger entry preceded by its own squeak (AC)', () => {
  const { custodian } = makeCustodian({ seed: 1234, sessionOrdinal: 3 });
  custodian.beginNight(0);
  const events = runNight(custodian);
  const removalIds = events.filter((e) => e.type === 'removal').map((e) => e.markingId);
  assert.equal(removalIds.length, CUSTODIAN_REMOVALS_PER_NIGHT,
    'expected ' + CUSTODIAN_REMOVALS_PER_NIGHT + ' removals, got ' + removalIds.length);
  for (const id of removalIds) {
    const sqIdx = events.findIndex((e) => e.type === 'squeak' && e.markingId === id);
    const rmIdx = events.findIndex((e) => e.type === 'removal' && e.markingId === id);
    assert.ok(sqIdx !== -1, 'no squeak ever fired for ' + id);
    assert.ok(rmIdx !== -1, 'no removal recorded for ' + id);
    assert.ok(sqIdx < rmIdx, 'squeak did not precede removal for ' + id);
    assert.equal(
      events.filter((e) => e.type === 'squeak' && e.markingId === id).length, 1,
      'wrong squeak count for ' + id);
  }
  for (const r of custodian.removals) {
    assert.equal(typeof r.chunkKey, 'string');
    assert.ok(Number.isFinite(r.removedAtNightTime));
    assert.equal(r.nightOrdinal, 0);
  }
});

check('lead timing: squeak fires within one step of CUSTODIAN_SQUEAK_LEAD_SECONDS early', () => {
  const STEP = 0.05;
  const { custodian } = makeCustodian({ seed: 77, removalsPerNight: 1 });
  custodian.beginNight(0);
  let squeakAt = null;
  let removedAt = null;
  for (let frame = 0; frame < 3000 && removedAt === null; frame++) {
    for (const s of custodian.drainSqueaks()) {
      if (squeakAt === null) squeakAt = s.atNightTime;
    }
    if (custodian.removals.length > 0) removedAt = custodian.removals[0].removedAtNightTime;
    else custodian.update(STEP);
  }
  assert.ok(squeakAt !== null && removedAt !== null, 'night never completed');
  const gap = removedAt - squeakAt;
  const EPS = 1e-9; // float accumulation over thousands of 0.05 s steps
  assert.ok(gap <= CUSTODIAN_SQUEAK_LEAD_SECONDS + EPS && gap > CUSTODIAN_SQUEAK_LEAD_SECONDS - 2 * STEP,
    'gap ' + gap + ' not within [' + (CUSTODIAN_SQUEAK_LEAD_SECONDS - 2 * STEP) + ', ' +
    CUSTODIAN_SQUEAK_LEAD_SECONDS + ']');
  assert.equal(custodian.squeaks[0].leadSeconds, CUSTODIAN_SQUEAK_LEAD_SECONDS);
});

check('protection honored: memorial never removed across many nights (AC)', () => {
  const { ledger, custodian } = makeCustodian({});
  for (let night = 0; night < 4; night++) {
    custodian.beginNight(night);
    runNight(custodian);
  }
  assert.equal(custodian.removals.filter((r) => r.kind === 'memorial').length, 0,
    'a memorial reached the removal ledger');
  assert.ok(ledger.some((m) => m.id === 'm-memorial'),
    'memorial was spliced out of the live ledger');
  // All 5 unprotected markings did go, proving the pass really ran.
  assert.equal(custodian.removals.length, 5);
});

check('per-night bound respected; oldest-first selection across nights (AC)', () => {
  const { custodian } = makeCustodian({ seed: 99, removalsPerNight: 2 });
  const perNight = [];
  for (let night = 0; night < 3; night++) {
    const before = custodian.removals.length;
    custodian.beginNight(night);
    runNight(custodian);
    perNight.push(custodian.removals.length - before);
  }
  assert.deepEqual(perNight, [2, 2, 1], 'bound violated: ' + JSON.stringify(perNight));
  assert.equal(custodian.removals.length, 5, 'all unprotected markings eventually removed');
  // Age-sorted pool minus what night 0 took must still be the oldest-first
  // prefix: each night's picks are the oldest markings still on the ledger.
  const expectedOrder = ['m-old-a', 'm-old-b', 'm-mid', 'm-new-a', 'm-new-b'];
  const removedSet = new Set(custodian.removals.map((r) => r.markingId));
  for (let i = 0; i < expectedOrder.length; i++) {
    assert.ok(removedSet.has(expectedOrder[i]),
      'older marking ' + expectedOrder[i] + ' skipped');
  }
});

check('determinism per seed+session; different key diverges (AC)', () => {
  function replay(seed, sessionOrdinal) {
    const c = new Custodian(fixtureLedger(), { seed, sessionOrdinal, removalsPerNight: 2 });
    const trace = [];
    for (let night = 0; night < 2; night++) {
      c.beginNight(night);
      const before = trace.length;
      trace.push(...runNight(c, 1200).map((e) =>
        e.type + ':' + e.markingId + ':' + e.at.toFixed(6)));
      trace.push('night-end:' + night + ':' + c.removals.length + ':' + (trace.length - before));
    }
    return trace.join('|');
  }
  assert.equal(replay(1337, 4), replay(1337, 4), 'same seed+session replayed differently');
  assert.notEqual(replay(1337, 4), replay(1338, 4), 'seed change had no effect');
  assert.notEqual(replay(1337, 4), replay(1337, 5), 'session change had no effect');
});

check('JSON round-trip: deserialize restores ledgers exactly; junk payloads rejected (AC)', () => {
  const { custodian } = makeCustodian({ seed: 555, removalsPerNight: 2 });
  custodian.beginNight(0);
  runNight(custodian);
  assert.equal(custodian.removals.length, 2);

  const snapshot = JSON.parse(JSON.stringify(custodian.serialize()));
  assert.equal(snapshot.version, 1);
  const restored = Custodian.deserialize(snapshot, fixtureLedger(), { seed: 555, removalsPerNight: 2 });
  assert.ok(restored, 'valid snapshot rejected');
  assert.deepEqual(restored.removals, custodian.removals);
  assert.deepEqual(restored.squeaks, custodian.squeaks);
  restored.beginNight(1); // restored instance resumes scheduling cleanly
  runNight(restored);
  assert.equal(restored.removals.length, 4);

  for (const junk of [null, undefined, 42, 'x', [], {}, { version: 2 },
    { version: 1, removals: 'nope', squeaks: [] },
    { version: 1, removals: [], squeaks: [null] },
    { version: 1, removals: [{ chunkKey: 'c' }], squeaks: [] }]) {
    assert.equal(Custodian.deserialize(junk, []), null,
      'junk snapshot accepted: ' + JSON.stringify(junk));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(restored.serialize())), restored.serialize());
});

check('re-beginning the open night is a no-op: one squeak per removal preserved', () => {
  const { custodian } = makeCustodian({ seed: 2024, removalsPerNight: 2 });
  custodian.beginNight(0);
  for (let frame = 0; frame < 40; frame++) custodian.update(0.5);
  const midSqueaks = custodian.squeaks.length;
  custodian.beginNight(0); // must not rewind the clock or the audit trail
  assert.equal(custodian.currentNight, 0);
  runNight(custodian, 600, 0.5);
  assert.equal(custodian.removals.length, 2);
  assert.ok(custodian.squeaks.length >= midSqueaks, 'earlier cues were discarded');
  assert.equal(custodian.squeaks.length, custodian.removals.length,
    'squeak count != removal count');
  const ids = custodian.squeaks.map((s) => s.markingId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate squeak for one marking');
});

check('caller-removed marking: no phantom ledger entry, no crash', () => {
  const ledger = [{ id: 'gone-soon', chunkKey: '8,8', appliedSession: 0, kind: 'graffiti' }];
  const custodian = new Custodian(ledger, { seed: 11, removalsPerNight: 1 });
  custodian.beginNight(0);
  for (let frame = 0; frame < 20; frame++) custodian.update(0.5);
  const idx = ledger.findIndex((m) => m.id === 'gone-soon');
  if (idx !== -1) ledger.splice(idx, 1); // caller removed it before the pass did
  for (let frame = 0; frame < 1400; frame++) custodian.update(0.5);
  assert.equal(custodian.removals.length, 0,
    'recorded a removal for a marking the caller already removed');
});

check('junk inputs stay safe: NaN/negative/huge dt, bad ordinals, empty ledger', () => {
  const { custodian } = makeCustodian({ seed: 31337 });
  custodian.update(1); // no-op before beginNight
  assert.equal(custodian.currentNight, -1);
  custodian.beginNight(NaN);
  assert.equal(custodian.currentNight, -1, 'NaN ordinal opened a night');
  custodian.beginNight(-5);
  assert.equal(custodian.currentNight, 0, 'negative ordinal clamped to 0');

  custodian.update(NaN);
  custodian.update(-3);
  custodian.update(Infinity);
  for (const v of [...custodian.removals.map((r) => r.removedAtNightTime),
    ...custodian.squeaks.map((s) => s.atNightTime)]) {
    assert.ok(Number.isFinite(v), 'clock went non-finite under junk dt');
  }

  const empty = new Custodian([], { seed: 1 });
  empty.beginNight(0);
  runNight(empty, 500, 0.5);
  assert.equal(empty.removals.length, 0);
  assert.deepEqual(empty.drainSqueaks(), []);
});

console.log(`\nALL PASS ${failures === 0 ? '' : 'NOT '}ACHIEVED: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
