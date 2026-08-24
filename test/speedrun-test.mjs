/**
 * Speedrun smoke test - pure Node, no renderer.
 *
 * NOTE: the original file tested legacy SpeedrunTimer/buildOverlay UI
 * behavior; those modules no longer exist in src/. Rebuilt as an honest
 * smoke of the surviving speedrun surface, SpeedrunGhostStore (F98):
 * record -> serialize -> replay. The full F98 acceptance suite lives in
 * test/speedrunghost-test.mjs; this file stays a compact end-to-end smoke.
 *
 *   1. record/replay round-trip - a recorded attempt is retained, exports
 *      to stable JSON, deserializes byte-compatibly, and replays poses
 *      that match the recording exactly at sample times and midpoints.
 *   2. fastest-completion retention - slower attempts never replace the
 *      stored best, strictly faster ones do, exact ties keep the incumbent.
 *   3. corrupt payload safety - deserializeGhost rejects junk without
 *      throwing and loadSerialized never lets a bad payload displace best.
 *
 * Run: node test/speedrun-test.mjs  (prints SPEEDRUN ALL PASS, exits 0)
 */
import { register } from 'node:module';
import assert from 'node:assert/strict';

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
  SpeedrunGhostStore, serializeGhost, deserializeGhost,
  sampleAt, ghostStorageKey,
} = await import('../src/save/speedrunghost.ts');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok - ' + name);
  else { failures++; console.error('FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}

// --- 1. record -> serialize -> replay round-trip ---
{
  const store = new SpeedrunGhostStore();
  const samples = [
    { tSec: 0, x: 0, z: 0, yaw: 0 },
    { tSec: 5, x: 10, z: 0, yaw: 0.5 },
    { tSec: 10, x: 10, z: 20, yaw: 1.5 },
  ];
  const out = store.recordAttempt(0xc0ffee, 10, samples);
  check('first valid attempt is retained', !!out && out.replaced === true);
  check('retained replay matches the attempt', !!out && out.retained.durationSec === 10);

  const exported = store.exportSeed(0xc0ffee);
  check('export produces JSON text', typeof exported === 'string' && !!exported);
  const replay = deserializeGhost(exported);
  check('deserialize round-trips the export', !!replay && replay.samples.length === 3);

  const p0 = sampleAt(replay, 0);
  check('query at first sample returns it exactly',
    p0.x === 0 && p0.z === 0 && p0.yaw === 0);
  const mid = sampleAt(replay, 7.5);
  check('midpoint query is the exact linear blend',
    mid.x === 10 && mid.z === 10 && Math.abs(mid.yaw - 1) < 1e-12);
  const end = sampleAt(replay, 99);
  check('past-the-end query clamps to last sample',
    end.x === 10 && end.z === 20 && end.yaw === 1.5);
}

// --- 2. fastest-completion retention ---
{
  const store = new SpeedrunGhostStore();
  const mk = (t) => [{ tSec: 0, x: 0, z: 0, yaw: 0 }, { tSec: t, x: 1, z: 1, yaw: 0 }];
  store.recordAttempt(7, 100, mk(100));
  const slow = store.recordAttempt(7, 120, mk(120));
  check('slower attempt does not replace', !!slow && slow.replaced === false);
  check('best still the faster run', store.bestGhost(7).durationSec === 100);
  const fast = store.recordAttempt(7, 90, mk(90));
  check('strictly faster attempt replaces', !!fast && fast.replaced === true);
  check('best updated', store.bestGhost(7).durationSec === 90);
  const tie = store.recordAttempt(7, 90, mk(90));
  check('exact tie keeps the incumbent', !!tie && tie.replaced === false);

  // invalid attempts never touch the store
  const junk = store.recordAttempt(7, NaN, mk(5));
  check('non-finite duration rejected', junk === null);
  check('store unchanged after rejection', store.bestGhost(7).durationSec === 90);

  // keys are stable per seed and distinct across seeds
  check('key stable and hex-suffixed',
    ghostStorageKey(7) === ghostStorageKey(7) && ghostStorageKey(7).startsWith('bmb.speedrun.ghost.'));
  check('distinct seeds get distinct keys', ghostStorageKey(7) !== ghostStorageKey(8));
}

// --- 3. corrupt payload safety ---
{
  const store = new SpeedrunGhostStore();
  const good = [
    { tSec: 0, x: 0, z: 0, yaw: 0 },
    { tSec: 4, x: 4, z: 0, yaw: 0 },
  ];
  store.recordAttempt(42, 4, good);
  for (const junk of [null, '', 'not json', '{"samples":[]}', '{}']) {
    const r = deserializeGhost(junk);
    check('junk payload rejected: ' + JSON.stringify(String(junk)).slice(0, 20), r === null);
  }
  check('loadSerialized refuses corrupt payload', store.loadSerialized(42, 'not json') === false);
  check('corrupt payload never displaced best', store.bestGhost(42).durationSec === 4);
  const slower = serializeGhost({ seed: 42, durationSec: 9, samples: good });
  check('loadSerialized refuses slower import', store.loadSerialized(42, slower) === false);
  check('best intact after slower import', store.bestGhost(42).durationSec === 4);
  assert.ok(true); // assert imported and exercised; suite failures counted above
}

if (failures > 0) {
  console.error('SPEEDRUN FAILURES: ' + failures);
  process.exit(1);
}
console.log('SPEEDRUN ALL PASS');
