/**
 * Functional verification of F44 save-file scarring (src/save/scarring.ts):
 * determinism per save id, route-prefix stability (a suffix only ADDS
 * cracks), density monotone in the age metric, hard bounds, and JSON
 * serialize round-trip identity.
 *
 *   node test/scarring-test.mjs
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

const SRC = process.cwd() + '/src/save/scarring.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.scarring-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  SCAR_CELL,
  ROUTE_BATCH,
  MAX_SCAR_CRACKS,
  MAX_CRACKS_PER_BATCH,
  MAX_POLYLINE_POINTS,
  scarBudget,
  computeScars,
  serializeScars,
  parseScars,
} = await import('./.scarring-build.mjs');

/* Synthetic route: a drifting walk through many cells. */
function makeRoute(n, seed = 7) {
  const out = [];
  let x = 3, z = -4;
  for (let i = 0; i < n; i++) {
    x += Math.sin(i * seed * 0.37) * 9;
    z += Math.cos(i * seed * 0.29) * 9;
    out.push({ x, z, t: i * 1500 });
  }
  return out;
}
const AGE_OLD = { sessions: 40, playtimeSec: 40000 };

/* ------------------------------------------------------------------ */
/* Budget: monotone in age, bounded                                     */
/* ------------------------------------------------------------------ */

check('budget is 0 for a fresh save', () => {
  assert.equal(scarBudget({ sessions: 0, playtimeSec: 0 }), 0);
});

check('budget is monotone nondecreasing in sessions and playtime', () => {
  let prev = -1;
  for (let s = 0; s <= 60; s += 5) {
    const b = scarBudget({ sessions: s, playtimeSec: 0 });
    assert.ok(b >= prev, `sessions=${s} regressed ${prev} -> ${b}`);
    prev = b;
  }
  prev = -1;
  for (let p = 0; p <= 72000; p += 1800) {
    const b = scarBudget({ sessions: 0, playtimeSec: p });
    assert.ok(b >= prev, `playtime=${p} regressed ${prev} -> ${b}`);
    prev = b;
  }
});

check('budget is hard-capped at MAX_SCAR_CRACKS', () => {
  assert.equal(scarBudget({ sessions: 1e9, playtimeSec: 1e12 }), MAX_SCAR_CRACKS);
  assert.ok(Number.isInteger(MAX_SCAR_CRACKS) && MAX_SCAR_CRACKS > 0);
});

/* ------------------------------------------------------------------ */
/* Determinism                                                          */
/* ------------------------------------------------------------------ */

check('same inputs produce deep-identical scars', () => {
  const r = makeRoute(120);
  const a = computeScars('save-abc', r, AGE_OLD);
  const b = computeScars('save-abc', r, AGE_OLD);
  assert.deepStrictEqual(a, b);
});

check('different save ids produce different scars', () => {
  const r = makeRoute(120);
  const a = computeScars('save-abc', r, AGE_OLD);
  const b = computeScars('save-xyz', r, AGE_OLD);
  assert.notDeepStrictEqual(a, b);
  // And each replays identically.
  assert.deepStrictEqual(computeScars('save-xyz', r, AGE_OLD), b);
});

check('crack ids are stable and unique', () => {
  const scars = computeScars('save-abc', makeRoute(240), AGE_OLD);
  const ids = new Set(scars.map((s) => s.id));
  assert.equal(ids.size, scars.length, 'duplicate crack ids');
  for (const s of computeScars('save-abc', makeRoute(240), AGE_OLD)) {
    assert.ok(ids.has(s.id), 'id changed between runs');
  }
});

/* ------------------------------------------------------------------ */
/* Prefix stability: suffix only ADDS                                   */
/* ------------------------------------------------------------------ */

check('route prefix keeps every crack identical under a longer suffix', () => {
  const prefix = makeRoute(96); // 4 closed batches
  const suffix = makeRoute(72, 13).map((s) => ({ ...s, t: s.t + 1e6 }));
  const before = computeScars('save-pfx', prefix, AGE_OLD);
  const after = computeScars('save-pfx', [...prefix, ...suffix], AGE_OLD);
  assert.ok(before.length > 0, 'fixture produced no cracks');
  const byId = new Map(after.map((s) => [s.id, s]));
  for (const s of before) {
    assert.ok(byId.has(s.id), `suffix removed/renamed crack ${s.id}`);
    assert.deepStrictEqual(byId.get(s.id), s, `crack ${s.id} mutated`);
  }
  assert.ok(after.length >= before.length, 'suffix shrank scarring');
});

check('a growing partial tail never mutates existing cracks', () => {
  const base = makeRoute(ROUTE_BATCH + 10);
  const full = computeScars('save-tail', base, AGE_OLD);
  const grown = computeScars('save-tail', [...base, { x: 55, z: 66, t: 999 }], AGE_OLD);
  assert.deepStrictEqual(full, grown, 'open tail sample changed scarring');
});

check('empty route yields no scars; garbage samples are filtered', () => {
  assert.deepStrictEqual(computeScars('s', [], AGE_OLD), []);
  assert.deepStrictEqual(
    computeScars('s', [{ x: NaN, z: 1, t: 2 }, { x: 1, z: Infinity, t: 2 },
      { x: 1, z: 2, t: NaN }, { x: 5, z: 5, t: 5 }], AGE_OLD).length,
    0,
    'one finite sample must not close a batch',
  );
});

/* ------------------------------------------------------------------ */
/* Density scaling                                                      */
/* ------------------------------------------------------------------ */

check('scar count is monotone in age for a fixed route', () => {
  const r = makeRoute(480); // 20 batches — room to grow
  let prev = -1;
  for (const age of [
    { sessions: 0, playtimeSec: 0 },
    { sessions: 2, playtimeSec: 600 },
    { sessions: 8, playtimeSec: 3600 },
    { sessions: 30, playtimeSec: 20000 },
    { sessions: 100, playtimeSec: 100000 },
    { sessions: 500, playtimeSec: 900000 },
  ]) {
    const n = computeScars('save-dens', r, age).length;
    assert.ok(n >= prev, `age step regressed ${prev} -> ${n}`);
    prev = n;
  }
  assert.ok(prev > 0, 'oldest age produced zero scars on a long route');
});

check('older saves scar deeper (depth scales with budget)', () => {
  const r = makeRoute(120);
  const young = computeScars('save-depth', r, { sessions: 2, playtimeSec: 300 });
  const old = computeScars('save-depth', r, { sessions: 100, playtimeSec: 50000 });
  assert.ok(old.length > 0 && young.length > 0);
  assert.ok(
    old[old.length - 1].depth > young[young.length - 1].depth,
    'depth did not grow with age',
  );
});

/* ------------------------------------------------------------------ */
/* Bounds                                                               */
/* ------------------------------------------------------------------ */

check('huge routes at max age stay bounded', () => {
  const r = makeRoute(20000);
  const scars = computeScars('save-max', r, { sessions: 1e6, playtimeSec: 1e9 });
  assert.ok(scars.length <= MAX_SCAR_CRACKS, `unbounded: ${scars.length}`);
  for (const s of scars) {
    assert.ok(s.points.length >= 2, 'mesher needs a segment');
    assert.ok(s.points.length <= MAX_POLYLINE_POINTS, 'polyline overrun');
    assert.ok(s.width >= 0 && s.width <= 1, 'width out of range');
    assert.ok(s.depth >= 0 && s.depth <= 1, 'depth out of range');
  }
});

check('per-batch cap respected and cracks thread visited cells', () => {
  const r = makeRoute(480);
  const scars = computeScars('save-cells', r, { sessions: 500, playtimeSec: 900000 });
  const perBatch = new Map();
  for (const s of scars) {
    const b = Number(s.id.split('-')[1]);
    perBatch.set(b, (perBatch.get(b) ?? 0) + 1);
    assert.ok(perBatch.get(b) <= MAX_CRACKS_PER_BATCH, `batch ${b} over cap`);
  }
  // Every vertex sits within one cell diagonal of some route sample.
  for (const s of scars) {
    for (const p of s.points) {
      const nearest = Math.min(...r.map((q) => Math.hypot(q.x - p.x, q.z - p.z)));
      assert.ok(nearest < 2 * SCAR_CELL, `vertex ${p.x},${p.z} off-route (${nearest})`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Serialization round-trip                                             */
/* ------------------------------------------------------------------ */

check('serialize -> parse round-trips deep-identically', () => {
  const scars = computeScars('save-json', makeRoute(200), AGE_OLD);
  const json = serializeScars(scars);
  assert.equal(typeof json, 'string');
  const back = parseScars(json);
  assert.notEqual(back, null);
  assert.deepStrictEqual(back, scars);
});

check('parse rejects junk payloads gracefully (null, not throw)', () => {
  assert.equal(parseScars('not json {'), null);
  assert.equal(parseScars(null), null);
  assert.equal(parseScars(42), null);
  assert.equal(parseScars('{}'), null);
  assert.equal(parseScars(JSON.stringify({ version: 2, scars: [] })), null);
  assert.equal(parseScars([]), null);
  assert.deepEqual(parseScars(JSON.stringify({ version: 1, scars: [] })), []);
});

console.log(`\nSCARRING_TEST ${failures === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
