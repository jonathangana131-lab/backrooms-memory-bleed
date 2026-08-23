/**
 * Unit tests for the crack -> mesher game wiring (src/world/crackmesher-wiring.ts).
 * Standalone (no browser): transpiles the wiring (+ cracks/crackmesher/
 * cornerao/constants/rng) into a temp dir and drives CrackMesherWiring
 * against a mock WallCracks plus the real pipeline end-to-end.
 * Run: node test/crackmesher-wiring-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-crackwiring-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/gfx/cornerao.ts', 'gfx/cornerao.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/world/cracks.ts', 'world/cracks.mjs');
emit('src/world/crackmesher.ts', 'world/crackmesher.mjs');
emit('src/world/crackmesher-wiring.ts', 'world/crackmesher-wiring.mjs');

const wiringMod = await import(pathToFileURL(path.join(tmp, 'world', 'crackmesher-wiring.mjs')).href);
const mesherMod = await import(pathToFileURL(path.join(tmp, 'world', 'crackmesher.mjs')).href);
const cracksMod = await import(pathToFileURL(path.join(tmp, 'world', 'cracks.mjs')).href);
const { CrackMesherWiring, chunkKeyOf } = wiringMod;
const { CrackMesherPass } = mesherMod;
const {
  createWallCracks,
  MAX_CRACKS_PER_CHUNK,
  ACTIVITY_SECONDS_PER_CRACK,
} = cracksMod;

// --- mock WallCracks -------------------------------------------------------

/** Deterministic fake memory system recording every call in order. */
function makeMockCracks() {
  const calls = [];
  return {
    calls,

(Showing lines 1-60 of 243. Use offset=61 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
  const w = new CrackMesherWiring(new CrackMesherPass(), mock);
  const key = chunkKeyOf(4, 5);
  const first = w.onLayoutBuilt({}, 4, 5, 7);
  check('invalidate on an unknown key returns false', !w.invalidate(chunkKeyOf(99, 99)));
  check('invalidate drops the cached entry', w.invalidate(key) === true && !w.isCached(key));
  const second = w.onLayoutBuilt({}, 4, 5, 7);
  check('post-invalidation build regenerates exactly once more',
    mock.genCount() === 2 && second !== first && second !== null);
  check('regenerated list is byte-identical for identical inputs',
    JSON.stringify(second) === JSON.stringify(first));
  check('cache is warm again after regeneration', w.isCached(key));
  const third = w.onLayoutBuilt({}, 4, 5, 7);
  check('subsequent builds are cache hits again',
    third === second && mock.genCount() === 2);
}

// --- end-to-end with the real WallCracks + real mesher ----------------------

/** Minimal Storage double so createWallCracks never touches localStorage. */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

function makeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

{
  const storageA = makeStorage();
  const clockA = makeClock();
  const real = createWallCracks(clockA.now, storageA);
  const w = new CrackMesherWiring(new CrackMesherPass({ seed: 9 }), real);

  const key = chunkKeyOf(0, 0); // world coords 0..CHUNK_SIZE
  const fresh = w.onLayoutBuilt({}, 0, 0, 12345);
  check('real pipeline emits well-formed quads',
    fresh.length > 0 &&
    fresh.every((q) =>
      q.positions.length === 12 && q.tints.length === 12 &&
      q.normal.length === 3 && q.normal.every(Number.isFinite)),
    'quads=' + (fresh ? fresh.length : 'null'));

  const freshSnapshot = JSON.stringify(fresh);
  check('same wiring rebuilds identically while cached',
    w.onLayoutBuilt({}, 0, 0, 12345) === fresh);

  // activity earns cracks: ACTIVITY_SECONDS_PER_CRACK seconds per slot
  for (let i = 0; i < MAX_CRACKS_PER_CHUNK * ACTIVITY_SECONDS_PER_CRACK; i++) {
    w.addActivity(15, 15, 1);
  }
  w.invalidate(key);
  const afterDwell = w.onLayoutBuilt({}, 0, 0, 12345);
  check('dwelling in a chunk grows its quad count after invalidation',
    afterDwell.length > fresh.length,
    fresh.length + ' -> ' + afterDwell.length);

(Showing lines 148-207 of 239. Use offset=208 to continue.)

