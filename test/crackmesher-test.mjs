/**
 * Unit tests for the wall crack emission adapter (src/world/crackmesher.ts).
 * Standalone (no browser): transpiles the module (+ cracks/constants/rng)
 * into a temp dir and drives it with hand-built CrackInstances.
 * Run: node test/crackmesher-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-crackmesher-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/gfx/cornerao.ts', 'gfx/cornerao.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/world/cracks.ts', 'world/cracks.mjs');
emit('src/world/crackmesher.ts', 'world/crackmesher.mjs');

const mesherMod = await import(pathToFileURL(path.join(tmp, 'world/crackmesher.mjs')).href);
const {
  CrackMesherPass,
  CRACK_DECAL_OFFSET,
  CRACK_GROWTH,
  growthFactor,
  darknessForStage,
  tintForStage,
} = mesherMod;

// Mirrored constants (src/world/constants.ts).
const WALL_H = 3.05;
const EPS = 1e-9;

const crack = (x, z, rotY, stage) => ({ x, z, rotY, stage });

{
  // --- empty input ----------------------------------------------------------
  const quads = new CrackMesherPass().generate([]);
  check('empty crack list yields zero quads', quads.length === 0, 'got ' + quads.length);
}

// One well-behaved anchor for contract checks.
const BASE = crack(12.5, -7.25, Math.PI / 2, 1);
{
  const pass = new CrackMesherPass({ seed: 42 });
  const quads = pass.generate([BASE]);
  check('a crack emits quads', quads.length > 0, 'got ' + quads.length);

  let okShape = true, okNormal = true, okPlane = true, okTintLen = true, okBounds = true;
  for (const q of quads) {
    if (!Array.isArray(q.positions) || q.positions.length !== 12) okShape = false;
    if (!Array.isArray(q.tints) || q.tints.length !== 12) okTintLen = false;
    const n = q.normal;
    if (!Array.isArray(n) || n.length !== 3) { okNormal = false; continue; }
    // rotY = PI/2 faces +x -> axis-aligned unit normal on x
    if (Math.abs(n[0] - 1) > EPS || Math.abs(n[1]) > EPS || Math.abs(n[2]) > EPS) okNormal = false;
    // all four corners sit in the plane offset from the anchor along n
    for (let i = 0; i < 4; i++) {
      const x = q.positions[i * 3], y = q.positions[i * 3 + 1], z = q.positions[i * 3 + 2];
      const along = x * n[0] + y * n[1] + z * n[2];

(Showing lines 1-80 of 184. Use offset=81 to continue.)

