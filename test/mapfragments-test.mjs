/**
 * Map fragments tests (src/world/mapfragments.ts, F56).
 * Standalone (no browser): transpiles rng.ts + mapfragments.ts into a temp
 * dir and drives the model directly, same idiom as longhall-test.
 *
 * Acceptance:
 *   1. majority-vote theorem - whenever fewer than half of >=3 fragments
 *      mislabel a cell, voteGrid reproduces the injected ground truth 100%
 *      over fixture grids
 *   2. single corrupt fragment outvoted - one rho=1 cartographer against
 *      clean peers loses every cell and scores ~0 leave-one-out reliability
 *   3. seeded corruptions - fragments are deterministic per
 *      (seed, roomId, index, rho), corruptions are definite WRONG labels,
 *      mismatch rate tracks rho, unique seeds decorrelate fragments
 *   4. documented tie handling - top-count ties resolve to the earliest
 *      LABEL_ORDER entry, identically on every call
 *   5. fail-loud validation - empty sets, dim mismatches, out-of-range
 *      cells, bad rates/indices all throw
 *
 * Run: node test/mapfragments-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-mapfragments-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/mapfragments.ts', 'src/world/mapfragments.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const mf = await import(pathToFileURL(path.join(tmp, 'src/world/mapfragments.mjs')).href);

// ---- fixtures -------------------------------------------------------------
// # = wall, . = floor, D = door
function parseGrid(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const cells = rows.join('').split('').map((c) =>
    c === '#' ? 'wall' : c === 'D' ? 'door' : 'floor');
  return { width, height, cells };
}
const FIXTURES = [
  parseGrid([
    '#####',
    '#...#',
    '#.D.#',
    '#...#',
    '#####',
  ]),
  parseGrid([
    '#######',
    '..D..D#',
    '#.....#',
    '#..###.#'.slice(0, 7),
    '#####.#',
    '......#',
    '#######',
  ]),
  parseGrid(['..D..']),
];

const SEED = 0xca27e56;

function gridsEqual(a, b) {
  return a.width === b.width && a.height === b.height &&
    a.cells.every((c, i) => c === b.cells[i]);
}

// ---- 1. majority-vote theorem over fixture grids --------------------------
// Build fragments where each cell is mislabelled in fewer than half of the
// K fragment slots (deterministic spread), then the vote must be exact.
function buildSubHalfFragments(truth, K) {
  const frags = [];
  for (let f = 0; f < K; f++) {
    frags.push({ fragmentIndex: f, roomId: 'fixture', width: truth.width,
      height: truth.height, cells: [...truth.cells] });
  }
  const LABELS = ['wall', 'floor', 'door'];
  for (let i = 0; i < truth.cells.length; i++) {
    // deterministic per-cell corrupt count in 0..floor((K-1)/2)
    const maxCorrupt = Math.floor((K - 1) / 2);
    const nCorrupt = (i * 7 + K * 3) % (maxCorrupt + 1);
    for (let f = 0; f < nCorrupt; f++) {
      const wrongs = LABELS.filter((l) => l !== truth.cells[i]);
      frags[f].cells[i] = wrongs[(i + f) % wrongs.length];
    }
  }
  return frags;
}
{
  let allExact = true;
  let cases = 0;
  for (const truth of FIXTURES) {
    for (const K of [3, 4, 5, 7]) {
      cases++;
      const frags = buildSubHalfFragments(truth, K);
      if (!gridsEqual(mf.voteGrid(frags), truth)) allExact = false;
      // spot-check voteCell agreement with voteGrid
      if (mf.voteCell(frags, 0, 0) !== mf.voteGrid(frags).cells[0]) allExact = false;
    }
  }
  check(`sub-half corruption -> voteGrid == truth 100% (${cases} fixture/K combos)`, allExact);
}

// ---- 2. seeded generator: determinism + decorrelation ---------------------
{
  const truth = FIXTURES[1];
  const a = mf.makeFragment(truth, '4,-2', 0, SEED, 0.3);
  const b = mf.makeFragment(truth, '4,-2', 0, SEED, 0.3);
  check('makeFragment byte-deterministic per (seed, roomId, index, rho)',
    JSON.stringify(a) === JSON.stringify(b));
  check('fragment carries roomId and dimensions',
    a.roomId === '4,-2' && a.width === truth.width && a.height === truth.height);
  const otherSeed = mf.makeFragment(truth, '4,-2', 0, SEED ^ 0x1234, 0.3);
  check('different seed -> different corruption pattern',
    JSON.stringify(a.cells) !== JSON.stringify(otherSeed.cells));
  const fragSet = [0, 1, 2, 3].map((f) => mf.makeFragment(truth, '4,-2', f, SEED, 0.3));
  const sigs = new Set(fragSet.map((f) => JSON.stringify(f.cells)));
  check('unique seeds per fragment slot -> distinct patterns', sigs.size === 4);
}

// ---- 3. corruptions are definite wrong labels at ~rho --------------------
{
  const truth = FIXTURES[1];
  const RHO = 0.3;
  const frag = mf.makeFragment(truth, 'r', 5, SEED, RHO);
  let mismatch = 0;
  for (let i = 0; i < truth.cells.length; i++) {
    if (frag.cells[i] !== truth.cells[i]) {
      mismatch++;
      if (!mf.LABEL_ORDER.includes(frag.cells[i])) { mismatch = -9999; break; }
    }
  }
  const rate = mismatch / truth.cells.length;
  check('every written label is a legal CellLabel', mismatch !== -9999);
  check(`mismatch rate ${rate.toFixed(3)} tracks rho=${RHO} (loose band 0.12..0.48)`,
    rate > 0.12 && rate < 0.48, String(rate));
}

// ---- 4. single corrupt fragment outvoted ---------------------------------
{
  const truth = FIXTURES[1];
  const clean = [0, 1, 2, 3].map((f) => mf.makeFragment(truth, 'corrupt-case', f, SEED, 0));
  const liar = mf.makeFragment(truth, 'corrupt-case', 9, SEED, 1);
  check('rho=1 fragment disagrees everywhere',
    liar.cells.every((c, i) => c !== truth.cells[i]));
  const voted = mf.voteGrid([...clean, liar]);
  check('one fully corrupt fragment outvoted by 4 clean ones',
    gridsEqual(voted, truth));
  const liarRel = mf.fragmentReliability([...clean, liar], 9);
  const cleanRels = clean.map((f) => mf.fragmentReliability([...clean, liar], f.fragmentIndex));
  check(`corrupt fragment reliability ~0 (${liarRel})`, liarRel < 0.05);
  check(`clean fragment reliabilities ~1 (min ${Math.min(...cleanRels)})`,
    Math.min(...cleanRels) > 0.95);
}

// ---- 5. statistical recovery under honest sampling ------------------------
{
  let agreeCells = 0;
  let totalCells = 0;
  for (const truth of FIXTURES) {
    for (const seedOff of [0, 1, 2]) {
      const frags = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(
        (f) => mf.makeFragment(truth, 'stat', f, (SEED + seedOff * 7919) >>> 0, 0.25));
      const voted = mf.voteGrid(frags);
      for (let i = 0; i < truth.cells.length; i++) {
        totalCells++;
        if (voted.cells[i] === truth.cells[i]) agreeCells++;
      }
    }
  }
  const acc = agreeCells / totalCells;
  check(`majority vote accuracy ${acc.toFixed(3)} >= 0.9 at rho=0.25 K=9`, acc >= 0.9);
}

// ---- 6. documented tie handling -------------------------------------------
{
  const mk = (labels, idx) => ({ fragmentIndex: idx, roomId: 'tie', width: labels.length,
    height: 1, cells: labels });
  const wallFloor = [mk(['wall', 'door'], 0), mk(['floor', 'floor'], 1)];
  check('wall vs floor 1-1 tie resolves to wall (earliest LABEL_ORDER entry)',
    mf.voteCell(wallFloor, 0, 0) === 'wall' && mf.voteCell(wallFloor, 0, 0) === 'wall');
  const floorDoor = [mk(['floor', 'wall'], 0), mk(['door', 'wall'], 1)];
  check('floor vs door 1-1 tie resolves to floor (earliest LABEL_ORDER entry)',
    mf.voteCell(floorDoor, 0, 0) === 'floor');
  check('clear majority beats canonical order',
    mf.voteCell([mk(['door', 'x'], 0), mk(['door', 'x'], 1), mk(['wall', 'x'], 2)], 0, 0) === 'door');
}

// ---- 7. fail-loud validation ----------------------------------------------
{
  const truth = FIXTURES[0];
  const f = mf.makeFragment(truth, 'v', 0, SEED, 0.2);
  const wide = { ...f, fragmentIndex: 1, width: truth.width + 1 };
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  check('voteCell([]) throws', threw(() => mf.voteCell([], 0, 0)));
  check('dim-mismatched voters throw', threw(() => mf.voteGrid([f, wide])));
  check('out-of-range cell throws', threw(() => mf.voteCell([f], 99, 0)));
  check('negative cell throws', threw(() => mf.voteCell([f], -1, 0)));
  check('rho=1.5 rejected', threw(() => mf.makeFragment(truth, 'v', 0, SEED, 1.5)));
  check('negative rho rejected', threw(() => mf.makeFragment(truth, 'v', 0, SEED, -0.1)));
  check('negative fragmentIndex rejected', threw(() => mf.makeFragment(truth, 'v', -1, SEED, 0.2)));
  check('reliability with one fragment throws', threw(() => mf.fragmentReliability([f], 0)));
  check('reliability for absent index throws',
    threw(() => mf.fragmentReliability([f, { ...f, fragmentIndex: 2 }], 7)));
}

console.log(failures === 0 ? 'MAPFRAGMENTS_PASS' : `MAPFRAGMENTS_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
