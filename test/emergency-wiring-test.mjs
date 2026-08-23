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


