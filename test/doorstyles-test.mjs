/**
 * Unit test for district door frame styles (src/gfx/doorstyles.ts).
 * Standalone (no browser): transpiles the module (+ its deps) into a temp
 * dir and drives the pure logic directly.
 * Run: node test/doorstyles-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-doorstyles-'));
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
emit('src/gfx/doorstyles.ts', 'gfx/doorstyles.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const { DoorStyles, DOOR_W } = await import(pathToFileURL(path.join(tmp, 'gfx/doorstyles.mjs')).href);

// --- forDistrict: family mapping -------------------------------------------
{
  const maze = DoorStyles.forDistrict(0);
  const office = DoorStyles.forDistrict(1);
  const honeycomb = DoorStyles.forDistrict(2);
  const storage = DoorStyles.forDistrict(4);

  check('MAZE gets simple flat trim', maze.id.startsWith('maze-flat') && maze.kickH === 0 && maze.brace === 0,
    JSON.stringify(maze));
  check('OPEN_OFFICE gets commercial frame', office.id.startsWith('office-commercial') && office.kickH > 0,
    JSON.stringify(office.id));
  check('HONEYCOMB shares the commercial family', honeycomb.id.startsWith('office-commercial'),
    JSON.stringify(honeycomb.id));
  check('STORAGE gets angle-iron frame', storage.brace > 0 && storage.kickH === 0,
    JSON.stringify(storage.id));
  check('commercial jambs are wider than maze jambs', office.jambW > maze.jambW,
    office.jambW + ' vs ' + maze.jambW);

  // CORRIDOR_GRID (3) is unspecified: must fall back safely to simple trim.
  const corridor = DoorStyles.forDistrict(3);
  check('CORRIDOR_GRID falls back without throwing', !!corridor && typeof corridor.jambW === 'number',
    JSON.stringify(corridor));
  // Unknown districts must not explode either.
  const weird = DoorStyles.forDistrict(99);
  check('unknown district falls back without throwing', !!weird && typeof weird.jambW === 'number');
}

// --- generateForDoorway: shape of returned specs ----------------------------
{
  const boxes = DoorStyles.generateForDoorway(4, 7, 0, 1);
  check('returns a non-empty array', Array.isArray(boxes) && boxes.length >= 3, String(boxes.length));
  const allValid = boxes.every(b =>
    Number.isFinite(b.x) && Number.isFinite(b.z) &&
    Number.isFinite(b.w) && b.w > 0 &&
    Number.isFinite(b.h) && b.h > 0 &&
    Array.isArray(b.tint) && b.tint.length === 3 && b.tint.every(t => t >= 0));
  check('all box specs are finite and positive', allValid, JSON.stringify(boxes));

  // orientation 0: boxes vary along x, share the z band
  const zSet = new Set(boxes.map(b => b.z));
  const xSpread = Math.max(...boxes.map(b => b.x)) - Math.min(...boxes.map(b => b.x));
  check('orientation 0 spreads along x with fixed z', zSet.size === 1 && xSpread > DOOR_W,
    'zSet=' + zSet.size + ' xSpread=' + xSpread.toFixed(3));

  // orientation 1: mirrored
  const vbox = DoorStyles.generateForDoorway(4, 7, 1, 1);
  const xSetV = new Set(vbox.map(b => b.x));
  const zSpreadV = Math.max(...vbox.map(b => b.z)) - Math.min(...vbox.map(b => b.z));
  check('orientation 1 spreads along z with fixed x', xSetV.size === 1 && zSpreadV > DOOR_W,
    'xSet=' + xSetV.size + ' zSpread=' + zSpreadV.toFixed(3));
}

// --- determinism -------------------------------------------------------------
{
  const a = DoorStyles.generateForDoorway(-13, 42, 0, 4);
  const b = DoorStyles.generateForDoorway(-13, 42, 0, 4);
  check('same doorway reproduces identical geometry', JSON.stringify(a) === JSON.stringify(b));

  // Different doorways should roll different variants most of the time.
  let variantDiffs = 0;
  const N = 64;
  for (let i = 0; i < N; i++) {
    const ba = DoorStyles.generateForDoorway(i, 0, 0, 1);
    const bb = DoorStyles.generateForDoorway(i, 1, 0, 1);
    if (JSON.stringify(ba) !== JSON.stringify(bb)) variantDiffs++;
  }
  check('adjacent doorways usually differ', variantDiffs >= N * 0.9, variantDiffs + '/' + N);

  // Width jitter stays within +/-5% of nominal and actually varies.
  // The clear opening between jamb INNER faces is exactly 2*dw regardless
  // of which variant's jambW was rolled, so measure that directly.
  let minScale = Infinity, maxScale = -Infinity;
  for (let x = 0; x < 128; x++) {
    for (const d of [0, 1, 2, 4]) {
      const boxes = DoorStyles.generateForDoorway(x, x * 3 + 1, 0, d)
        .filter(bb => !bb.y)
        .sort((p, q) => p.x - q.x);
      const lo = boxes[0], hi = boxes[boxes.length - 1];
      const gap = (hi.x - hi.w / 2) - (lo.x + lo.w / 2); // inner-face span
      const scale = gap / DOOR_W;
      minScale = Math.min(minScale, scale);
      maxScale = Math.max(maxScale, scale);
    }
  }
  const EPS = 1e-9;
  check('width variation within +/-5%', minScale >= 0.95 - EPS && maxScale <= 1.05 + EPS,
    '[' + minScale.toFixed(4) + ', ' + maxScale.toFixed(4) + ']');
  check('width variation actually varies', maxScale - minScale > 0.04,
    'spread=' + (maxScale - minScale).toFixed(4));
}

// --- family-specific extras --------------------------------------------------
{
  const mazeBoxes = DoorStyles.generateForDoorway(9, 9, 0, 0);
  check('maze trim is just jambs + casing (3 boxes)', mazeBoxes.length === 3, String(mazeBoxes.length));
  check('maze has no raised accent boxes', mazeBoxes.every(b => !b.y || b.y > 1), JSON.stringify(mazeBoxes.map(b => b.y)));

  // Commercial frames add two kick plates regardless of rolled variant.
  for (let x = 0; x < 32; x++) {
    const boxes = DoorStyles.generateForDoorway(x, 5, 1, 2);
    const plates = boxes.filter(b => b.y > 0 && b.y < 1 && b.h <= 0.5).length;
    if (plates !== 2) { check('honeycomb always adds exactly 2 kick plates', false, 'x=' + x + ' plates=' + plates); break; }
    if (x === 31) check('honeycomb always adds exactly 2 kick plates', true);
  }

  // Storage frames add two angle braces near the header.
  for (let x = 0; x < 32; x++) {
    const boxes = DoorStyles.generateForDoorway(x, -6, 0, 4);
    // braces sit just below door top: raised but under DOOR_H, small
    const braces = boxes.filter(b => b.y > 1 && b.y < 2.14 && b.h <= 0.3).length;
    if (braces !== 2) { check('storage always adds exactly 2 angle braces', false, 'x=' + x + ' braces=' + braces); break; }
    if (x === 31) check('storage always adds exactly 2 angle braces', true);
  }

  // Accent boxes carry a darker accent tint (either industrial variant).
  const st = DoorStyles.generateForDoorway(3, -6, 0, 4);
  const braceBox = st.find(b => b.y > 1 && b.y < 2.14 && b.h <= 0.3);
  const knownAccents = ['[0.33,0.31,0.29]', '[0.3,0.28,0.27]'];
  check('braces use an accent tint', knownAccents.includes(JSON.stringify(braceBox.tint)),
    JSON.stringify(braceBox.tint));
}

console.log(failures === 0 ? '\nALL TESTS PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);


