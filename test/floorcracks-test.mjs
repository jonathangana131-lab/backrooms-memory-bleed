/**
 * Unit test for floor crack decals (src/gfx/floorcracks.ts).
 * Standalone (no browser): transpiles the module (+ its deps) into a
 * temp dir and drives it directly.
 * Run: node test/floorcracks-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-floorcracks-'));
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
emit('src/gfx/floorcracks.ts', 'gfx/floorcracks.mjs');
emit('src/gfx/cornerao.ts', 'gfx/cornerao.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx', 'floorcracks.mjs')).href);
const {
  FloorCracks,
  CRACK_Y,
  MAX_CRACK_SLOTS,
  DISTRICT_CRACK_CHANCE,
  BRANCH_CHANCE,
  MAX_QUADS_PER_CHUNK,
} = mod;

const CELL = 2.5;       // mirrored from src/world/constants.ts
const CHUNK_CELLS = 12;
const CHUNK = CELL * CHUNK_CELLS; // 30 m

const fc = new FloorCracks({ seed: 12345 });

// ---- shape / API -----------------------------------------------------------
check('exports a FloorCracks class with generateForChunk',
  typeof FloorCracks === 'function' && typeof fc.generateForChunk === 'function');

const corridorQuads = fc.generateForChunk(3, -7, 3); // District.CORRIDOR_GRID
check('corridor chunk yields cracks',
  Array.isArray(corridorQuads) && corridorQuads.length > 0,
  'got ' + (corridorQuads && corridorQuads.length));

let structOk = true;
let why = '';
for (const q of corridorQuads) {
  if (!Array.isArray(q.positions) || q.positions.length !== 12) { structOk = false; why = 'positions'; break; }
  if (!Array.isArray(q.normal) || q.normal.length !== 3 ||
      q.normal[0] !== 0 || q.normal[1] !== 1 || q.normal[2] !== 0) { structOk = false; why = 'normal'; break; }
  if (!Array.isArray(q.tints) || q.tints.length !== 12) { structOk = false; why = 'tints'; break; }
  // flat on the floor plane at CRACK_Y, above wear patches (0.002)
  for (let v = 0; v < 4; v++) {
    if (Math.abs(q.positions[v * 3 + 1] - CRACK_Y) > 1e-9) { structOk = false; why = 'y=' + q.positions[v * 3 + 1]; break; }
  }
  if (!structOk) break;
}
check('every quad is a well-formed floor decal at CRACK_Y with up-normal', structOk, why);

check('CRACK_Y sits above the mesher wear patches (WEAR_Y=0.002)', CRACK_Y > 0.002);


