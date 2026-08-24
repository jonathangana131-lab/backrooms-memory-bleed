/**
 * Local speedrun ghost tests (F98) - pure Node, no renderer.
 * Verifies the F98 acceptance proof:
 *   1. AC ghost determinism - interpolated replay is byte-identical across
 *      separate instances (fresh store + deserialize round-trip) at a large
 *      sweep of arbitrary t queries, including exact sample times,
 *      midpoints, and out-of-range clamps at both ends
 *   2. interpolation correctness - query at a sample time returns that
 *      sample exactly; between samples the pose is the exact linear blend;
 *      t before/after the recording clamps to first/last sample; junk tSec
 *      clamps without throwing
 *   3. best-run retention - only the fastest completion per seed is kept:
 *      slower attempts never replace, strictly faster ones do, and an exact
 *      tie keeps the old ghost
 *   4. per-seed storage key - keys are stable per seed and distinct across
 *      seeds; equivalent seeds (>>>0) share one key
 *   5. corrupted payload rejection - documented list: non-string input,
 *      invalid JSON, wrong-typed/missing fields, non-finite numbers, too
 *      few samples, unsorted tSec - all return null and never displace a
 *      stored best
 *   6. serialize/deserialize round-trip - byte-identical text and identical
 *      replay answers after a full record -> serialize -> replay cycle
 *
 * Run: node test/speedrunghost-test.mjs  (prints SPEEDRUNGHOST ALL PASS, exits 0)
 */
import { register } from 'node:module';

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
  SpeedrunGhostStore, serializeGhost, deserializeGhost, sampleAt,
  ghostStorageKey, MIN_GHOST_SAMPLES, GHOST_KEY_PREFIX,
} = await import('../src/save/speedrunghost.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Straight-line synthetic run: n samples over durationSec along x. */
function run(seed, n, durationSec) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    samples.push({ tSec: u * durationSec, x: u * 100 + seed % 7, z: Math.sin(u * Math.PI) * 4, yaw: u * 6.28 });
  }
  return samples;
}

const QUERY_TIMES = [];
for (let i = 0; i <= 400; i++) QUERY_TIMES.push(-5 + (i / 400) * 115);
QUERY_TIMES.push(0, 10, NaN, Infinity, -Infinity);

// ---------------------------------------------------------------------------
console.log('1. AC ghost determinism across instances at arbitrary t');
{
  const SEED = 0xC0FFEE;
  const storeA = new SpeedrunGhostStore();
  const outcome = storeA.recordAttempt(SEED, 100, run(SEED, 50, 100));
  ok(outcome && outcome.replaced && outcome.retained === storeA.bestGhost(SEED), 'recordAttempt accepts a valid first run');

  const payloadA = storeA.exportSeed(SEED);
  // A completely separate instance rebuilds the ghost purely from payload.
  const storeB = new SpeedrunGhostStore();
  storeB.loadSerialized(SEED, payloadA);
  const direct = deserializeGhost(payloadA);

  let identical = true;
  for (const t of QUERY_TIMES) {
    const pa = JSON.stringify(sampleAt(storeA.bestGhost(SEED), t));
    const pb = JSON.stringify(sampleAt(storeB.bestGhost(SEED), t));
    const pd = JSON.stringify(sampleAt(direct, t));
    if (pa !== pb || pa !== pd) identical = false;
  }
  ok(identical, `store-replay, imported-replay and deserialized replay agree byte-identically over ${QUERY_TIMES.length} arbitrary t queries`);
}
// ---------------------------------------------------------------------------
console.log('2. Interpolation correctness + end clamps');
{
  const g = deserializeGhost(serializeGhost({ seed: 1, durationSec: 10, samples: [
    { tSec: 0, x: 0, z: 0, yaw: 0 },
    { tSec: 10, x: 10, z: 20, yaw: 2 },
  ] }));
  const p0 = sampleAt(g, 0);
  const pMid = sampleAt(g, 5);
  const pEnd = sampleAt(g, 10);
  ok(p0.x === 0 && p0.z === 0 && p0.yaw === 0, 'query at first sample returns it exactly');
  ok(pEnd.x === 10 && pEnd.z === 20 && pEnd.yaw === 2, 'query at last sample returns it exactly');
  ok(pMid.x === 5 && pMid.z === 10 && pMid.yaw === 1, 'midpoint query is the exact linear blend');

  const before = sampleAt(g, -100);
  const after = sampleAt(g, 999);
  ok(before.x === 0 && before.yaw === 0, 't below the span clamps to the first sample');
  ok(after.x === 10 && after.yaw === 2, 't above the span clamps to the last sample');

  const junk = sampleAt(g, NaN);
  ok(Number.isFinite(junk.x) && Number.isFinite(junk.z) && Number.isFinite(junk.yaw),
    'junk tSec (NaN) clamps into a finite pose without throwing');

  // Piecewise linearity inside a multi-segment replay.
  const g2 = deserializeGhost(serializeGhost({ seed: 2, durationSec: 20, samples: [
    { tSec: 0, x: 0, z: 0, yaw: 0 },
    { tSec: 10, x: 10, z: 0, yaw: 0 },
    { tSec: 20, x: 10, z: 30, yaw: 4 },
  ] }));
  const q = sampleAt(g2, 15);
  ok(q.x === 10 && q.z === 15 && q.yaw === 2, 'second-segment query blends against its own brackets');
}
// ---------------------------------------------------------------------------
console.log('3. Best-run retention: fastest only, ties keep old');
{
  const SEED = 1234;
  const s = new SpeedrunGhostStore();
  s.recordAttempt(SEED, 90, run(SEED, 10, 90));
  const best90 = serializeGhost(s.bestGhost(SEED));
  ok(s.recordAttempt(SEED, 120, run(SEED, 10, 120)).replaced === false &&
     serializeGhost(s.bestGhost(SEED)) === best90,
    'slower attempt does not replace the retained best');
  ok(s.recordAttempt(SEED, 90, run(999, 8, 90)).replaced === false &&
     serializeGhost(s.bestGhost(SEED)) === best90,
    'exact tie keeps the old ghost (strictly-faster rule)');
  const faster = s.recordAttempt(SEED, 75, run(SEED, 12, 75));
  ok(faster.replaced === true && faster.retained.durationSec === 75,
    'strictly faster attempt replaces the best');
  ok(s.exportSeed(SEED) !== best90, 'export reflects the new best after replacement');
}
// ---------------------------------------------------------------------------
console.log('4. Per-seed storage keys');
{
  ok(ghostStorageKey(0xC0FFEE) === `${GHOST_KEY_PREFIX}c0ffee`, 'key is prefix + hex seed');
  ok(ghostStorageKey(-1) === ghostStorageKey(0xFFFFFFFF), 'equivalent seeds (>>>0) share one key');
  ok(new Set([ghostStorageKey(1), ghostStorageKey(2), ghostStorageKey(3)]).size === 3,
    'distinct seeds get distinct keys');

  const s = new SpeedrunGhostStore();
  s.recordAttempt(1, 50, run(1, 5, 50));
  s.recordAttempt(2, 60, run(2, 5, 60));
  ok(s.bestGhost(1).durationSec === 50 && s.bestGhost(2).durationSec === 60 && s.bestGhost(3) === null,
    'ghosts stay isolated per seed; unknown seed returns null');
}
// ---------------------------------------------------------------------------
console.log('5. Corrupted payloads rejected (documented list)');
{
  const good = serializeGhost({ seed: 7, durationSec: 10, samples: [
    { tSec: 0, x: 0, z: 0, yaw: 0 }, { tSec: 10, x: 1, z: 1, yaw: 1 },
  ] });
  const corrupt = [
    ['non-string input', undefined],
    ['non-string input (number)', 42],
    ['invalid JSON', '{not json'],
    ['JSON non-object', '[1,2,3]'],
    ['missing seed', JSON.stringify({ durationSec: 10, samples: JSON.parse(good).samples })],
    ['missing durationSec', JSON.stringify({ seed: 7, samples: JSON.parse(good).samples })],
    ['wrong-typed field', JSON.stringify({ seed: 'x', durationSec: 10, samples: JSON.parse(good).samples })],
    ['non-finite number', '{"seed":7,"durationSec":10,"samples":[{"tSec":0,"x":NaN,"z":0,"yaw":0},{"tSec":10,"x":1,"z":1,"yaw":1}]}'],
    [`too few samples (< MIN_GHOST_SAMPLES=${MIN_GHOST_SAMPLES})`,
      JSON.stringify({ seed: 7, durationSec: 10, samples: [{ tSec: 0, x: 0, z: 0, yaw: 0 }] })],
    ['unsorted tSec', JSON.stringify({ seed: 7, durationSec: 10, samples: [
      { tSec: 5, x: 0, z: 0, yaw: 0 }, { tSec: 5, x: 1, z: 1, yaw: 1 },
    ] })],
  ];
  let allRejected = true;
  for (const [label, payload] of corrupt) {
    let r = null;
    try { r = deserializeGhost(payload); } catch { allRejected = false; }
    if (r !== null) allRejected = false;
  }
  ok(allRejected && corrupt.length >= 9, `all ${corrupt.length} corruption classes return null without throwing`);

  const s = new SpeedrunGhostStore();
  s.recordAttempt(7, 10, run(7, 5, 10));
  const kept = s.exportSeed(7);
  let storeSafe = true;
  for (const [, payload] of corrupt) if (s.loadSerialized(7, payload) !== false) storeSafe = false;
  ok(storeSafe && s.exportSeed(7) === kept, 'corrupt loadSerialized calls never displace the stored best');

  const slowerGood = serializeGhost({ seed: 7, durationSec: 99, samples: run(7, 4, 99) });
  ok(s.loadSerialized(7, slowerGood) === false && s.exportSeed(7) === kept,
    'a valid-but-slower import is refused too (fastest-only retention)');
  const fasterGood = serializeGhost({ seed: 7, durationSec: 5, samples: run(7, 6, 5) });
  ok(s.loadSerialized(7, fasterGood) === true && s.bestGhost(7).durationSec === 5,
    'a valid faster import becomes the new best');
}
// ---------------------------------------------------------------------------
console.log('6. Record -> serialize -> replay round-trip');
{
  const SEED = 77;
  const s = new SpeedrunGhostStore();
  const samples = run(SEED, 40, 64);
  const original = { seed: SEED, durationSec: 64, samples };
  const payload = serializeGhost(original);
  ok(JSON.stringify(JSON.parse(payload)) === JSON.stringify({ seed: SEED, durationSec: 64, samples: samples.map((p) => ({ ...p })) }),
    'serialize emits stable JSON with every sample preserved in order');

  s.loadSerialized(SEED, payload);
  const rt = deserializeGhost(s.exportSeed(SEED));
  let same = true;
  for (const t of [0, 7.3, 31.999, 64]) {
    if (JSON.stringify(sampleAt(rt, t)) !== JSON.stringify(sampleAt(deserializeGhost(payload), t))) same = false;
  }
  ok(same && s.exportSeed(SEED) === payload,
    'full round-trip replays byte-identical poses and re-serializes to the identical payload');

  ok(s.recordAttempt(NaN, 10, samples) === null &&
     s.recordAttempt(1, NaN, samples) === null &&
     s.recordAttempt(1, 10, []) === null &&
     s.recordAttempt(1, 10, [{ tSec: 5, x: 0, z: 0, yaw: 0 }, { tSec: 1, x: 1, z: 1, yaw: 1 }]) === null,
    'invalid attempts (junk seed/duration, empty or unsorted samples) return null and touch nothing');
}

console.log(failures === 0 ? `SPEEDRUNGHOST ALL PASS (${check} checks)` : `SPEEDRUNGHOST FAIL (${failures}/${check})`);
process.exit(failures === 0 ? 0 : 1);
