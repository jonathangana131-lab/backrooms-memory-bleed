/**
 * Unit test for the F24 crack-density consumer fold:
 *   src/gfx/floorcracks.ts  generateFloorCrackQuads(cx, cz, district, mul)
 *   src/world/mesher.ts     floorCracks -> debris bucket (LOD < 1)
 *   src/world/chunkManager.ts  aging.crackDensityMul feed
 * Standalone (no browser): transpiles the modules into a temp dir and
 * drives them directly, mirroring test/floorcracks-test.mjs.
 * Run: node test/floorcrack-fold-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-crackfold-'));
for (const d of ['gfx', 'world', 'core', 'memory']) {
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
}

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/memory/field.ts', 'memory/field.mjs');
emit('src/world/crawlspaces.ts', 'world/crawlspaces.mjs');
emit('src/gfx/cornerao.ts', 'gfx/cornerao.mjs');
emit('src/gfx/floorcracks.ts', 'gfx/floorcracks.mjs');
emit('src/world/mesher.ts', 'world/mesher.mjs');

const fc = await import(pathToFileURL(path.join(tmp, 'gfx', 'floorcracks.mjs')).href);
const mesher = await import(pathToFileURL(path.join(tmp, 'world', 'mesher.mjs')).href);

const MAZE = 0, OFFICE = 1, HONEYCOMB = 2, CORRIDOR = 3, STORAGE = 4;
const gen = fc.generateFloorCrackQuads;

// ---- purity / determinism ---------------------------------------------------
check('exported pure helper exists',
  typeof gen === 'function' && typeof fc.CRACK_DENSITY_MUL_MAX === 'number');

const a1 = gen(7, -3, CORRIDOR, 1.0);
const a2 = gen(7, -3, CORRIDOR, 1.0);
check('same inputs return deep-equal quad lists', JSON.stringify(a1) === JSON.stringify(a2));
a1.pop();
check('returned lists are independent (no shared refs)',
  a2.length > 0 && gen(7, -3, CORRIDOR, 1.0).length === a2.length);
check('mul=1 matches legacy default-arg output',
  JSON.stringify(new fc.FloorCracks().generateForChunk(7, -3, CORRIDOR)) ===
  JSON.stringify(gen(7, -3, CORRIDOR, 1)));

// ---- quad shape contract ----------------------------------------------------
let shapeOk = a2.length > 0;
let tintOk = true;
for (const q of a2) {
  if (q.positions.length !== 12 || q.normal.length !== 3 || q.tints.length !== 12) { shapeOk = false; break; }
  if (q.normal[0] !== 0 || q.normal[1] !== 1 || q.normal[2] !== 0) { shapeOk = false; break; }
  const y = [q.positions[1], q.positions[4], q.positions[7], q.positions[10]];
  if (!y.every((v) => Math.abs(v - fc.CRACK_Y) < 1e-9)) { shapeOk = false; break; }
  if ([...q.tints].some((t) => !(Number.isFinite(t) && t >= 0 && t <= 1))) tintOk = false;
}
check('every quad is a floor-plane decal (12 pos @ CRACK_Y, up normal)', shapeOk);
check('all tint multipliers finite in [0,1]', tintOk);

// ---- density scaling ---------------------------------------------------------
// Aggregate across many chunks so single-chunk hash noise cannot flip a check.
function totalAt(district, mul, chunks = 120) {
  let n = 0;
  for (let i = 0; i < chunks; i++) n += gen(i * 3 - 60, -i - 1, district, mul).length;
  return n;
}
// mul=0 is junk (falls back to 1), NOT a suppressor — assert that explicitly
check('mul=0 falls back to legacy, not suppression',
  gen(4, 9, CORRIDOR, 0).length === gen(4, 9, CORRIDOR, 1).length);

const corridorBase = totalAt(CORRIDOR, 1);
const corridorHigh = totalAt(CORRIDOR, 2.2);
const mazeBase = totalAt(MAZE, 1);
const mazeHigh = totalAt(MAZE, 2.2);
check('higher crackDensityMul never yields fewer quads (corridor)',
  corridorHigh >= corridorBase, `${corridorHigh} vs ${corridorBase}`);
check('higher crackDensityMul never yields fewer quads (maze)',
  mazeHigh >= mazeBase, `${mazeHigh} vs ${mazeBase}`);
check('density scaling actually adds cracks somewhere (corridor 1 -> 2.2)',
  corridorHigh > corridorBase, `${corridorBase} -> ${corridorHigh}`);

// junk muls fall back to legacy behaviour (aging ledger only ever emits
// >= 1, so sub-unit values including 0 are malformed data — no suppress path)
for (const junk of [NaN, Infinity, -Infinity, -3, 0.5, 0]) {
  const j = gen(4, 9, CORRIDOR, junk);
  const l = gen(4, 9, CORRIDOR, 1);
  check(`junk mul ${junk} behaves like 1`, JSON.stringify(j) === JSON.stringify(l));
}
// above-cap clamp: mul=99 must equal the cap, never more than mul=cap
const atCap = totalAt(CORRIDOR, fc.CRACK_DENSITY_MUL_MAX);
const overCap = totalAt(CORRIDOR, 99);
check('mul above CRACK_DENSITY_MUL_MAX clamps to it', overCap === atCap,
  `${overCap} vs ${atCap}`);
check('CRACK_DENSITY_MUL_MAX is a sane bound (>= max ledger value ~2.2)',
  fc.CRACK_DENSITY_MUL_MAX >= 2.2 && fc.CRACK_DENSITY_MUL_MAX <= 8);

// ---- safety cap still honoured through the scaled path ------------------------
let capOk = true;
for (let i = -10; i <= 10; i += 3) {
  if (gen(i, -i, CORRIDOR, fc.CRACK_DENSITY_MUL_MAX).length > fc.MAX_QUADS_PER_CHUNK) capOk = false;
}
check('scaled generation never exceeds MAX_QUADS_PER_CHUNK', capOk);

// ---- mesher fold: floorCracks land in the debris bucket at LOD < 1 ------------
function fakeLayout(extra = {}) {
  return {
    cx: 2, cz: -5,
    hEdges: new Uint8Array(33 * 33), vEdges: new Uint8Array(33 * 33),
    district: CORRIDOR,
    lights: [], props: [], signs: [], notes: [], puddles: [],
    wires: [], stains: [], graffiti: [],
    ...extra,
  };
}

const bare = mesher.buildChunkGeometry(fakeLayout());
check('baseline chunk builds without floorCracks',
  Number.isFinite(bare.debris.indices.length) && bare.debris.indices.length % 6 === 0);
const bareIdx = bare.debris.indices.length;

const QUADS = [
  { positions: [0, 0.004, 0, 1, 0.004, 0, 1, 0.004, 1, 0, 0.004, 1], normal: [0, 1, 0], tints: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
  { positions: [2, 0.004, 2, 3, 0.004, 2, 3, 0.004, 3, 2, 0.004, 3], normal: [0, 1, 0], tints: Array(12).fill(0.3) },
];
const withQ = mesher.buildChunkGeometry(fakeLayout({ floorCracks: QUADS }));
check('each folded quad adds exactly one two-tri decal to debris',
  withQ.debris.indices.length === bareIdx + 6 * QUADS.length,
  `${withQ.debris.indices.length} vs ${bareIdx + 12}`);
check('folded quads carry per-corner RGBA colors (alpha 1)',
  Array.isArray(withQ.debris.colors) &&
  withQ.debris.colors.length === (bare.debris.colors?.length ?? 0) + 4 * 4 * QUADS.length &&
  withQ.debris.colors[withQ.debris.colors.length - 1] === 1);
const c0 = withQ.debris.colors[withQ.debris.colors.length - 16];
check('folded tint multiplies color channels (dark < 1)', c0 === 0.3, 'c0=' + c0);

// LOD gate: same chunk viewed from far away skips the crack fold entirely
const FAR = 500;
const farBare = mesher.buildChunkGeometry(fakeLayout(), 0, 0); // chunk center is near origin-ish; force far below
const farCenter = mesher.buildChunkGeometry(
  fakeLayout({ floorCracks: QUADS }), FAR, FAR + 2000,
);
const farNearRef = mesher.buildChunkGeometry(
  fakeLayout({ floorCracks: QUADS }), Infinity, Infinity,
);
check('LOD>=1 view folds zero crack quads (distant chunks skip hairlines)',
  farCenter.debris.indices.length === farBare.debris.indices.length ||
  farCenter.debris.indices.length ===
    farNearRef.debris.indices.length - 6 * QUADS.length,
  `far=${farCenter.debris.indices.length} bare=${farBare.debris.indices.length} nearRef=${farNearRef.debris.indices.length}`);

// Real generated quads survive the fold intact
const real = gen(2, -5, CORRIDOR, 1.8);
if (real.length > 0) {
  const gReal = mesher.buildChunkGeometry(fakeLayout({ floorCracks: real }));
  const expect = bareIdx + 6 * real.length;
  check(`real aged chunk folds its ${real.length} crack quads`,
    gReal.debris.indices.length === expect,
    `${gReal.debris.indices.length} vs ${expect}`);
  let finite = true;
  for (const p of gReal.debris.positions) if (!Number.isFinite(p)) finite = false;
  check('folded real geometry is fully finite', finite);
} else {
  check('real aged chunk folds its crack quads (chunk had none — vacuous)', true);
}

// ---- wiring greps -------------------------------------------------------------
const cmSrc = fs.readFileSync(path.join(ROOT, 'src/world/chunkManager.ts'), 'utf8');
const archSrc = fs.readFileSync(path.join(ROOT, 'src/world/architect.ts'), 'utf8');
const meshSrc = fs.readFileSync(path.join(ROOT, 'src/world/mesher.ts'), 'utf8');
check('chunkManager imports generateFloorCrackQuads',
  /import\s*\{[^}]*generateFloorCrackQuads[^}]*\}\s*from\s*'[^']*gfx\/floorcracks'/.test(cmSrc));
check('chunkManager feeds aging.crackDensityMul into the generator',
  /generateFloorCrackQuads\([^)]*aging\.crackDensityMul/.test(cmSrc));
check('old seam comment is gone',
  !cmSrc.includes('no crack-count site'));
check('architect declares layout.floorCracks', archSrc.includes('floorCracks?:'));
check('mesher folds layout.floorCracks into debris behind the LOD<1 gate',
  /lod\s*<\s*1\s*&&\s*layout\.floorCracks/.test(meshSrc));

console.log(failures === 0 ? '\nALL TESTS PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
