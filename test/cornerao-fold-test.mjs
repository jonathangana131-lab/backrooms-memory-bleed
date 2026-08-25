/**
 * Unit test for the CornerAO mesher fold:
 *   src/gfx/cornerao.ts       CornerAO.generateForChunk(layout) — pure data
 *   src/world/mesher.ts       cornerAO -> debris bucket (LOD < 1)
 *   src/world/chunkManager.ts build-path generation site
 * Standalone (no browser): transpiles the modules into a temp dir and
 * drives them directly, mirroring test/floorcrack-fold-test.mjs.
 * Run: node test/cornerao-fold-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-aofold-'));
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

const aoMod = await import(pathToFileURL(path.join(tmp, 'gfx', 'cornerao.mjs')).href);
const constants = await import(pathToFileURL(path.join(tmp, 'world', 'constants.mjs')).href);
const mesher = await import(pathToFileURL(path.join(tmp, 'world', 'mesher.mjs')).href);

const { CornerAO, AO_HEIGHT, AO_WIDTH, AO_STRENGTH } = aoMod;
const { CHUNK_CELLS: N, WALL_H, EdgeCode } = constants;
const SOLID = EdgeCode.SOLID;
const CORRIDOR = 3;

// ---- layout helpers ----------------------------------------------------------
function mkLayout() {
  return {
    cx: 2, cz: -5,
    // hEdges: (N+1) rows x N; vEdges: N rows x (N+1)
    hEdges: new Uint8Array((N + 1) * N),
    vEdges: new Uint8Array(N * (N + 1)),
    district: CORRIDOR,
    lights: [], props: [], signs: [], notes: [], puddles: [],
    wires: [], stains: [], graffiti: [],
  };
}
const hIdx = (gz, gx) => gz * N + gx;
const vIdx = (gz, gx) => gz * (N + 1) + gx;

// ---- purity / determinism ------------------------------------------------------
const gen = new CornerAO();
check('CornerAO class + tuning constants exported',
  typeof CornerAO === 'function' &&
  AO_HEIGHT > 0 && AO_WIDTH > 0 && AO_STRENGTH > 0 && AO_STRENGTH < 1);

const layA = mkLayout();
layA.hEdges[hIdx(6, 5)] = SOLID; // one isolated horizontal edge -> L-ish end caps
const q1 = gen.generateForChunk(layA);
const q2 = gen.generateForChunk(layA);
check('same layout returns deep-equal quad lists (pure fn of edge grid)',
  q1.length > 0 && JSON.stringify(q1) === JSON.stringify(q2));
q1.pop();
check('returned lists are independent (no shared refs)',
  gen.generateForChunk(layA).length === q2.length);

// ---- quad shape contract ---------------------------------------------------------
let shapeOk = true, tintOk = true, bandOk = true, finiteOk = true;
for (const q of q2) {
  if (q.positions.length !== 12 || q.normal.length !== 3 || q.tints.length !== 12) { shapeOk = false; break; }
  // wall decals: normal is horizontal (y == 0), unit-length on one axis
  if (q.normal[1] !== 0) { shapeOk = false; break; }
  const nAbs = [Math.abs(q.normal[0]), Math.abs(q.normal[1]), Math.abs(q.normal[2])];
  if (!((nAbs[0] === 1 && nAbs[2] === 0) || (nAbs[0] === 0 && nAbs[2] === 1))) { shapeOk = false; break; }
  for (let i = 0; i < 12; i++) {
    if (!Number.isFinite(q.positions[i])) finiteOk = false;
  }
  const ys = [q.positions[1], q.positions[4], q.positions[7], q.positions[10]];
  if (!ys.every((y) => y >= -1e-9 && y <= WALL_H + 1e-9)) bandOk = false;
  for (const t of q.tints) {
    if (!(Number.isFinite(t) && t >= 0 && t <= 1)) tintOk = false;
  }
}
check('every quad is a wall decal (axis-aligned horizontal normal)', shapeOk);
check('all positions finite and inside the floor..ceiling band', finiteOk && bandOk);
check('all tint multipliers finite in [0,1]', tintOk);

// ---- junction semantics -----------------------------------------------------------
// A collinear continuation must NOT be treated as a corner (repo contract:
// mid-wall seams stay clean), while an L corner emits BOTH face orientations.
function edgeCount(lay) { return gen.generateForChunk(lay).length; }

const single = mkLayout();
single.hEdges[hIdx(6, 5)] = SOLID;
const singleCount = edgeCount(single);
check('isolated SOLID edge emits contact shadows on both faces', singleCount > 0);

const straight = mkLayout(); // collinear pair: mid vertex must be skipped
straight.hEdges[hIdx(6, 4)] = SOLID;
straight.hEdges[hIdx(6, 5)] = SOLID;
// An isolated edge emits at BOTH its end vertices (2 x 4 quads); the
// collinear pair emits only at its two OUTER ends — the shared mid-wall
// vertex adds nothing, so the counts match one lone edge exactly.
check('collinear run emits exactly what one lone edge does (mid-wall vertex clean)',
  edgeCount(straight) === singleCount,
  `${edgeCount(straight)} vs ${singleCount}`);

const lcorner = mkLayout(); // horizontal + vertical edge meeting at (6,6)
lcorner.hEdges[hIdx(6, 5)] = SOLID;
lcorner.vEdges[vIdx(6, 6)] = SOLID;
check('L corner emits exactly 2x one edge (each edge still both endpoints)',
  edgeCount(lcorner) === 2 * singleCount,
  `${edgeCount(lcorner)} vs ${2 * singleCount}`);
{
  let hasX = false, hasZ = false;
  for (const q of gen.generateForChunk(lcorner)) {
    if (Math.abs(q.normal[0]) === 1) hasX = true;
    if (Math.abs(q.normal[2]) === 1) hasZ = true;
  }
  let singleHasX = false;
  for (const q of gen.generateForChunk(single)) {
    if (Math.abs(q.normal[0]) === 1) singleHasX = true;
  }
  check('L corner mixes both face orientations, lone edge does not',
    hasX && hasZ && !singleHasX);
}
{
  // cross junction: four collinear continuations -> centre vertex emits none
  const cross = mkLayout();
  cross.hEdges[hIdx(6, 5)] = SOLID;
  cross.hEdges[hIdx(6, 6)] = SOLID;
  cross.vEdges[vIdx(5, 6)] = SOLID;
  cross.vEdges[vIdx(6, 6)] = SOLID;
  check('cross junction emits exactly 4x one edge (centre is pass-through)',
    edgeCount(cross) === 4 * singleCount,
    `${edgeCount(cross)} vs ${4 * singleCount}`);
}
{
  // options clamp: strength junk falls inside [0,1]; width/height stay positive
  const junk = new CornerAO({ strength: NaN, width: -5, height: 0 });
  check('junk ctor options fall back safe',
    Number.isFinite(junk.strength) && junk.strength >= 0 && junk.strength <= 1 &&
    junk.width > 0 && junk.height > 0);
}

// ---- mesher fold: cornerAO lands in the debris bucket at LOD < 1 -------------------
function fakeLayout(extra = {}) {
  return { ...mkLayout(), ...extra };
}

const bare = mesher.buildChunkGeometry(fakeLayout());
check('baseline chunk builds without cornerAO',
  Number.isFinite(bare.debris.indices.length) && bare.debris.indices.length % 6 === 0);
const bareIdx = bare.debris.indices.length;

const QUADS = [
  { positions: [0, 1, 5, 1, 1, 5, 1, 2, 5, 0, 2, 5], normal: [0, 0, 1], tints: Array(12).fill(0.75) },
  { positions: [7, 0.2, 8, 7, 0.2, 9, 7, 1.2, 9, 7, 1.2, 8], normal: [1, 0, 0], tints: Array(12).fill(0.6) },
];
const withQ = mesher.buildChunkGeometry(fakeLayout({ cornerAO: QUADS }));
check('each folded quad adds exactly one two-tri decal to debris',
  withQ.debris.indices.length === bareIdx + 6 * QUADS.length,
  `${withQ.debris.indices.length} vs ${bareIdx + 6 * QUADS.length}`);
check('folded quads carry per-corner RGBA colors (alpha 1)',
  Array.isArray(withQ.debris.colors) &&
  withQ.debris.colors.length === (bare.debris.colors?.length ?? 0) + 4 * 4 * QUADS.length &&
  withQ.debris.colors[withQ.debris.colors.length - 1] === 1);
{
  // first folded vertex color channels equal the quad's own tint multipliers
  const cBase = (bare.debris.colors?.length ?? 0);
  const c0 = withQ.debris.colors.slice(cBase, cBase + 3);
  check('folded tint multiplies color channels (AO darkening < 1)',
    c0.every((v) => Math.abs(v - 0.75) < 1e-9), 'c0=' + c0);
}

// LOD gate: distant views skip the feathered shading entirely
const FAR = 500;
const farBare = mesher.buildChunkGeometry(fakeLayout(), FAR, FAR + 2000);
const farAO = mesher.buildChunkGeometry(fakeLayout({ cornerAO: QUADS }), FAR, FAR + 2000);
const nearRef = mesher.buildChunkGeometry(fakeLayout({ cornerAO: QUADS }), Infinity, Infinity);
check('LOD>=1 view folds zero cornerAO quads (distant chunks skip shading)',
  farAO.debris.indices.length === farBare.debris.indices.length ||
  farAO.debris.indices.length === nearRef.debris.indices.length - 6 * QUADS.length,
  `far=${farAO.debris.indices.length} bare=${farBare.debris.indices.length} nearRef=${nearRef.debris.indices.length}`);

// Real generated quads survive the fold intact
const real = gen.generateForChunk(layA);
{
  const gReal = mesher.buildChunkGeometry(fakeLayout({ cornerAO: real }));
  const expect = bareIdx + 6 * real.length;
  check(`real chunk folds its ${real.length} cornerAO quads`,
    gReal.debris.indices.length === expect,
    `${gReal.debris.indices.length} vs ${expect}`);
  let finite = true;
  for (const p of gReal.debris.positions) if (!Number.isFinite(p)) finite = false;
  check('folded real geometry is fully finite', finite);
}

// ---- wiring greps -------------------------------------------------------------------
const cmSrc = fs.readFileSync(path.join(ROOT, 'src/world/chunkManager.ts'), 'utf8');
const archSrc = fs.readFileSync(path.join(ROOT, 'src/world/architect.ts'), 'utf8');
const meshSrc = fs.readFileSync(path.join(ROOT, 'src/world/mesher.ts'), 'utf8');
check('chunkManager imports CornerAO',
  /import\s*\{[^}]*CornerAO[^}]*\}\s*from\s*'[^']*gfx\/cornerao'/.test(cmSrc));
check('chunkManager generates layout.cornerAO on the build path',
  /layout\.cornerAO\s*=\s*new\s+CornerAO\(\)\.generateForChunk\(layout\)/.test(cmSrc));
check('architect declares layout.cornerAO', archSrc.includes('cornerAO?:'));
check('mesher folds layout.cornerAO into debris behind the LOD<1 gate',
  /lod\s*<\s*1\s*&&\s*layout\.cornerAO/.test(meshSrc));

console.log(failures === 0 ? '\nALL TESTS PASS' : '\n' + failures + ' FAILURES');
process.exitCode = failures === 0 ? 0 : 1;
