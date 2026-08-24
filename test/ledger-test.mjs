/**
 * Functional verification of the F46 expedition ledger (src/save/ledger.ts):
 * round-trip through injected { get, set } storage, idempotent merge per
 * (expeditionId, entryId), summary math on fixture archives, and graceful
 * (non-throwing) rejection of foreign/corrupt storage payloads.
 *
 *   node test/ledger-test.mjs
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

const SRC = process.cwd() + '/src/save/ledger.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.ledger-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  LEDGER_VERSION,
  LEDGER_STORAGE_KEY,
  createLedger,
  validateLedger,
  loadLedger,
  saveLedger,
  mergeExpedition,
  summarize,
} = await import('./.ledger-build.mjs');

/** Map-backed storage stub with the injected { get, set } surface. */
function makeStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

const entry = (id, kind, refId, rarity, discoveredAt) =>
  ({ entryId: id, kind, refId, rarity, ...(discoveredAt !== undefined ? { discoveredAt } : {}) });

/* ------------------------------------------------------------------ */
/* Storage round-trip                                                   */
/* ------------------------------------------------------------------ */

check('save -> load round-trips deep-identically through storage', () => {
  const storage = makeStorage();
  let l = createLedger();
  l = mergeExpedition(l, 'exp-1', [
    entry('n1', 'note', 'note.arc1.007', 2, 1000),
    entry('c1', 'cluster', 'cluster.chapel', 3, 2000),
  ]);
  saveLedger(storage, l);
  const res = loadLedger(storage);
  assert.ok(res.ok, 'load failed: ' + JSON.stringify(res));
  assert.deepStrictEqual(res.ledger, l);
});

check('stored value is a plain JSON-safe clone (no aliasing)', () => {
  const storage = makeStorage();
  let l = createLedger();
  l = mergeExpedition(l, 'exp-1', [entry('n1', 'note', 'r', 0)]);
  saveLedger(storage, l);
  l.expeditions['exp-1'][0].rarity = 99; // mutate caller copy afterwards
  assert.equal(loadLedger(storage).ledger.expeditions['exp-1'][0].rarity, 0,
    'storage aliased caller state');
});

check('merging does not mutate the input archive', () => {
  const l = createLedger();
  const merged = mergeExpedition(l, 'e', [entry('a', 'note', 'x', 1)]);
  assert.deepEqual(l.expeditions, {});
  assert.equal(merged.expeditions.e.length, 1);
});

/* ------------------------------------------------------------------ */
/* Merge idempotence                                                    */
/* ------------------------------------------------------------------ */

check('double merge is a no-op', () => {
  const entries = [
    entry('n1', 'note', 'ref-a', 1, 10),
    entry('n2', 'note', 'ref-b', 2, 20),
    entry('c1', 'cluster', 'cluster-x', 3, 30),
  ];
  const once = mergeExpedition(createLedger(), 'exp-9', entries);
  const twice = mergeExpedition(once, 'exp-9', entries);
  assert.deepStrictEqual(twice, once);
  // Also idempotent against a freshly loaded archive.
  const storage = makeStorage();
  saveLedger(storage, once);
  const reloaded = loadLedger(storage).ledger;
  assert.deepStrictEqual(mergeExpedition(reloaded, 'exp-9', entries), reloaded);
});

check('conflicting duplicate keeps first-recorded version', () => {
  let l = createLedger();
  l = mergeExpedition(l, 'e', [entry('n1', 'note', 'original', 1)]);
  l = mergeExpedition(l, 'e', [entry('n1', 'note', 'REWRITTEN', 3)]);
  assert.equal(l.expeditions.e.length, 1);
  assert.equal(l.expeditions.e[0].refId, 'original');
  assert.equal(l.expeditions.e[0].rarity, 1);
});

check('distinct expeditions accumulate independently', () => {
  let l = createLedger();
  l = mergeExpedition(l, 'run-1', [entry('n1', 'note', 'a', 0, 5)]);
  l = mergeExpedition(l, 'run-2', [entry('n1', 'note', 'a', 0, 500)]);
  assert.equal(Object.keys(l.expeditions).length, 2);
  // Same entryId in another expedition is NOT a duplicate.
  assert.equal(summarize(l).totalEntries, 2);
});

/* ------------------------------------------------------------------ */
/* Summary math on fixtures                                             */
/* ------------------------------------------------------------------ */

check('summary counts are correct on a fixture archive', () => {
  let l = createLedger();
  l = mergeExpedition(l, 'run-1', [
    entry('n1', 'note', 'arc1.n7', 1, 100),
    entry('n2', 'note', 'arc2.n3', 3, 400),
    entry('c1', 'cluster', 'chapel', 2, 900),
  ]);
  l = mergeExpedition(l, 'run-2', [
    entry('n3', 'note', 'arc1.n1', 0, 50),
    entry('c2', 'cluster', 'poolrooms', 3, 1200),
  ]);
  l = mergeExpedition(l, 'run-3', []); // empty expedition doesn't count
  const s = summarize(l);
  assert.equal(s.expeditionCount, 2);
  assert.equal(s.noteCount, 3);
  assert.equal(s.clusterCount, 2);
  assert.equal(s.totalEntries, 5);
  assert.equal(s.firstDiscovery.entryId, 'n3', 'earliest discoveredAt wins');
  assert.equal(s.rarestNote.entryId, 'n2', 'max rarity note wins');
  assert.equal(s.rarestCluster.entryId, 'c2', 'max rarity cluster wins');
});

check('summary tie-breaks are deterministic', () => {
  let l = createLedger();
  l = mergeExpedition(l, 'run-1', [
    entry('b', 'note', 'x', 2, 100),
    entry('a', 'note', 'y', 2, 100), // same rarity AND time
  ]);
  const s = summarize(l);
  assert.equal(s.firstDiscovery.entryId, 'a', 'lexicographic fallback');
  assert.equal(s.rarestNote.entryId, 'a');
});

check('summary of an empty ledger is all-zero/null', () => {
  const s = summarize(createLedger());
  assert.deepEqual(
    { ...s },
    {
      expeditionCount: 0, noteCount: 0, clusterCount: 0, totalEntries: 0,
      firstDiscovery: null, rarestNote: null, rarestCluster: null,
    },
  );
});

/* ------------------------------------------------------------------ */
/* Version guard / hostile payloads — documented result, never throw    */
/* ------------------------------------------------------------------ */

check('missing key loads as ok:false missing', () => {
  const res = loadLedger(makeStorage());
  assert.deepEqual(res, { ok: false, reason: 'missing' });
});

check('foreign version is rejected gracefully', () => {
  const res = loadLedger(makeStorage({ [LEDGER_STORAGE_KEY]: { version: LEDGER_VERSION + 1, expeditions: {} } }));
  assert.deepEqual(res, { ok: false, reason: 'foreign-version' });
  const legacy = loadLedger(makeStorage({ [LEDGER_STORAGE_KEY]: { version: 0, expeditions: {} } }));
  assert.equal(legacy.reason, 'foreign-version');
  // String-encoded future archive too.
  const str = loadLedger(makeStorage({
    [LEDGER_STORAGE_KEY]: JSON.stringify({ version: 999, expeditions: {} }),
  }));
  assert.equal(str.reason, 'foreign-version');
});

check('corrupt and malformed payloads are rejected gracefully', () => {
  assert.equal(loadLedger(makeStorage({ [LEDGER_STORAGE_KEY]: '{broken' })).reason, 'unparseable');
  assert.equal(loadLedger(makeStorage({ [LEDGER_STORAGE_KEY]: 12345 })).reason, 'unparseable');
  assert.equal(loadLedger(makeStorage({ [LEDGER_STORAGE_KEY]: 'null' })).reason, 'unparseable');
  // Right version, wrong innards.
  assert.equal(loadLedger(makeStorage({
    [LEDGER_STORAGE_KEY]: { version: LEDGER_VERSION, expeditions: 'nope' },
  })).reason, 'malformed');
  assert.equal(loadLedger(makeStorage({
    [LEDGER_STORAGE_KEY]: { version: LEDGER_VERSION, expeditions: { e: [{ entryId: 4 }] } },
  })).reason, 'malformed');
});

check('validateLedger accepts only well-formed archives', () => {
  assert.equal(validateLedger(null), null);
  assert.equal(validateLedger([]), null);
  assert.equal(validateLedger({ version: LEDGER_VERSION }), null);
  const good = createLedger();
  assert.deepStrictEqual(validateLedger(good), good);
});

console.log(`\nLEDGER_TEST ${failures === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
