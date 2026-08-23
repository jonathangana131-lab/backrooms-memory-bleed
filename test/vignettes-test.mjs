/**
 * Unit test for the environmental vignette system (src/world/vignettes.ts).
 * Standalone (no browser): transpiles vignettes.ts plus its runtime deps
 * (constants.ts, rng.ts) into a temp dir and drives the five scene builders
 * and placeVignette against synthetic ChunkLayouts.
 * Run: node test/vignettes-test.mjs
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

// --- transpile runtime deps into a flat temp dir -------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-vignettes-'));
const SOURCES = [
  ['src/world/constants.ts', 'constants.mjs'],
  ['src/core/rng.ts', 'rng.mjs'],
  ['src/world/vignettes.ts', 'vignettes.mjs'],
];
for (const [rel, out] of SOURCES) {
  let js = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    fileName: rel,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // rewrite relative specifiers for the flat output dir
  js = js
    .replace(/from '\.\/constants'/g, "from './constants.mjs'")
    .replace(/from '\.\.\/core\/rng'/g, "from './rng.mjs'");
  fs.writeFileSync(path.join(tmp, out), js);
}
const mod = await import(pathToFileURL(path.join(tmp, 'vignettes.mjs')).href);
const rngMod = await import(pathToFileURL(path.join(tmp, 'rng.mjs')).href);
const conMod = await import(pathToFileURL(path.join(tmp, 'constants.mjs')).href);
const { VIGNETTES, VIGNETTE_CHANCE, abandonedMeal, makeshiftBed, researchStation, waitingRoom, signalShrine, placeVignette } = mod;
const { RNG, hash2i } = rngMod;
const { District, EdgeCode, CELL, CHUNK_CELLS } = conMod;

const VALID_KINDS = new Set([
  'desk', 'chair', 'cabinet', 'sofa', 'bed', 'locker', 'gurney', 'bench',
  'planter', 'turnstile', 'crate', 'stacked_chairs', 'tv', 'bedframe',
  'vending', 'whiteboard', 'cooler', 'couch_l', 'shelf', 'battery',
]);

const N = CHUNK_CELLS;

/** Synthetic open-floored chunk layout. */
function mkLayout(opts = {}) {
  const { district = District.OPEN_OFFICE, open = true, landmark = null, cx = 5, cz = -3 } = opts;
  const code = open ? EdgeCode.OPEN : EdgeCode.SOLID;
  const layout = {
    cx, cz,
    hEdges: new Uint8Array((N + 1) * N).fill(code),
    vEdges: new Uint8Array(N * (N + 1)).fill(code),
    district,
    lights: [], props: [], signs: [], notes: [],
    puddles: [], wires: [], stains: [], graffiti: [],
    memKind: 0, memIntensity: 0.3,
  };
  if (landmark) layout.landmark = landmark;
  return layout;
}

const BUILDERS = [
  ['abandoned_meal', abandonedMeal],
  ['makeshift_bed', makeshiftBed],
  ['research_station', researchStation],
  ['waiting_room', waitingRoom],
  ['signal_shrine', signalShrine],
];

// --- catalog shape --------------------------------------------------------
check('VIGNETTES holds all five scenes', VIGNETTES.length === 5, String(VIGNETTES.length));
check('VIGNETTE ids unique', new Set(VIGNETTES.map((v) => v.id)).size === 5);
check('exported builders match VIGNETTES entries',
  VIGNETTES.every((v) => BUILDERS.some(([id, fn]) => id === v.id && fn === v.build)));

let minProps = Infinity;
let maxProps = 0;
for (const def of VIGNETTES) {
  const props = def.build(100, 100, 0);
  minProps = Math.min(minProps, props.length);
  maxProps = Math.max(maxProps, props.length);
  check(def.id + ': every prop kind is a known PropKind',
    props.every((p) => VALID_KINDS.has(p.kind)),
    JSON.stringify(props.filter((p) => !VALID_KINDS.has(p.kind)).map((p) => p.kind)));
  check(def.id + ': rotations are quarter turns',
    props.every((p) => Number.isInteger(p.rot) && p.rot >= 0 && p.rot <= 3));
  check(def.id + ': variants are numbers', props.every((p) => typeof p.variant === 'number'));
  check(def.id + ': scene stays within 3 m of its anchor',
    props.every((p) => Math.hypot(p.x - 100, p.z - 100) <= 3.0),
    JSON.stringify(props.map((p) => [p.x - 100, p.z - 100])));
}
check('each scene tells a story with >= 3 props', minProps >= 3, String(minProps));
console.log('       prop counts per scene: ' + VIGNETTES.map((v) => v.build(0, 0, 0).length).join(', ')
  + ' (min ' + minProps + ', max ' + maxProps + ')');

// --- rotation composes as a rigid quarter-turn ----------------------------
{
  const a = abandonedMeal(100, 100, 0);
  const b = abandonedMeal(100, 100, 2);
  let symmetric = a.length === b.length;
  if (symmetric) {
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(b[i].x - (200 - a[i].x)) > 1e-9) symmetric = false;
      if (Math.abs(b[i].z - (200 - a[i].z)) > 1e-9) symmetric = false;
    }
  }
  check('rot 2 mirrors rot 2*centre - offsets exactly', symmetric);
  const kindsOf = (props) => props.map((p) => p.kind).sort().join(',');
  const base = kindsOf(abandonedMeal(0, 0, 0));
  check('all four orientations use identical prop sets',
    [1, 2, 3].every((r) => kindsOf(abandonedMeal(0, 0, r)) === base));
  // rot 1 maps local (ox, oz) to (-oz, ox): chair pushed back along +z goes to -x
  const r1 = abandonedMeal(0, 0, 1);
  const deskR1 = r1.find((p) => p.kind === 'desk');
  const chairBack = r1.find((p) => p.kind === 'chair' && Math.abs(p.x + 1.18) < 1e-9 && Math.abs(p.z - 0.32) < 1e-9);
  check('rot 1 rotates offsets counter-clockwise', !!deskR1 && !!chairBack);
}

// --- placeVignette determinism --------------------------------------------
{
  const SEED = 1234;
  const run = () => {
    const layout = mkLayout();
    const placed = placeVignette(layout, new RNG(hash2i(7, 11, SEED ^ 0x7616)));
    return { placed, props: layout.props.map((p) => [p.kind, p.x, p.z, p.rot, p.variant]) };
  };
  const r1 = run();
  const r2 = run();
  check('identical inputs give identical placement',
    JSON.stringify(r1) === JSON.stringify(r2));
  if (r1.placed) {
    check('a placement adds only vignette props',
      r1.props.length >= 3 && r1.props.length <= 6, String(r1.props.length));
  }
}

// --- rarity: about 2 percent of suitable chunks ----------------------------
{
  const SEED = 0xbeef;
  const SUITABLE = [District.OPEN_OFFICE, District.HONEYCOMB, District.CORRIDOR_GRID];
  let placedCount = 0;
  const TRIALS = 4000;
  for (let i = 0; i < TRIALS; i++) {
    const cx = i % 61;
    const cz = (i / 61) | 0;
    const layout = mkLayout({ district: SUITABLE[i % 3], cx, cz });
    if (placeVignette(layout, new RNG(hash2i(cx, cz, SEED)))) {
      placedCount++;
      if (layout.props.length === 0) { placedCount = -999; }
    }
  }
  const rate = placedCount / TRIALS;
  check('placement rate lands near 2 percent (0.5..6)', rate > 0.005 && rate < 0.06, 'rate=' + rate.toFixed(4));
  console.log('       observed rate over ' + TRIALS + ' chunks: ' + (rate * 100).toFixed(2) + '%');
  check('VIGNETTE_CHANCE constant is 0.02', VIGNETTE_CHANCE === 0.02);
}

// --- unsuitable chunks never receive one -----------------------------------
{
  const SEED = 77;
  let bad = 0;
  for (let i = 0; i < 1500; i++) {
    const cx = i % 40, cz = (i / 40) | 0;
    for (const district of [District.STORAGE, District.MAZE]) {
      const layout = mkLayout({ district, cx, cz });
      if (placeVignette(layout, new RNG(hash2i(cx, cz, SEED + district)))) bad++;
    }
    const walled = mkLayout({ cx, cz, open: false });
    if (placeVignette(walled, new RNG(hash2i(cx, cz, SEED + 99)))) bad++;
    const lm = mkLayout({ cx, cz, landmark: 'CHAPEL' });
    if (placeVignette(lm, new RNG(hash2i(cx, cz, SEED + 55)))) bad++;
  }
  check('STORAGE, MAZE, walled and landmark chunks stay empty', bad === 0, String(bad));
}

// --- spawn plaza stays clear near origin -----------------------------------
{
  let closest = Infinity;
  for (let s = 0; s < 300; s++) {
    const layout = mkLayout({ cx: 0, cz: 0 });
    if (!placeVignette(layout, new RNG(hash2i(0, 0, s)))) continue;
    for (const p of layout.props) closest = Math.min(closest, Math.hypot(p.x, p.z));
  }
  check('no vignette prop inside the 9 m spawn plaza', closest >= 9, 'closest=' + closest.toFixed(2));
}

// --- crowded floors suppress placement -------------------------------------
{
  let placedOnCrowded = 0;
  for (let s = 0; s < 50; s++) {
    const layout = mkLayout({ cx: 3, cz: 4 });
    // furniture at every cell centre leaves no clear 3.4 m window
    for (let lz = 0; lz < N; lz++) {
      for (let lx = 0; lx < N; lx++) {
        layout.props.push({ kind: 'crate', x: (layout.cx * N + lx + 0.5) * CELL, z: (layout.cz * N + lz + 0.5) * CELL, rot: 0, variant: 0 });
      }
    }
    if (placeVignette(layout, new RNG(hash2i(3, 4, s)))) placedOnCrowded++;
  }
  check('never overlaps dense existing furniture', placedOnCrowded === 0, String(placedOnCrowded));
}

// --- placements respect chunk bounds and edge openness ----------------------
{
  const SEED = 424242;
  let okBounds = true;
  let okOpen = true;
  let anyPlaced = false;
  for (let i = 0; i < 800; i++) {
    const cx = (i % 20) - 10, cz = ((i / 20) | 0) - 10;
    const layout = mkLayout({ cx, cz });
    if (!placeVignette(layout, new RNG(hash2i(cx, cz, SEED)))) continue;
    anyPlaced = true;
    const x0 = cx * N * CELL, x1 = (cx + 1) * N * CELL;
    const z0 = cz * N * CELL, z1 = (cz + 1) * N * CELL;
    for (const p of layout.props) {
      if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) okBounds = false;
      const lx = Math.floor(p.x / CELL) - cx * N;
      const lz = Math.floor(p.z / CELL) - cz * N;
      const openCell =
        layout.hEdges[lz * N + lx] === EdgeCode.OPEN &&
        layout.hEdges[(lz + 1) * N + lx] === EdgeCode.OPEN &&
        layout.vEdges[lz * (N + 1) + lx] === EdgeCode.OPEN &&
        layout.vEdges[lz * (N + 1) + lx + 1] === EdgeCode.OPEN;
      if (!openCell) okOpen = false;
    }
  }
  check('sample produced at least one placement', anyPlaced);
  check('all placed props stay inside their chunk', okBounds);
  check('all placed props sit on fully open cells', okOpen);
}

// --- robustness against arbitrary edge data ---------------------------------
{
  let threw = false;
  try {
    for (let s = 0; s < 400; s++) {
      const layout = mkLayout({});
      for (let i = 0; i < layout.hEdges.length; i++) layout.hEdges[i] = hash2i(i, s, 1) % 3;
      for (let i = 0; i < layout.vEdges.length; i++) layout.vEdges[i] = hash2i(s, i, 2) % 3;
      placeVignette(layout, new RNG(hash2i(1, 2, s)));
    }
  } catch (e) { threw = true; }
  check('handles mixed SOLID/OPEN/DOORWAY edges without throwing', !threw);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);


