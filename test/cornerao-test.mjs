/**
 * Unit tests for baked corner AO (src/gfx/cornerao.ts).
 * Standalone (no browser): transpiles the module (+ constants) into a temp
 * dir and drives it with hand-built layouts.
 * Run: node test/cornerao-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-cornerao-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/gfx/cornerao.ts', 'gfx/cornerao.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx/cornerao.mjs')).href);
const { CornerAO, AO_HEIGHT, AO_WIDTH, AO_STRENGTH } = mod;

// Mirrored layout constants (src/world/constants.ts).
const N = 12;        // CHUNK_CELLS
const CELL = 2.5;
const WALL_H = 3.05;
const WALL_T = 0.16;
const SOLID = 1, OPEN = 0, DOORWAY = 2;

function makeLayout(hFill, vFill) {
  const hEdges = new Uint8Array(N * N);
  const vEdges = new Uint8Array(N * (N + 1));
  hFill?.(hEdges);
  vFill?.(vEdges);
  return { cx: 3, cz: -2, hEdges, vEdges };
}

function minTint(q) {
  let m = Infinity;
  for (const t of q.tints) m = Math.min(m, t);
  return m;
}

{


  // --- empty chunk: no walls, no quads ------------------------------------
  const ao = new CornerAO();
  const qs = ao.generateForChunk(makeLayout());
  check('empty layout yields zero quads', qs.length === 0, 'got ' + qs.length);
}

{
  // --- straight wall run: only end caps darken ----------------------------
  // one full row of SOLID horizontal edges at lz=6 -> a straight wall with
  // two free ends; interior collinear vertices must stay clean.
  const layout = makeLayout((h) => { for (let lx = 0; lx < N; lx++) h[6 * N + lx] = SOLID; });
  const qs = new CornerAO().generateForChunk(layout);
  // each end cap: 2 faces x 2 bands (floor+ceiling) = 4 quads
  check('straight run emits exactly 8 quads (two end caps)', qs.length === 8, 'got ' + qs.length);
  // every quad's along-wall span must reach one of the two wall ends
  // (quads extend inward from their anchor, so the span contains it)
  const reachesEnd = qs.every((q) => {
    const xs = q.positions.filter((_, i) => i % 3 === 0);
    return Math.min(...xs) <= 0.001 || Math.max(...xs) >= 12 * CELL - 0.001;
  });
  check('quads anchor at the two wall ends', reachesEnd);
  const midX = 6 * CELL;
  const nearMid = qs.filter((q) => Math.abs(Math.min(q.positions[0], q.positions[3]) - midX) < CELL / 2);
  check('no darkening mid-wall', nearMid.length === 0, 'got ' + nearMid.length);
}

{
  // --- L corner: both walls get quads on both faces -----------------------
  const layout = makeLayout(
    (h) => { for (let lx = 3; lx < N; lx++) h[6 * N + lx] = SOLID; },   // runs east from vertex (3,6)
    (v) => { for (let lz = 6; lz < N; lz++) v[lz * (N + 1) + 3] = SOLID; }, // runs south from vertex (3,6)
  );
  const qs = new CornerAO().generateForChunk(layout);
  const horiz = qs.filter((q) => q.normal[2] !== 0);
  const vert = qs.filter((q) => q.normal[0] !== 0);
  check('L corner: quads on the horizontal wall', horiz.length >= 8, 'got ' + horiz.length);
  check('L corner: quads on the vertical wall too', vert.length >= 8, 'got ' + vert.length);
  // The L has three anchored vertices: the corner (3,6) with 2 solid edges
  // (8 quads) and two free end caps (12,6) and (3,12) with 1 edge (4 each).
  check('L layout yields 16 quads total', qs.length === 16, 'got ' + qs.length);
  // group quads by their dark corner (v0) rounded to the lattice; every
  // quad must sit exactly on a lattice vertex anchor
  const groups = new Map();
  for (const q of qs) {
    const key = Math.round(q.positions[0] / CELL) + ',' + Math.round(q.positions[2] / CELL);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  check('corner vertex carries 8 quads', groups.get('3,6') === 8, JSON.stringify([...groups]));
  check('end caps carry 4 quads each', groups.get('12,6') === 4 && groups.get('3,12') === 4);
  // both faces of the horizontal wall present (normals -z and +z)
  const nzs = new Set(horiz.map((q) => q.normal[2]));
  check('both faces of horizontal wall covered', nzs.has(-1) && nzs.has(1), [...nzs].join(','));
  const nxs = new Set(vert.map((q) => q.normal[0]));
  check('both faces of vertical wall covered', nxs.has(-1) && nxs.has(1), [...nxs].join(','));
}

{
  // --- gradient + subtlety -------------------------------------------------
  const layout = makeLayout(
    (h) => { for (let lx = 3; lx < N; lx++) h[6 * N + lx] = SOLID; },


    (v) => { for (let lz = 6; lz < N; lz++) v[lz * (N + 1) + 3] = SOLID; },
  );
  const qs = new CornerAO().generateForChunk(layout);
  const darkest = Math.min(...qs.map(minTint));
  check('max darkening factor is exactly 0.25 (tint 0.75)', Math.abs(darkest - (1 - AO_STRENGTH)) < 1e-9, 'darkest tint ' + darkest);
  check('no tint below 0.75 anywhere', qs.every((q) => minTint(q) >= 1 - AO_STRENGTH - 1e-9));
  const floorBands = qs.filter((q) => Math.min(...q.positions.filter((_, i) => i % 3 === 1)) === 0);
  check('floor bands exist and start at y=0', floorBands.length > 0);
  for (const q of floorBands) {
    const ys = q.positions.filter((_, i) => i % 3 === 1);
    check('floor band tops out at 0.6m', Math.abs(Math.max(...ys) - AO_HEIGHT) < 1e-9, String(Math.max(...ys)));
  }
  const ceilBands = qs.filter((q) => Math.max(...q.positions.filter((_, i) => i % 3 === 1)) === WALL_H);
  check('ceiling bands hang from WALL_H', ceilBands.length > 0);
  for (const q of ceilBands) {
    const ys = q.positions.filter((_, i) => i % 3 === 1);
    check('ceiling band bottom at WALL_H-0.6', Math.abs(Math.min(...ys) - (WALL_H - AO_HEIGHT)) < 1e-9, String(Math.min(...ys)));
    const topDark = q.tints.slice(0, 3).every((t) => t < 1);
    const botLight = q.tints.slice(9, 12).every((t) => t === 1);
    check('ceiling band darkest at top', topDark && botLight, JSON.stringify(q.tints));
  }
  for (const q of floorBands) {
    const firstDark = q.tints.slice(0, 3).every((t) => t < 1);
    const restLight = q.tints.slice(3).every((t) => t === 1);
    check('floor band darkest at floor corner', firstDark && restLight, JSON.stringify(q.tints));
  }
}

{
  // --- geometry hygiene: offsets outside the wall, widths feather ----------
  const layout = makeLayout(
    (h) => { for (let lx = 3; lx < N; lx++) h[6 * N + lx] = SOLID; },
    (v) => { for (let lz = 6; lz < N; lz++) v[lz * (N + 1) + 3] = SOLID; },
  );
  const qs = new CornerAO().generateForChunk(layout);
  const halfT = WALL_T / 2;
  for (const q of qs) {
    const planeVals = q.normal[2] !== 0 ? q.positions.filter((_, i) => i % 3 === 2) : q.positions.filter((_, i) => i % 3 === 0);
    const pv = planeVals[0];
    check('quad plane constant consistent', planeVals.every((v) => Math.abs(v - pv) < 1e-9));
    const off = Math.abs(pv - (6 * CELL));
    check('plane sits proud of wall face', off > halfT && off <= halfT + 0.05, 'off ' + off.toFixed(4));
    // feather width along the wall equals AO_WIDTH
    const sVals = q.normal[2] !== 0 ? q.positions.filter((_, i) => i % 3 === 0) : q.positions.filter((_, i) => i % 3 === 2);
    const spread = Math.max(...sVals) - Math.min(...sVals);
    check('feather width == AO_WIDTH', Math.abs(spread - AO_WIDTH) < 1e-9, String(spread));
    break; // spot-check one representative quad per property group below instead of spamming
  }
  const vx = 3 * CELL, vz = 6 * CELL;
  const badPlane = qs.filter((q) => {
    // horizontal walls run along the vz line; vertical walls along vx
    const center = q.normal[2] !== 0 ? vz : vx;
    const pv = q.normal[2] !== 0 ? q.positions[2] : q.positions[0];
    const off = Math.abs(pv - center);
    return !(off > WALL_T / 2 && off <= WALL_T / 2 + 0.05);
  });
  check('all quads offset outside wall faces', badPlane.length === 0, 'bad ' + badPlane.length);
}

{
  // --- T junction: three walls meet ----------------------------------------
  const layout = makeLayout(
    (h) => { h[6 * N + 3] = SOLID; h[6 * N + 4] = SOLID; }, // east+west of vertex (3? no)
    (v) => { v[6 * (N + 1) + 4] = SOLID; },                 // south of vertex (4,6)
  );
  const qs = new CornerAO().generateForChunk(layout);
  // Composition: the T junction at vertex (4,6) has sHL+sHR+sVD =>
  // 3 edges x 2 faces x 2 bands = 12 quads. The remaining quads are free
  // end caps of the adjacent runs: vertices (3,6) and (5,6) on the wall row
  // and (4,7) at the far end of the stub, 4 each => 12 + 12 = 24 total.
  check('T junction layout yields 24 quads', qs.length === 24, 'got ' + qs.length);
  // The T vertex itself must be the largest anchor group: 3 walls' worth.
  const groups = new Map();
  for (const q of qs) {
    const key = Math.round(q.positions[0] / CELL) + ',' + Math.round(q.positions[2] / CELL);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  check('T junction vertex carries 12 quads', groups.get('4,6') === 12, JSON.stringify([...groups]));
}

{
  // --- collinear-only pair skipped ------------------------------------------
  const layout = makeLayout((h) => { h[6 * N + 3] = SOLID; h[6 * N + 4] = SOLID; });
  const qs = new CornerAO().generateForChunk(layout);
  // only the outer free ends of the 2-cell run produce quads: 2 ends x 4 = 8
  check('collinear seam stays clean (only end caps)', qs.length === 8, 'got ' + qs.length);
}

{
  // --- DOORWAY edges are ignored --------------------------------------------
  const layout = makeLayout(
    (h) => { h[6 * N + 3] = DOORWAY; h[6 * N + 4] = SOLID; },
    (v) => { v[6 * (N + 1) + 3] = DOORWAY; },
  );
  const qs = new CornerAO().generateForChunk(layout);
  // Doorway edges never spawn AO. Only the SOLID edge (lx=4) contributes,
  // via its two free ends: vertices (4,6) and (5,6), 4 quads each.
  check('doorway jambs do not spawn AO', qs.length === 8, 'got ' + qs.length);
  const groups = new Map();
  for (const q of qs) {
    const key = Math.round(q.positions[0] / CELL) + ',' + Math.round(q.positions[2] / CELL);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  check('no quad anchored at doorway vertex (3,6)', !groups.has('3,6'), JSON.stringify([...groups]));
}

{
  // --- determinism + custom options -----------------------------------------
  const mk = () => makeLayout(
    (h) => { for (let lx = 3; lx < N; lx++) h[6 * N + lx] = SOLID; },
    (v) => { for (let lz = 6; lz < N; lz++) v[lz * (N + 1) + 3] = SOLID; },
  );
  const a = JSON.stringify(new CornerAO().generateForChunk(mk()));
  const b = JSON.stringify(new CornerAO().generateForChunk(mk()));
  check('deterministic output', a === b);
  const soft = new CornerAO({ strength: 0.1 });
  const sqs = soft.generateForChunk(mk());
  check('custom strength honored', Math.abs(Math.min(...sqs.map(minTint)) - 0.9) < 1e-9, String(Math.min(...sqs.map(minTint))));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


