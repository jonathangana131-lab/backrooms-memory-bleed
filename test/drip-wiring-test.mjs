/**
 * Unit test for the stain -> drip game wiring (src/world/drip-wiring.ts).
 * Standalone (no browser): transpiles drip-wiring + its world deps into a
 * temp dir and drives DripWiring against a mock dripsApi.
 * Run: node test/drip-wiring-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-dripwiring-'));
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/world/staindrips.ts', 'world/staindrips.mjs');
emit('src/world/drip-wiring.ts', 'world/drip-wiring.mjs');

const wiringMod = await import(pathToFileURL(path.join(tmp, 'world', 'drip-wiring.mjs')).href);
const syncMod = await import(pathToFileURL(path.join(tmp, 'world', 'staindrips.mjs')).href);
const constants = await import(pathToFileURL(path.join(tmp, 'world', 'constants.mjs')).href);
const { DripWiring } = wiringMod;
const { StainDripSync, MERGE_DIST, MAX_DOUBLINGS } = syncMod;
const CHUNK_SIZE = constants.CHUNK_SIZE;

/** Mock registrar recording every registerStain(x, z) call in order. */
function makeMockApi() {
  const calls = [];
  return {
    calls,
    registerStain(x, z) { calls.push([x, z]); },
    lastCall() { return calls[calls.length - 1]; },
  };
}

const chunkKeyOf = (x, z) => Math.floor(x / CHUNK_SIZE) + ',' + Math.floor(z / CHUNK_SIZE);

{
  // --- construction ---------------------------------------------------------
  const api = makeMockApi();
  const w = new DripWiring(api);
  check('exports DripWiring', typeof DripWiring === 'function');
  check('constructor builds a StainDripSync over the api', w.sync instanceof StainDripSync);
  check('construction registers nothing by itself', api.calls.length === 0 && w.sync.pointCount === 0);
}

{
  // --- onLayoutBuilt extracts stains ---------------------------------------
  const api = makeMockApi();
  const w = new DripWiring(api);
  // deliberately bogus cx/cz: grouping must follow stain WORLD positions
  w.onLayoutBuilt({
    cx: 9, cz: 9,
    // wet floor: CeilingDrips' contract gates registration on non-empty
    // puddles, so every fixture meant to register must carry them
    puddles: [{ x: 6, z: 7, r: 0.8 }],
    stains: [
      { x: 5, z: 7, r: 1.3 },
      { x: 25, z: 8, r: 0.9 },
      { x: -35, z: -32, r: 1.1 },
    ],
  });
  check('every layout.stain is forwarded to registerStain(x, z)',
    api.calls.length === 3 &&
    JSON.stringify(api.calls) === JSON.stringify([[5, 7], [25, 8], [-35, -32]]),
    JSON.stringify(api.calls));
  check('radius is stripped - only (x, z) reach the gfx api',
    api.calls.every((c) => c.length === 2));
  check('sync pointCount matches registered stains', w.sync.pointCount === 3);

  // chunk bookkeeping follows world position, not the layout's chunk id:
  // (5,7) and (25,8) both live in chunk '0,0' despite cx=9; (-35,-32) is
  // one chunk across each negative border -> '-2,-2'.
  check('points are keyed by their own world chunk',
    w.sync.levelsIn(chunkKeyOf(5, 7)).length === 2 &&
    w.sync.levelsIn(chunkKeyOf(-35, -32)).length === 1,
    'levelsIn sizes');
}

{
  // --- dedup within and across layouts -------------------------------------
  const api = makeMockApi();
  const w = new DripWiring(api);
  w.onLayoutBuilt({ puddles: [{ x: 10, z: 10, r: 0.5 }], stains: [{ x: 10, z: 10 }, { x: 10.6, z: 10.2 }] });
  check('stains within MERGE_DIST share ONE drip point',
    api.calls.length === 1 && api.calls[0][0] === 10 && api.calls[0][1] === 10,
    JSON.stringify(api.calls));

  // re-entering/rebuilding the same chunk must not stack emitters
  const before = api.calls.length;
  w.onLayoutBuilt({ puddles: [{ x: 10, z: 10, r: 0.5 }], stains: [{ x: 10.4, z: 9.8 }, { x: 25, z: 25 }] });
  check('rebuild of overlapping stain merges away', api.calls.length === before + 1);
  check('only the genuinely new stain registers again',
    api.lastCall()[0] === 25 && api.lastCall()[1] === 25,
    JSON.stringify(api.lastCall()));
  check('MERGE_DIST is the documented 1 m merge radius', MERGE_DIST === 1, String(MERGE_DIST));
}

{
  // --- robustness ------------------------------------------------------------
  const api = makeMockApi();
  const w = new DripWiring(api);
  w.onLayoutBuilt({});
  w.onLayoutBuilt(null);
  w.onLayoutBuilt(undefined);
  w.onLayoutBuilt({ stains: null });
  check('missing/null stains list is a no-op', api.calls.length === 0);
  // puddle gate: stained ceilings over dry floor shed nothing
  w.onLayoutBuilt({ stains: [{ x: 1, z: 1 }] });
  w.onLayoutBuilt({ stains: [{ x: 1, z: 1 }], puddles: [] });
  w.onLayoutBuilt({ stains: [{ x: 1, z: 1 }], puddles: null });
  check('missing/empty/null puddles list gates registration off', api.calls.length === 0);
  w.onLayoutBuilt({ stains: [{ x: NaN, z: 3 }, { x: 3, z: Infinity }, null], puddles: [{ x: 2, z: 3, r: 0.4 }] });
  check('non-finite and malformed entries are skipped', api.calls.length === 0);
}

{
  // --- stage advance doubles drip frequency ---------------------------------
  const api = makeMockApi();
  const w = new DripWiring(api);
  const keyA = 'a-chunk';
  w.onLayoutBuilt({ puddles: [{ x: 40, z: 40, r: 0.6 }], stains: [{ x: 40, z: 40 }, { x: 44, z: 41 }] }); // same 30 m chunk -> key '1,1'
  const key11 = chunkKeyOf(40, 40);
  check('test fixture puts both points in one chunk', key11 === '1,1');
  const afterSync = api.calls.length;

  w.onStageAdvance(key11);
  check('stage advance re-registers every point in the chunk (+1 each)',
    api.calls.length === afterSync + 2,
    'calls ' + afterSync + ' -> ' + api.calls.length);
  check('doubling keeps the same positions (two timers at one spot)',
    api.calls.slice(afterSync).every((c) => (c[0] === 40 && c[1] === 40) || (c[0] === 44 && c[1] === 41)));
  check('levels rose to 2 for the advanced chunk',
    w.sync.levelsIn(key11).every((l) => l === 2),
    JSON.stringify(w.sync.levelsIn(key11)));

  // unrelated chunk key is untouched
  const frozen = api.calls.length;
  w.onStageAdvance(keyA);
  w.onStageAdvance(chunkKeyOf(-100, -100));
  check('stage advance in an unknown/other chunk is inert', api.calls.length === frozen);

  // cap: level starts at 1, MAX_DOUBLINGS more advances saturate it
  for (let i = 0; i < MAX_DOUBLINGS; i++) w.onStageAdvance(key11);
  check('MAX_DOUBLINGS is 3', MAX_DOUBLINGS === 3, String(MAX_DOUBLINGS));
  check('points fully bloom at 1 + MAX_DOUBLINGS',
    w.sync.levelsIn(key11).every((l) => l === 1 + MAX_DOUBLINGS),
    JSON.stringify(w.sync.levelsIn(key11)));
  const saturated = api.calls.length;
  w.onStageAdvance(key11);
  w.onStageAdvance(key11);
  check('advances past the cap stop registering (96-point budget guard)',
    api.calls.length === saturated);
}

console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


