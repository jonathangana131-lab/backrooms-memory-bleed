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
// src/world/constants.ts lost its head during transcript corruption; these
// exports are mirrored verbatim from recovery slices so tests can load the
// real modules without touching src/. Drop once src is whole again.
const CONSTANTS_TS_RESTORED = `
/** World scale constants. All units are meters. */
export const CELL = 2.5;
export const CHUNK_CELLS = 12;
export const CHUNK_SIZE = CELL * CHUNK_CELLS; // 30 m
export const WALL_H = 3.05;
export const WALL_T = 0.16;

export const enum EdgeCode {
  OPEN = 0,
  SOLID = 1,
  DOORWAY = 2,
}

export function worldToCell(w) { return Math.floor(w / CELL); }
export function cellToWorld(c) { return (c + 0.5) * CELL; }
export function worldToChunk(w) { return Math.floor(w / CHUNK_SIZE); }
`;
emit('src/gfx/cornerao.ts', 'gfx/cornerao.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');
fs.writeFileSync(path.join(tmp, 'world', 'constants.mjs'),
  ts.transpileModule(CONSTANTS_TS_RESTORED,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
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


        const plane = BASE.x * n[0] + BASE.z * n[2]; // raw wall face through the anchor
        if (Math.abs((along - plane) - 0.008) > 1e-6) okPlane = false;
        if (!(y >= 0 && y <= WALL_H)) okBounds = false;
      }
    }
    check('quads follow the decal contract (shape/normal/plane/bounds/tints)',
      okShape && okNormal && okPlane && okTintLen && okBounds,
      'shape=' + okShape + ' normal=' + okNormal + ' plane=' + okPlane
      + ' tints=' + okTintLen + ' bounds=' + okBounds);
}


{
  // --- offset keeps quads off the raw wall face ------------------------------
  const pass = new CrackMesherPass({ seed: 42 });
  const quads = pass.generate([crack(3, 4, 0, 0)]);
  let ok = quads.length > 0;
  for (const q of quads) {
    const n = q.normal;
    const d = q.positions[0] * n[0] + q.positions[2] * n[2]
      - (3 * n[0] + 4 * n[2]);
    if (Math.abs(d - CRACK_DECAL_OFFSET) > 1e-6) ok = false;
  }
  check('decals sit CRACK_DECAL_OFFSET proud of the wall', ok);
}

{
  // --- growth law ------------------------------------------------------------
  let ok = true;
  // MAX_STAGE is 3 (src/world/cracks.ts): stages clamp there.
  for (let s = 0; s <= 5; s++) {
    if (growthFactor(s) !== 1 + CRACK_GROWTH * Math.min(s, 3)) ok = false;
  }
  if (growthFactor(0) !== 1) ok = false;
  if (growthFactor(4) !== growthFactor(3)) ok = false;
  if (!(growthFactor(3) > growthFactor(1))) ok = false;
  check('growthFactor escalates per stage from 1', ok);
}

{
  // --- darkness / tint laws --------------------------------------------------
  let ok = true;
  if (darknessForStage(0) !== 0.5) ok = false;
  if (!(darknessForStage(9) <= 0.95)) ok = false; // capped
  if (!(darknessForStage(4) > darknessForStage(1))) ok = false;
  if (tintForStage(0) !== 1 - 0.5 * 0.45) ok = false;
  if (!(tintForStage(6) < tintForStage(0))) ok = false; // darker with age
  check('darknessForStage darkens and caps; tintForStage mirrors it', ok);
}

{
  // --- stage escalation is visible on real geometry --------------------------
  const pass = new CrackMesherPass({ seed: 42 });
  const fresh = pass.generate([crack(-2, 5, Math.PI, 0)]);
  const old = pass.generate([crack(-2, 5, Math.PI, 4)]);
  let maxFresh = 0, maxOld = 0;
  for (const q of fresh) maxFresh = Math.max(maxFresh, ...q.positions.filter((_, i) => i % 3 === 1));
  for (const q of old) maxOld = Math.max(maxOld, ...q.positions.filter((_, i) => i % 3 === 1));
  check('older cracks span taller decals (growth factor)', old.length >= fresh.length
    && maxOld >= maxFresh, 'freshY=' + maxFresh.toFixed(3) + ' oldY=' + maxOld.toFixed(3));

  let minTintFresh = 1, minTintOld = 1;
  for (const q of fresh) minTintFresh = Math.min(minTintFresh, ...q.tints);
  for (const q of old) minTintOld = Math.min(minTintOld, ...q.tints);
  check('older cracks render darker tints', minTintOld < minTintFresh);
}

{
  // --- determinism -----------------------------------------------------------
  const a = new CrackMesherPass({ seed: 7 }).generate([BASE, crack(1, 1, 0, 2)]);
  const b = new CrackMesherPass({ seed: 7 }).generate([BASE, crack(1, 1, 0, 2)]);
  const c = new CrackMesherPass({ seed: 8 }).generate([BASE, crack(1, 1, 0, 2)]);
  check('same seed -> byte-identical quad lists',
    JSON.stringify(a) === JSON.stringify(b));
  check('different seed -> different jagged shape',
    JSON.stringify(a) !== JSON.stringify(c));
}

{
  // --- input hygiene ---------------------------------------------------------
  const pass = new CrackMesherPass({ seed: 1 });
  const quads = pass.generate([null, { x: NaN, z: 0, rotY: 0, stage: 1 }, BASE]);
  check('non-finite/null instances are skipped', quads.length > 0
    && quads.every((q) => q.positions.every(Number.isFinite)));
}

process.exit(failures === 0 ? 0 : 1);
