/**
 * Unit tests for the emergency lights game adapter
 * (src/gfx/emergency-wiring.ts). Standalone (no browser): transpiles the
 * wiring + emergencylights into a temp dir, points their Babylon runtime
 * imports at a lightweight stub module (same trick as
 * emergencylights-test), then drives EmergencyWiring against fake
 * PointLights. Private fields are TS-only, so the rig's pool/unit list
 * stay observable after transpile.
 *
 * Verifies:
 *   1. LAZY construction: `lights` is null until ensureLights(scene)
 *   2. fixtures announced before any scene accumulate and are applied on
 *      the first ensureLights (nothing seen is lost)
 *   3. re-announcing a chunk REPLACES its fixture list instead of
 *      duplicating battery units
 *   4. combined set is arrival-ordered across distinct chunks
 *   5. MAX_TRACKED_CHUNKS eviction: oldest chunk drops out first
 *   6. frameUpdate forwards blackout transitions: dark -> lit pulse ->
 *      dark again -> lit once more, with parked positions when off
 *   7. frameUpdate is safe before ensureLights ever ran
 *   8. reset() forgets chunks and hard-offs the rig; a later
 *      onChunkFixtures re-binds cleanly
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-emergencywiring-'));

// ---- Babylon stub: just enough surface for emergencylights.ts -------------
fs.writeFileSync(path.join(tmp, 'babylon-stub.mjs'), [
  "export class Color3 {",
  "  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }",
  "  copyFrom(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }",
  "  clone() { return new Color3(this.r, this.g, this.b); }",
  "}",
  "export class Vector3 {",
  "  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }",
  "  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }",
  "}",
  "export class PointLight {",
  "  constructor(name, pos, scene) { this.name = name; this.position = pos;",
  "    this.intensity = 0; this.range = 0; this.diffuse = null; }",
  "}",
].join('\n'));

// transpile a src file; rewrite @babylonjs imports onto the stub and
// extensionless relative imports onto .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    .replace(/from '@babylonjs\/[^']*'/g, "from '../babylon-stub.mjs'")
    .replace(/(from\s+)'(\.[^']*?)(?<!\.mjs)'/g, "$1'$2.mjs'");
  const outPath = path.join(tmp, outRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, js);
}
emit('src/gfx/emergencylights.ts', 'gfx/emergencylights.mjs');
emit('src/gfx/emergency-wiring.ts', 'gfx/emergency-wiring.mjs');

const wiringMod = await import(pathToFileURL(path.join(tmp, 'gfx', 'emergency-wiring.mjs')).href);
const { EmergencyWiring, chunkKeyOf, MAX_TRACKED_CHUNKS } = wiringMod;

// ---- synthetic chunk fixture generators ------------------------------------

function gridChunk(seed, count) {
  const f = [];
  for (let i = 0; i < count; i++) {
    f.push({ x: ((i * 13 + seed) % 40) - 20 + i * 0.37, z: ((i * 29 - seed) % 36) - 18 - i * 0.19 });
  }
  return f;
}

check('chunk cap constant is sane', Number.isInteger(MAX_TRACKED_CHUNKS) && MAX_TRACKED_CHUNKS >= 2);
check('chunkKeyOf stable and order-sensitive',
  chunkKeyOf(3, -7) === chunkKeyOf(3, -7) && chunkKeyOf(3, -7) !== chunkKeyOf(-7, 3));

// ---- lazy construction ------------------------------------------------------



const wiring = new EmergencyWiring();
check('no scene yet: lights starts null', wiring.lights === null);

const chunkA = gridChunk(0, 42);
const chunkB = gridChunk(11, 35);

// announce chunks BEFORE any scene exists - must not throw and must not build
wiring.onChunkFixtures(0, 0, chunkA);
wiring.onChunkFixtures(1, 0, chunkB);
check('onChunkFixtures before ensureLights stays lazy', wiring.lights === null);

const fakeScene = {};
wiring.ensureLights(fakeScene);
check('ensureLights builds the rig exactly once',
  wiring.lights instanceof Object && wiring.lights !== null);
const firstRig = wiring.lights;
wiring.ensureLights({ someOther: true });
check('second ensureLights keeps existing rig', wiring.lights === firstRig);

const unitsA = wiring.lights.units.slice(0, Math.ceil(chunkA.length / 7));
check('pre-scene fixtures applied on first ensureLights',
  unitsA.length > 0 && unitsA.every((u, i) => u.x === chunkA[i * 7].x && u.z === chunkA[i * 7].z));
check('combined set spans every announced chunk in arrival order',
  wiring.lights.units.length === Math.ceil((chunkA.length + chunkB.length) / 7)
  && wiring.lights.units[unitsA.length].x === chunkB[0].x);

// ---- replacement semantics ---------------------------------------------------

const chunkA2 = gridChunk(99, 21); // same chunk key, different layout
wiring.onChunkFixtures(0, 0, chunkA2);
check('re-announced chunk replaces its old fixture list',
  wiring.lights.units.length === Math.ceil((chunkA2.length + chunkB.length) / 7),
  'got ' + wiring.lights.units.length);
check('replaced list drives selection from new coordinates',
  wiring.lights.units[0].x === chunkA2[0].x && wiring.lights.units[0].z === chunkA2[0].z);

// ---- bounded accumulation -----------------------------------------------------

const w2 = new EmergencyWiring();
for (let k = 0; k < MAX_TRACKED_CHUNKS + 10; k++) {
  w2.onChunkFixtures(k, 0, gridChunk(k * 3 + 1, 7));
}
w2.ensureLights({});
check('tracked chunks capped at MAX_TRACKED_CHUNKS',
  w2.chunks.size === MAX_TRACKED_CHUNKS,
  'size=' + w2.chunks.size);
check('eviction drops OLDEST chunks first',
  !w2.chunks.has(chunkKeyOf(0, 0)) && !w2.chunks.has(chunkKeyOf(9, 0))
  && w2.chunks.has(chunkKeyOf(MAX_TRACKED_CHUNKS + 9, 0)));

// ---- blackout transitions ------------------------------------------------------

const pool = wiring.lights.pool;
const litCount = () => pool.filter((l) => l.intensity > 0).length;

wiring.frameUpdate(1 / 60, false);
check('frameUpdate outside blackout parks everything dark and off-stage',
  pool.every((l) => l.intensity === 0 && l.position.y === -100));

wiring.frameUpdate(0.25, true); // blackout begins
check('blackout start lights one pulsing light per unit (pool-capped)',
  litCount() === Math.min(wiring.lights.units.length, pool.length),
  'lit=' + litCount() + ' units=' + wiring.lights.units.length + ' pool=' + pool.length);
const duringBlackout = pool.map((l) => l.intensity);

wiring.frameUpdate(0.5, true); // still dark outside
const laterBlackout = pool.map((l) => l.intensity);
check('intensity pulses while blackout continues',
  pool.some((l, i) => l.intensity > 0 && Math.abs(duringBlackout[i] - laterBlackout[i]) > 0.01));

wiring.frameUpdate(1 / 60, false); // power restored
check('blackout END kills all output instantly', pool.every((l) => l.intensity === 0));
check('parked off-stage after power restore', pool.every((l) => l.position.y === -100));

wiring.frameUpdate(0.1, true); // second blackout
check('SECOND blackout transition relights the units',
  litCount() === Math.min(wiring.lights.units.length, pool.length));

// ---- pre-rig safety -------------------------------------------------------------

const w3 = new EmergencyWiring();
let threw = false;
try { w3.frameUpdate(0.016, true); w3.frameUpdate(0.016, false); } catch { threw = true; }
check('frameUpdate before ensureLights never throws and builds nothing',
  !threw && w3.lights === null);

// ---- reset -----------------------------------------------------------------------

wiring.reset();
check('reset clears accumulated chunks', wiring.chunks.size === 0);
check('reset hard-offs the rig',
  pool.every((l) => l.intensity === 0 && l.position.y === -100));

wiring.onChunkFixtures(5, 5, chunkA);
wiring.frameUpdate(0.25, true);
check('post-reset announcements re-bind the surviving rig',
  wiring.lights !== null
  && wiring.lights.units.length === Math.ceil(chunkA.length / 7)
  && litCount() === Math.min(wiring.lights.units.length, wiring.lights.pool.length),
  'lit=' + litCount());

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


