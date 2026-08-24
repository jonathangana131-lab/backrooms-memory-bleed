/**
 * Functional verification of New Game+ (F45, src/story/ngplus.ts):
 * ghost-markings carry valid hash-matched provenance, no archive means no
 * ghosts, double import is a no-op, corrupt/foreign archives degrade to an
 * empty import without throwing, and selection is deterministic per
 * (seed, runId) with the per-run cap respected.
 *
 *   node test/ngplus-test.mjs
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

const SRC = process.cwd() + '/src/story/ngplus.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.ngplus-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  NGPLUS_VERSION,
  NGPLUS_ARCHIVE_KEY,
  NGPLUS_IMPORTED_KEY,
  NGPLUS_GHOSTS_PER_RUN,
  validateArchive,
  loadArchive,
  archiveGraffiti,
  newRun,
  contentHashOf,
} = await import('./.ngplus-build.mjs');

/** Map-backed storage stub with the injected { get, set } surface. */
function makeStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

/** Same FNV-1a the rng module uses; recomputed here to verify provenance. */
function fnv(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A pool of archived graffiti big enough for selection to vary by seed. */
function seededArchive(runCount = 4, perRun = 4) {
  const storage = makeStorage();
  for (let r = 0; r < runCount; r++) {
    archiveGraffiti(storage, 'run-' + r, Array.from({ length: perRun }, (_, i) => ({
      entryId: 'e' + i,
      chunkKey: (r - 2) + ',' + i,
      content: 'the walls remember ' + r + ':' + i,
    })));
  }
  return storage;
}

check('ghost provenance is valid and hash-matched on every ghost marking (AC)', () => {
  const storage = seededArchive();
  const ghosts = newRun(storage, 12345, 'fresh-1');
  assert.equal(ghosts.length, NGPLUS_GHOSTS_PER_RUN);
  for (const g of ghosts) {
    assert.match(g.id, /^ngplus-[0-9a-f]+/);
    assert.equal(g.kind, 'graffiti');
    assert.equal(typeof g.chunkKey, 'string');
    assert.equal(typeof g.content, 'string');
    assert.ok(g.provenance && typeof g.provenance.priorRunId === 'string' &&
      g.provenance.priorRunId.length > 0, 'missing priorRunId');
    assert.ok(Number.isInteger(g.provenance.contentHash) &&
      g.provenance.contentHash >= 0, 'contentHash not a uint32');
    assert.equal(g.provenance.contentHash >>> 0, fnv(g.content),
      'contentHash does not match content');
    assert.equal(g.provenance.contentHash >>> 0, contentHashOf(g.content));
  }
  // ghost ids unique within the run
  assert.equal(new Set(ghosts.map((g) => g.id)).size, ghosts.length);
});

check('no archive -> no ghost markings (AC)', () => {
  assert.deepEqual(newRun(makeStorage(), 7, 'run-a'), []);
  // empty-but-valid archive also yields none
  const empty = makeStorage();
  archiveGraffiti(empty, 'run-z', []);
  assert.deepEqual(newRun(empty, 7, 'run-b'), []);
});

check('double import is a no-op: same run id never re-surfaces or duplicates (AC)', () => {
  const storage = seededArchive(2, 3);
  const first = newRun(storage, 99, 'run-x');
  assert.ok(first.length > 0);
  const beforeDump = JSON.stringify(storage.dump());
  const second = newRun(storage, 99, 'run-x');
  assert.deepEqual(second, [], 'second newRun for the same run id imported again');
  assert.equal(JSON.stringify(storage.dump()), beforeDump,
    'storage mutated by a no-op import');
  // a DIFFERENT importing run still sees the archive
  const other = newRun(makeStorage(JSON.parse(beforeDump)), 99, 'run-y');
  assert.ok(other.length > 0);
});

check('corrupt/foreign/unreadable archive degrades to graceful empty (AC)', () => {
  const cases = [
    { [NGPLUS_ARCHIVE_KEY]: '{"version": broken' },          // unparseable string
    { [NGPLUS_ARCHIVE_KEY]: null },
    { [NGPLUS_ARCHIVE_KEY]: 42 },
    { [NGPLUS_ARCHIVE_KEY]: [] },
    { [NGPLUS_ARCHIVE_KEY]: { version: 999, graffiti: [] } }, // foreign version
    { [NGPLUS_ARCHIVE_KEY]: { version: NGPLUS_VERSION, graffiti: 'nope' } },
    { [NGPLUS_ARCHIVE_KEY]: { version: NGPLUS_VERSION, graffiti: [{ entryId: 4 }] } },
    { [NGPLUS_ARCHIVE_KEY]: { version: NGPLUS_VERSION, graffiti: [{ runId: '', entryId: 'e', chunkKey: 'c', content: 'x' }] } },
  ];
  for (const initial of cases) {
    assert.doesNotThrow(() => newRun(makeStorage(initial), 5, 'run-c'));
    assert.deepEqual(newRun(makeStorage(initial), 5, 'run-c'), [],
      'non-empty import from corrupt archive: ' + JSON.stringify(initial));
  }
  // storage.get throwing must not take the run down either
  const hostile = { get() { throw new Error('storage gone'); }, set() {} };
  assert.deepEqual(newRun(hostile, 5, 'run-d'), []);
  assert.equal(loadArchive(hostile), null);
});

check('determinism per (seed, runId); different key changes selection (AC)', () => {
  const storage = seededArchive();
  function replay(seed, runId) {
    return JSON.stringify(newRun(makeStorage(JSON.parse(JSON.stringify(storage.dump()))), seed, runId));
  }
  assert.equal(replay(314, 'run-q'), replay(314, 'run-q'), '(seed, runId) not reproducible');
  let seedDiverged = false;
  let runDiverged = false;
  for (let s = 0; s < 12 && !seedDiverged; s++) seedDiverged = replay(s, 'run-q') !== replay(315, 'run-q');
  for (let s = 0; s < 12 && !runDiverged; s++) runDiverged = replay(s, 'run-' + s) !== replay(s, 'other-' + s);
  assert.ok(seedDiverged || runDiverged,
    'selection identical across every tested seed/runId pair');
});

check('per-run cap respected; all sources exhausted gracefully', () => {
  const small = makeStorage();
  archiveGraffiti(small, 'old-1', [
    { entryId: 'a', chunkKey: '1,1', content: 'first' },
    { entryId: 'b', chunkKey: '2,2', content: 'second' },
  ]);
  const few = newRun(small, 8, 'new-1');
  assert.equal(few.length, 2, 'should surface exactly what exists');
  assert.deepEqual(newRun(small, 8, 'new-1'), [], 'exhausted pool re-imported');

  const big = seededArchive(4, 10); // 40 entries, cap is NGPLUS_GHOSTS_PER_RUN
  assert.equal(newRun(big, 8, 'new-2').length, NGPLUS_GHOSTS_PER_RUN);
});

check('archiveGraffiti round-trips through storage; idempotent merge per (runId, entryId)', () => {
  const storage = makeStorage();
  archiveGraffiti(storage, 'r1', [
    { entryId: 'a', chunkKey: '0,0', content: 'hello' },
    { entryId: 'b', chunkKey: '1,0', content: 'goodbye' },
  ]);
  archiveGraffiti(storage, 'r1', [{ entryId: 'a', chunkKey: '0,0', content: 'CONFLICTING' }]);
  archiveGraffiti(storage, 'r2', [{ entryId: 'a', chunkKey: '9,9', content: 'other run' }]);

  const archive = loadArchive(storage);
  assert.ok(archive, 'archive failed validation after write');
  assert.equal(archive.version, NGPLUS_VERSION);
  assert.deepEqual(archive.graffiti.map((g) => g.runId + '/' + g.entryId + ':' + g.content),
    ['r1/a:hello', 'r1/b:goodbye', 'r2/a:other run'],
    'merge kept wrong versions or lost entries');
  // stored value is a deep clone: mutating read-back state cannot corrupt storage
  archive.graffiti.length = 0;
  assert.equal(loadArchive(storage).graffiti.length, 3);
  assert.throws(() => archiveGraffiti(storage, '', []), 'empty runId accepted');
  assert.equal(validateArchive(null), null);
});

console.log(`\nALL PASS ${failures === 0 ? '' : 'NOT '}ACHIEVED: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
