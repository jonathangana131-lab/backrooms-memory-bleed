/*
 * Emergency lights system test - runs headless in Node.
 *
 * src/gfx/emergencylights.ts imports Babylon classes as runtime values
 * (point-light pool construction), so we transpile it with the workspace
 * TypeScript compiler, rewrite its @babylonjs imports onto a lightweight
 * stub module (same trick as drips-test), and drive EmergencyLights
 * against fake PointLights. Private fields are TS-only, so the pool and
 * unit list stay observable after transpile.
 *
 * Verifies:
 *   1. placement is the deterministic every-7th subset of chunk fixtures
 *   2. selection is pure: same fixtures -> identical units (coords/exit/phase)
 *   3. some but not all units are EXIT-sign green; exit flag is stable per position
 *   4. pulse is a slow 0.5 Hz sine: period exactly 2 s, bounded [0.1, 1]
 *   5. update(dt, true) parks lights on unit positions with pulsing intensity,
 *      red or green diffuse matching each unit's exit flag
 *   6. update(dt, false) and deactivate() leave everything dark and parked
 *   7. pool cap: chunks with more units than POOL never overflow the pool
 *   8. pulse advances over time (dt accumulation) rather than freezing
 */
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/gfx/emergencylights.ts'), 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
  // Point Babylon runtime imports at our local stub (explicit relative path
  // for Node ESM; bundler resolution handles it in the real app).
  .replace(/from '@babylonjs\/core[^']*'/g, "from './.emlights-babylon-stub.gen.mjs'");
const genPath = join(root, 'test/.emlights.gen.mjs');
writeFileSync(genPath, out);

// ---- Babylon stub: just enough surface for emergencylights.ts -------------
const STUB_SRC = [
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
].join('\n');
writeFileSync(join(root, 'test/.emlights-babylon-stub.gen.mjs'), STUB_SRC);

const mod = await import(genPath);
const {
  EmergencyLights, selectEmergencyUnits, emergencyPulse, coordHash,
  EMERGENCY_STRIDE, PULSE_HZ,
} = mod;

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

// ---- pure selection --------------------------------------------------------

// synthetic chunk: 60 fixtures on a jittered grid
const chunkFixtures = [];
for (let i = 0; i < 60; i++) {
  chunkFixtures.push({ x: ((i * 13) % 40) - 20 + i * 0.37, z: ((i * 29) % 36) - 18 - i * 0.19 });
}

check('stride constant is 7', EMERGENCY_STRIDE === 7);
check('pulse frequency constant is 0.5 Hz', PULSE_HZ === 0.5);

const units = selectEmergencyUnits(chunkFixtures);
check('one unit per stride-th fixture', units.length === Math.ceil(60 / EMERGENCY_STRIDE),
  'got ' + units.length + ' want ' + Math.ceil(60 / EMERGENCY_STRIDE));

let strideOk = true;
for (let k = 0; k < units.length; k++) {
  const f = chunkFixtures[k * EMERGENCY_STRIDE];
  if (units[k].x !== f.x || units[k].z !== f.z) strideOk = false;
}
check('units sit exactly at fixture positions', strideOk);

check('selection deterministic across calls',
  JSON.stringify(selectEmergencyUnits(chunkFixtures)) === JSON.stringify(units));

check('coordHash stable and in [0,1)',
  (() => {
    let swaps = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 3.17, z = -i * 1.71;
      const a = coordHash(x, z), b = coordHash(x, z);
      if (a !== b || !(a >= 0 && a < 1)) return false;
      if (coordHash(z, x) === coordHash(x, z)) swaps++; // order-sensitive
    }
    // occasional hash collisions are tolerable; systematic symmetry is not
    return swaps <= 10;
  })());

const exits = units.filter((u) => u.exit);
check('some but not all units are EXIT green',
  exits.length > 0 && exits.length < units.length,
  'exits=' + exits.length + '/' + units.length);
check('exit flag keyed to position, not index order',
  (() => {
    const shuffled = [...chunkFixtures].reverse();
    const alt = selectEmergencyUnits(shuffled);
    return alt.every((u) => {
      const orig = units.find((o) => o.x === u.x && o.z === u.z);
      return !orig || orig.exit === u.exit;
    });
  })());
check('phases span the cycle', new Set(units.map((u) => u.phase.toFixed(4))).size > 1);

// ---- pulse shape ------------------------------------------------------------

check('pulse period is exactly 2 s (0.5 Hz)',
  Math.abs(emergencyPulse(0.3, 0) - emergencyPulse(2.3, 0)) < 1e-12
  && Math.abs(emergencyPulse(5.9, 1.1) - emergencyPulse(7.9, 1.1)) < 1e-12);

let lo = Infinity, hi = -Infinity;
for (let t = 0; t <= 2; t += 0.002) {
  const v = emergencyPulse(t, 0);
  if (v < lo) lo = v;
  if (v > hi) hi = v;
}
check('pulse bounded [0.1, 1]', lo >= 0.099 && hi <= 1.001, lo.toFixed(3) + '..' + hi.toFixed(3));
check('pulse actually oscillates (not flat)', hi - lo > 0.8);

// ---- class behaviour against stubbed lights ---------------------------------

const scene = {};
const el = new EmergencyLights(scene);
el.prepare(chunkFixtures);
el.update(0.25, true);

const pool = el.pool;
check('pool allocated', Array.isArray(pool) && pool.length > 0 && pool.length <= 12);

const lit = pool.filter((l) => l.intensity > 0);
check('blackout activates one light per prepared unit (capped by pool)',
  lit.length === Math.min(units.length, pool.length),
  'lit=' + lit.length + ' units=' + units.length + ' pool=' + pool.length);

let placedOk = true;
for (let i = 0; i < Math.min(units.length, pool.length); i++) {
  const l = pool[i], u = units[i];
  if (Math.abs(l.position.x - u.x) > 1e-9 || Math.abs(l.position.z - u.z) > 1e-9) placedOk = false;
  if (l.position.y !== 2.86) placedOk = false;
  const redish = l.diffuse.r > 0.6 && l.diffuse.g < 0.4;
  const greenish = l.diffuse.g > 0.6 && l.diffuse.r < 0.4;
  if (u.exit ? !greenish : !redish) placedOk = false;
}
check('lights parked on unit positions with correct colour tint', placedOk);

const i1 = pool.map((l) => l.intensity);
el.update(0.5, true);
const i2 = pool.map((l) => l.intensity);
check('intensity pulses over time', i1.some((v, i) => pool[i].intensity > 0 && Math.abs(v - i2[i]) > 0.01));

// mid-pulse intensity must be below full brightness (dim, dying batteries)
el.t = 0; el.update(0.0001, true); // reset clock baseline
const peak = Math.max(...pool.filter((l) => l.intensity > 0).map((l) => l.intensity));
check('peak output stays dim (< 1.2)', peak > 0 && peak < 1.2, 'peak=' + peak.toFixed(3));

el.update(1 / 60, false);
check('blackout end kills all intensities', pool.every((l) => l.intensity === 0));
check('parked off-stage when dark', pool.every((l) => l.position.y === -100));

el.update(0.1, true);
el.deactivate();
check('deactivate() hard-offs everything',
  pool.every((l) => l.intensity === 0 && l.position.y === -100));

// ---- oversized chunk: pool cap ----------------------------------------------

const bigChunk = Array.from({ length: 400 }, (_, i) => ({ x: i * 2.5, z: i * -1.25 }));
el.prepare(bigChunk);
el.update(0.2, true);
check('oversized chunk capped at pool size',
  el.pool.every((l) => l.intensity >= 0) && el.units.length > el.pool.length
  && el.pool.filter((l) => l.intensity > 0).length === el.pool.length);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


