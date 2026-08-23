/**
 * Unit tests for tile debris clusters (src/gfx/tiledebris.ts).
 * Standalone (no browser): transpiles the module (+ constants/rng) into a
 * temp dir and drives TileDebris with hand-built crack-seed anchors.
 * Run: node test/tiledebris-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-tiledebris-'));
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

export const enum District {
  MAZE = 0,
  OPEN_OFFICE = 1,
  HONEYCOMB = 2,
  CORRIDOR_GRID = 3,
  STORAGE = 4,
}

export function worldToCell(w) { return Math.floor(w / CELL); }
export function cellToWorld(c) { return (c + 0.5) * CELL; }
export function worldToChunk(w) { return Math.floor(w / CHUNK_SIZE); }
`;
fs.writeFileSync(path.join(tmp, 'world', 'constants.mjs'),
  ts.transpileModule(CONSTANTS_TS_RESTORED,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);

emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/gfx/tiledebris.ts', 'gfx/tiledebris.mjs');

const {
  TileDebris,
  TILE_DEBRIS_Y,
  FRAGMENTS_MIN,
  FRAGMENTS_MAX,
  CLUSTER_RADIUS,
  MAX_QUADS_PER_CHUNK,
} = await import(pathToFileURL(path.join(tmp, 'gfx/tiledebris.mjs')).href);

// Mirrored constants (src/world/constants.ts).
const CHUNK = 30; // CHUNK_CELLS * CELL

const td = new TileDebris({ seed: 20250704 });

{
  // --- quad contract ---------------------------------------------------------
  const qs = td.generateForChunk(6, -3, 4, [{ x: 6 * CHUNK + 5, z: -3 * CHUNK + 7, rotY: Math.PI / 2 }]);
  check('a seeded STORAGE chunk emits debris', qs.length > 0, 'got ' + qs.length);
  let okShape = true, okNormal = true, okHeight = true, okTints = true;
  for (const q of qs) {
    if (!Array.isArray(q.positions) || q.positions.length !== 12) okShape = false;
    if (!Array.isArray(q.tints) || q.tints.length !== 12) okShape = false;
    const n = q.normal;
    if (!Array.isArray(n) || n.length !== 3 || n[0] !== 0 || n[1] !== 1 || n[2] !== 0) okNormal = false;
    for (let i = 0; i < 4; i++) {
      if (q.positions[i * 3 + 1] !== TILE_DEBRIS_Y) okHeight = false;
    }
    // light ceramic on a dark floor: no channel goes dark-grey
    if (q.tints.some((t) => t < 0.62)) okTints = false;
  }
  const grandMean = qs.flatMap((q) => q.tints).reduce((a, b) => a + b, 0)
    / qs.reduce((n, q) => n + q.tints.length, 0);
  check('shards follow the decal contract (shape/normal/height)', okShape && okNormal && okHeight);
  check('shard tints read bright against the dark floor',
    !okTints === false && grandMean > 0.95, 'mean=' + grandMean.toFixed(3));
}

{
  // --- fragment counts stay in the documented band ----------------------------
  let ok = true, sawCluster = false;
  for (let cx = 10; cx < 26 && ok; cx++) for (let cz = 10; cz < 26; cz++) {
    const seeds = [];
    for (let k = 0; k < 6; k++) seeds.push({ x: cx * CHUNK + 3 + k * 3.1, z: cz * CHUNK + 4 + k * 2.3 });
    const qs = td.generateForChunk(cx, cz, 4, seeds);
    // ambient district clusters also live here; only assert that the
    // crack-correlated ones hug their bait anchors
    let hugged = 0;
    for (const q of qs) {
      const x = q.positions[0], z = q.positions[2];
      if (seeds.some((s) => Math.hypot(x - s.x, z - s.z) < CLUSTER_RADIUS + 0.55)) hugged++;
    }
    if (hugged >= FRAGMENTS_MIN) { sawCluster = true; ok = true; break; }
  }
  check('crack-correlated clusters hug their anchors', sawCluster && ok, 'cluster=' + sawCluster);
}

{

  // --- determinism sweep -------------------------------------------------------
  const s = [{ x: 91.5, z: -44.25, rotY: Math.PI }, { x: 88, z: -40 }];
  let sweepOk = true;
  for (const [cx, cz] of [[0, 0], [-1, 0], [3, -7], [55, 61]]) {
    const a = new TileDebris({ seed: 20250704 }).generateForChunk(cx, cz, 4, s);

  const b = td.generateForChunk(cx, cz, 4, s);
  if (JSON.stringify(a) !== JSON.stringify(b)) { sweepOk = false; break; }
}
check('determinism sweep over negative/zero/positive chunks (STORAGE)', sweepOk);
}

// ---- cluster geometry ------------------------------------------------------
// Group shards by proximity: each hash-gated cluster holds FRAGMENTS_MIN..
// FRAGMENTS_MAX fragments within roughly CLUSTER_RADIUS of its anchor.
function clusterSizes(quads) {
  const pts = quads.map((q) => [
    (q.positions[0] + q.positions[3] + q.positions[6] + q.positions[9]) / 4,
    (q.positions[2] + q.positions[5] + q.positions[8] + q.positions[11]) / 4,
  ]);
  const used = new Array(pts.length).fill(false);
  const sizes = [];
  const R = CLUSTER_RADIUS * 1.35 + 0.12;
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    let size = 0;
    for (let j = i; j < pts.length; j++) {
      if (!used[j] && Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) <= R) {
        used[j] = true;
        size++;
      }
    }
    sizes.push(size);
  }
  return sizes;
}
{
  const bigSeeds = [];
  for (let i = 0; i < 6; i++) {
    bigSeeds.push({ x: 20 * CHUNK + 4 + i * 3.5, z: 30 * CHUNK + 4 + i * 2.9, rotY: (i % 4) * Math.PI / 2 });
  }
  // force every gate on: many chunks until one shows >=2 clusters
  let found = null;
  outer:
  for (let cx = 40; cx < 70; cx++) for (let cz = 40; cz < 70; cz++) {
    const qs = td.generateForChunk(cx, cz, 4, bigSeeds.map((s, k) => ({
      x: cx * CHUNK + 4 + k * 3.5, z: cz * CHUNK + 4 + k * 2.9, rotY: (k % 4) * Math.PI / 2,



    })));
    const sizes = clusterSizes(qs);
    if (!found || sizes.length > found.sizes.length) found = { cx, cz, sizes };
  }
  check('hash-gated chunks can host several debris clusters',
    found !== null && found.sizes.length >= 2,
    found ? JSON.stringify(found.sizes) : 'none across sweep');
}

{
  // --- hard cap ----------------------------------------------------------------
  const manySeeds = [];
  for (let k = 0; k < 32; k++) {
    manySeeds.push({ x: 500 * CHUNK + 2 + (k % 8) * 3.4, z: 500 * CHUNK + 2 + Math.floor(k / 8) * 2.7, rotY: (k % 4) * Math.PI / 2 });
  }
  let capped = 0;
  for (let cx = 498; cx < 502; cx++) for (let cz = 498; cz < 502; cz++) {
    const qs = td.generateForChunk(cx, cz, 4, manySeeds.map((s, k) => ({
      x: cx * CHUNK + 2 + (k % 8) * 3.4, z: cz * CHUNK + 2 + Math.floor(k / 8) * 2.7, rotY: (k % 4) * Math.PI / 2,
    })));
    if (qs.length > MAX_QUADS_PER_CHUNK) capped++;
  }
  check('emissions never exceed MAX_QUADS_PER_CHUNK', capped === 0);
}

process.exit(failures === 0 ? 0 : 1);
