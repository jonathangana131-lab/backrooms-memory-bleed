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



// dark tint multipliers (all corners darker than neutral white)
let tintsDark = true;
for (const q of corridorQuads) for (const t of q.tints) if (!(t > 0 && t < 0.75)) { tintsDark = false; break; }
check('tints are dark multipliers in (0, 0.75)', tintsDark);

// ---- determinism -----------------------------------------------------------
const again = fc.generateForChunk(3, -7, 3);
check('same chunk is byte-identical across calls',
  JSON.stringify(corridorQuads) === JSON.stringify(again));
const otherSeed = new FloorCracks({ seed: 999 }).generateForChunk(3, -7, 3);
check('different seed differs', JSON.stringify(corridorQuads) !== JSON.stringify(otherSeed));
const fresh = new FloorCracks({ seed: 12345 }).generateForChunk(3, -7, 3);
check('fresh instance with same seed matches (pure hash-driven)',
  JSON.stringify(corridorQuads) === JSON.stringify(fresh));
for (const cz of [-20, -1, 0, 5]) for (const cx of [0, 2, 11]) {
  const a = fc.generateForChunk(cx, cz, 3);
  const b = fc.generateForChunk(cx, cz, 3);
  if (JSON.stringify(a) !== JSON.stringify(b)) { failures++; console.log('FAIL determinism at', cx, cz); break; }
}
console.log('PASS determinism sweep over negative/zero/positive chunks');

// ---- tile awareness --------------------------------------------------------
// Crack vertices should cluster near tile gridlines much more than uniform.
function distToGridline(v) {
  const m = ((v % CELL) + CELL) % CELL;
  return Math.min(m, CELL - m);
}
let nearCount = 0;
let totalCount = 0;
for (const q of corridorQuads) {
  for (let v = 0; v < 4; v++) {
    const x = q.positions[v * 3];
    const z = q.positions[v * 3 + 2];
    const d = Math.min(distToGridline(x), distToGridline(z));
    totalCount++;
    if (d < 0.25) nearCount++; // ~20% of area would qualify under uniform
  }
}
const nearFrac = nearCount / totalCount;
check('vertices hug tile boundaries (near-grid fraction well above uniform)',
  nearFrac > 0.4, 'nearFrac=' + nearFrac.toFixed(3));

// cracks stay inside their chunk (with small margin)
let boundsOk = true;
{
  const cx = 3, cz = -7;
  for (const q of corridorQuads) {
    for (let v = 0; v < 4; v++) {
      const x = q.positions[v * 3];
      const z = q.positions[v * 3 + 2];
      if (x < cx * CHUNK - 0.5 || x > (cx + 1) * CHUNK + 0.5 ||
          z < cz * CHUNK - 0.5 || z > (cz + 1) * CHUNK + 0.5) { boundsOk = false; break; }
    }
    if (!boundsOk) break;
  }
}
check('quads stay within their chunk bounds (+small margin)', boundsOk);

// ---- branching -------------------------------------------------------------
// A branching crack produces segments sharing endpoints (branch roots).
function key(x, z) { return x.toFixed(3) + ',' + z.toFixed(3); }
function hasSharedEndpoint(quads) {
  const seen = new Map();
  for (const q of quads) {
    const pts = [[q.positions[0], q.positions[2]], [q.positions[9], q.positions[11]]];
    for (const [x, z] of pts) {
      const k = key(x, z);
      if (seen.has(k)) return true;
      seen.set(k, true);
    }
  }
  return false;
}
let branchy = false;
outer:
for (let cx = -6; cx <= 6; cx++) for (let cz = -6; cz <= 6; cz++) {
  if (hasSharedEndpoint(fc.generateForChunk(cx, cz, 3))) { branchy = true; break outer; }
}
check('branching present: some corridor crack shares a segment endpoint', branchy);

// ---- wear correlation ------------------------------------------------------
// Corridors should carry clearly more cracks than room districts, on average.
const districts = [
  ['MAZE', 0],
  ['OPEN_OFFICE', 1],
  ['HONEYCOMB', 2],
  ['CORRIDOR_GRID', 3],
  ['STORAGE', 4],
];
const avg = {};
for (const [, d] of districts) {
  let total = 0;
  const n = 40;
  let activeChunks = 0;
  for (let i = 0; i < n; i++) {
    const q = fc.generateForChunk(100 + i, -50 + i * 3, d);
    total += q.length;
    if (q.length > 0) activeChunks++;
  }
  avg[d] = { perChunk: total / n, activeFrac: activeChunks / n };
}
check('CORRIDOR_GRID has the highest mean crack density',
  districts.every(([, d]) => avg[3].perChunk >= avg[d].perChunk),
  JSON.stringify(avg));
check('corridors meaningfully denser than open office rooms (>=4x)',
  avg[3].perChunk >= avg[1].perChunk * 4,
  'corridor=' + avg[3].perChunk.toFixed(1) + ' office=' + avg[1].perChunk.toFixed(1));
check('most corridor chunks show cracks, most office rooms do not',
  avg[3].activeFrac >= 0.8 && avg[1].activeFrac <= 0.6,
  'corr=' + avg[3].activeFrac.toFixed(2) + ' office=' + avg[1].activeFrac.toFixed(2));

// corridor crack start cells biased toward mesher-worn cells
const { hash2i } = await import(pathToFileURL(path.join(tmp, 'core', 'rng.mjs')).href);
let wornStarts = 0;
let totalStarts = 0;
for (let cx = 0; cx < 30; cx++) for (let cz = 0; cz < 30; cz++) {
  const qs = fc.generateForChunk(cx, cz, 3);
  for (const q of qs) {
    const x = q.positions[0], z = q.positions[2];
    const lx = Math.floor((x - cx * CHUNK) / CELL);
    const lz = Math.floor((z - cz * CHUNK) / CELL);
    if (lx < 0 || lx >= CHUNK_CELLS || lz < 0 || lz >= CHUNK_CELLS) continue;
    totalStarts++;
    if (hash2i(cx * CHUNK_CELLS + lx, cz * CHUNK_CELLS + lz, 4242) % 100 < 55) wornStarts++;
  }
}
const wornFrac = wornStarts / Math.max(1, totalStarts);
check('crack roots skew toward mesher wear cells (>0.55 baseline)',
  wornFrac > 0.55, 'wornFrac=' + wornFrac.toFixed(3));

// ---- safety cap ------------------------------------------------------------
let capOk = true;
for (let cx = -10; cx <= 10; cx += 3) for (let cz = -10; cz <= 10; cz += 3) {
  if (fc.generateForChunk(cx, cz, 3).length > MAX_QUADS_PER_CHUNK) { capOk = false; break; }
}
check('never exceeds MAX_QUADS_PER_CHUNK', capOk);
check('MAX_CRACK_SLOTS exported sane', MAX_CRACK_SLOTS === 8 && BRANCH_CHANCE > 0 && BRANCH_CHANCE < 1);
check('district chance table covers all five districts',
  Array.isArray(DISTRICT_CRACK_CHANCE) && DISTRICT_CRACK_CHANCE.length === 5 &&
  DISTRICT_CRACK_CHANCE[3] === Math.max(...DISTRICT_CRACK_CHANCE));

console.log(failures === 0 ? '\nALL TESTS PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);


