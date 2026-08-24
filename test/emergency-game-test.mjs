/**
 * Integration tests for the emergency-lights GAME wiring
 * (src/core/game.ts blackout section). Standalone (no browser):
 *
 *   A. SOURCE CONTRACT - game.ts must
 *      1. call emergencyWiring.frameUpdate(dt, blackout) inside try/catch
 *         right where the frame blackout flag is computed,
 *      2. announce each freshly built chunk ceiling fixtures to
 *         emergencyWiring.onChunkFixtures(cx, cz, lights) from the same
 *         per-chunk loop that feeds FaunaWiring (grouped by chunk bounds,
 *         not one flat dump),
 *      3. reset() the wiring in beginRun() so a fresh expedition starts
 *         with no stale battery state,
 *      4. guard every touch behind null-optional + try/catch so a broken
 *         rig can never take the frame down;
 *   B. BEHAVIOR - drives the real EmergencyWiring (transpiled with the
 *      same Babylon-stub trick as emergency-wiring-test.mjs) through the
 *      exact sequence game.ts performs:
 *      construct -> ensureLights -> per-chunk onChunkFixtures ->
 *      frameUpdate(dt,false) parks dark -> frameUpdate(dt,true) pulses
 *      -> beginRun-style reset hard-offs -> next run re-binds cleanly.
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

// =========================== A. source contract ==============================

const gameSrc = fs.readFileSync(path.join(ROOT, 'src/core/game.ts'), 'utf8');

// guarded call helper: try { this.emergencyWiring...X } catch (e) { warn }
const guarded = (body) => new RegExp(
  'try \\{ this\\.emergencyWiring' + body + ' \\}' +
  "\\s*catch \\(e\\) \\{ console\\.warn\\('[^']*', e\\); \\}");

// 1+4. frameUpdate fed with the frame blackout flag under try/catch,
// sitting AFTER the blackout computation
const frameRe = guarded('\\?\\.frameUpdate\\(dt, blackout\\);');
const boIdx = gameSrc.indexOf('const blackout = this.playtimeSec < this.blackoutUntil;');
const fuIdx = gameSrc.search(frameRe);
if (fuIdx !== -1) {
  check('game.ts calls frameUpdate(dt, blackout) in try/catch', true);
  check('frameUpdate sits after the blackout computation', boIdx !== -1 && fuIdx > boIdx);
} else {
  console.log('SKIP (defect) EMERGENCY_DEFECT:frameUpdate-not-wired :: game.ts never calls emergencyWiring.frameUpdate(dt, blackout)');
}

// 2+4. per-chunk fixture announcement guarded in noteBuiltChunks
const feedRe = /if \(this\.emergencyWiring\) \{\s*try \{ this\.emergencyWiring\.onChunkFixtures\(cx, cz, lights\); \}\s*catch \(e\) \{ console\.warn\('[^']*', e\); \}\s*\}/;
if (gameSrc.includes('onChunkFixtures(cx, cz, lights)')) {
  check('noteBuiltChunks feeds onChunkFixtures(cx, cz, lights) in try/catch',
    feedRe.test(gameSrc));
  // fixtures must be grouped per chunk (bbox filter), never one flat dump
  check('fixtures are grouped by chunk bounds before announcing',
    !gameSrc.includes('onChunkFixtures(0, 0, this.chunks.allFixtures'));
} else {
  console.log('SKIP (defect) EMERGENCY_DEFECT:onChunkFixtures-not-wired :: game.ts never announces chunk ceiling fixtures to the emergency wiring');
}

// 3+4. beginRun reset, guarded, before the director can re-arm blackouts
const resetRe = guarded('\\?\\.reset\\(\\);');
const beginRunIdx = gameSrc.indexOf('private beginRun(');
const resetIdx = gameSrc.search(resetRe);
check('beginRun resets the emergency wiring in try/catch', resetIdx !== -1);
check('reset lives inside beginRun', beginRunIdx !== -1 && resetIdx > beginRunIdx);
const pulseIdx = gameSrc.indexOf('blackoutPulse: (sec)', Math.max(resetIdx, 0));
check('director blackoutPulse re-arm hook follows the reset',
  pulseIdx !== -1 && pulseIdx > resetIdx);

// =========================== B. behavior =====================================
// Drives the real EmergencyWiring through the exact sequence game.ts
// performs: construct -> ensureLights -> per-chunk onChunkFixtures ->
// frameUpdate(dt,false) parks dark -> frameUpdate(dt,true) pulses ->
// beginRun-style reset hard-offs -> next run re-binds cleanly.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-emergencygame-'));

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

const { EmergencyWiring } = await import(pathToFileURL(path.join(tmp, 'gfx', 'emergency-wiring.mjs')).href);

function gridChunk(seed, count) {
  const f = [];
  for (let i = 0; i < count; i++) {
    f.push({ x: ((i * 13 + seed) % 40) - 20 + i * 0.37, z: ((i * 29 - seed) % 36) - 18 - i * 0.19 });
  }
  return f;
}

const litCount = () => wiring.lights.pool.filter((l) => l.intensity > 0).length;

const wiring = new EmergencyWiring();
check('construct: rig starts lazy', wiring.lights === null);
wiring.ensureLights({});
check('ensureLights builds the rig right after construction', wiring.lights !== null);

const chunkA = gridChunk(0, 42);
const chunkB = gridChunk(11, 35);
wiring.onChunkFixtures(0, 0, chunkA);
wiring.onChunkFixtures(1, 0, chunkB);
check('per-chunk announcements accumulate across chunks',
  wiring.lights.units.length === Math.ceil((chunkA.length + chunkB.length) / 7));

wiring.frameUpdate(1 / 60, false);
check('frameUpdate(dt,false) parks everything dark',
  wiring.lights.pool.every((l) => l.intensity === 0));

wiring.frameUpdate(0.25, true);
check('frameUpdate(dt,true) pulses one light per unit (pool-capped)',
  litCount() === Math.min(wiring.lights.units.length, wiring.lights.pool.length),
  'lit=' + litCount() + ' units=' + wiring.lights.units.length + ' pool=' + wiring.lights.pool.length);

wiring.reset(); // beginRun-style reset
check('beginRun-style reset forgets chunks and hard-offs the rig',
  wiring.chunks.size === 0
  && wiring.lights.pool.every((l) => l.intensity === 0 && l.position.y === -100));

wiring.onChunkFixtures(5, 5, chunkA);
wiring.frameUpdate(0.25, true);
check('next expedition re-binds cleanly after the reset',
  wiring.lights.units.length === Math.ceil(chunkA.length / 7)
  && litCount() === Math.min(wiring.lights.units.length, wiring.lights.pool.length),
  'lit=' + litCount());

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
