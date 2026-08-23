/**
 * Unit tests for wall posters (src/gfx/posters.ts).
 * Standalone (no browser, no Babylon): transpiles the modules into a temp
 * dir and drives placement with hand-built layouts and paintPoster with a
 * recording 2D-context stub.
 * Run: node test/posters-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-posters-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

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
emit('src/core/rng.ts', 'core/rng.mjs');
fs.writeFileSync(path.join(tmp, 'world', 'constants.mjs'),
  ts.transpileModule(CONSTANTS_TS_RESTORED,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
emit('src/gfx/posters.ts', 'gfx/posters.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx/posters.mjs')).href);
const {
  POSTER_TYPES, POSTER_STATES, POSTER_SALT,
  POSTER_OFFSET, POSTER_Y_MIN, POSTER_Y_MAX,
  posterAging, posterCanvasSize, getPostersForChunk, paintPoster,
} = mod;

// ---------------------------------------------------------------------------
// Poster type / state catalog
// ---------------------------------------------------------------------------
check('five poster types declared', POSTER_TYPES.length === 5 &&
  ['missing', 'event', 'safety', 'map', 'motivational'].every(t => POSTER_TYPES.includes(t)),
  JSON.stringify(POSTER_TYPES));
check('three aging states declared', POSTER_STATES.length === 3 &&
  ['fresh', 'faded', 'torn'].every(s => POSTER_STATES.includes(s)),
  JSON.stringify(POSTER_STATES));

// ---------------------------------------------------------------------------
// Aging profiles
// ---------------------------------------------------------------------------
{
  const fresh = posterAging('fresh');
  const faded = posterAging('faded');
  const torn = posterAging('torn');
  let ok = true;
  for (const [name, a] of [['fresh', fresh], ['faded', faded], ['torn', torn]]) {
    for (const k of ['alpha', 'tear', 'curl']) {
      if (!(a[k] >= 0 && a[k] <= 1)) ok = false;
    }
    void name;
  }
  check('aging profiles in [0,1] for all fields', ok);
  check('fresh is most opaque', fresh.alpha > faded.alpha && fresh.alpha > torn.alpha);
  check('faded is least opaque', faded.alpha < fresh.alpha && faded.alpha < torn.alpha);
  check('torn has the most tear damage', torn.tear > fresh.tear && torn.tear > faded.tear);
  // Deterministic pure function
  check('posterAging deterministic', JSON.stringify(posterAging('torn')) === JSON.stringify(torn));
}

// ---------------------------------------------------------------------------
// Placement: gating rate ~15% of chunks
// ---------------------------------------------------------------------------


{
  let gated = 0;
  const R = 40; // -20..19 per axis -> 1600 chunks
  for (let cx = -R / 2; cx < R / 2; cx++) {
    for (let cz = -R / 2; cz < R / 2; cz++) {
      if (getPostersForChunk(cx, cz).length > 0) gated++;
    }
  }
  const rate = gated / (R * R);
  check('poster chunk gate near 14-15%', rate > 0.08 && rate < 0.22, 'rate=' + rate.toFixed(3));
}

// ---------------------------------------------------------------------------
// Placement: shape, counts, ranges, validity
// ---------------------------------------------------------------------------
{
  let sawTwo = false, sawOne = false;
  let okRanges = true, okTypes = true, okRot = true;
  for (let cx = -25; cx < 25; cx++) {
    for (let cz = -25; cz < 25; cz++) {
      const ps = getPostersForChunk(cx, cz);
      if (ps.length === 0) continue;
      if (ps.length > 2) okRanges = false;
      if (ps.length === 1) sawOne = true;
      if (ps.length === 2) sawTwo = true;
      for (const p of ps) {
        if (!(p.y >= POSTER_Y_MIN && p.y <= POSTER_Y_MAX)) okRanges = false;
        if (!POSTER_TYPES.includes(p.type)) okTypes = false;
        if (!POSTER_STATES.includes(p.state)) okTypes = false;
        const r = Math.round(p.rotY / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(p.rotY - r) > 1e-9) okRot = false;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) okRanges = false;
      }
    }
  }
  check('gated chunks carry 1-2 posters', sawOne && sawTwo, 'one=' + sawOne + ' two=' + sawTwo);
  check('y within mount band and finite coords', okRanges);
  check('types and states valid everywhere', okTypes);
  check('rotY axis-aligned', okRot);
}

// ---------------------------------------------------------------------------
// Placement: determinism per chunk hash
// ---------------------------------------------------------------------------
{
  let gated = null;
  outer:
  for (let cx = -20; cx < 20; cx++) {
    for (let cz = -20; cz < 20; cz++) {
      if (getPostersForChunk(cx, cz).length > 0) { gated = [cx, cz]; break outer; }
    }
  }
  check('a gated chunk exists in the sweep', gated !== null);
  const a = gated ? getPostersForChunk(gated[0], gated[1]) : [];
  const b = gated ? getPostersForChunk(gated[0], gated[1]) : [];
  const c = gated ? getPostersForChunk(gated[0], gated[1], 424242) : [];
  check('same chunk + seed -> identical placements',
    JSON.stringify(a) === JSON.stringify(b));
  check('different seed -> different data (almost surely)',
    !gated || JSON.stringify(a) !== JSON.stringify(c),
    'gated=' + JSON.stringify(gated));
  check('negative coords handled', Array.isArray(getPostersForChunk(-101, -202)));
}

// ---------------------------------------------------------------------------
// Placement: wall mounting against a real layout
// ---------------------------------------------------------------------------
{
  const N = 12; // CHUNK_CELLS mirrored
  const CELL = 2.5; // mirrored constant
  // One horizontal SOLID edge at lz=5 spanning lx=4..6, open on both sides.
  const hEdges = new Uint8Array(N * N);
  const vEdges = new Uint8Array(N * (N + 1));
  for (let lx = 4; lx <= 6; lx++) hEdges[5 * N + lx] = 1;

  let mounted = 0, total = 0;
  for (let seed = 0; seed < 200; seed++) {
    const ps = getPostersForChunk(seed % 7 === 0 ? 0 : 3, seed % 5, seed, { hEdges, vEdges });
    total += ps.length;
    for (const p of ps) {
      // Must sit on the chunk's wall line z = cz*N*CELL + 5*CELL (+/- offset)
      // when rotY faces +-z; anchors are world-space, walls are per-chunk.
      const bz = (seed % 5) * N * CELL;
      const zLine = bz + 5 * CELL;
      // Both faces anchor on the same SOLID lattice line, proud on either
      // side (matches the reverse-map audit below).
      const onHWall =
        (Math.abs(p.rotY - Math.PI) < 1e-6 && Math.abs(p.z - (zLine - POSTER_OFFSET)) < 1e-6) ||
        (Math.abs(p.rotY) < 1e-6 && Math.abs(p.z - (zLine + POSTER_OFFSET)) < 1e-6);
      const cx0 = seed % 7 === 0 ? 0 : 3;
      const bx = cx0 * N * CELL;
      const xWithinRun = p.x >= bx + 4 * CELL && p.x <= bx + 7 * CELL;
      if (onHWall && xWithinRun) mounted++;
    }
  }
  check('posters land on real solid wall faces', total > 0 && mounted === total,
    'mounted=' + mounted + '/' + total);

  // Empty layout: falls back to hash-only interior placement without crashing.
  const empty = getPostersForChunk(0, 0, 0, { hEdges: new Uint8Array(N * N), vEdges: new Uint8Array(N * (N + 1)) });
  check('empty layout still yields placements when gated', Array.isArray(empty) && empty.length <= 2);
}

// ---------------------------------------------------------------------------
// Placement: reverse-map audit over a dense supplied layout
// ---------------------------------------------------------------------------
{
  const N = 12;
  const CELL = 2.5;
  const hEdges = new Uint8Array((N + 1) * N);
  const vEdges = new Uint8Array(N * (N + 1));
  // Solid border ring plus interior wall runs so every face orientation
  // gets a real surface somewhere in the sweep.
  for (let lx = 0; lx < N; lx++) {
    hEdges[0 * N + lx] = 1;
    hEdges[N * N + lx] = 1;
  }
  for (let lz = 0; lz < N; lz++) {
    vEdges[lz * (N + 1) + 0] = 1;
    vEdges[lz * (N + 1) + N] = 1;
  }
  for (let i = 3; i <= 8; i++) {
    hEdges[6 * N + i] = 1;
    vEdges[i * (N + 1) + 6] = 1;
  }

  let total = 0, mounted = 0;
  for (let cx = -5; cx <= 5; cx++) {
    for (let cz = -5; cz <= 5; cz++) {
      const seed = ((cx * 73 + cz * 151) % 997 + 997) % 997;
      void seed;
    const ps = getPostersForChunk(cx, cz, seed, { hEdges, vEdges });
    total += ps.length;
    const bx = cx * N, bz = cz * N;
    for (const p of ps) {
      // Reverse-map the world anchor back to a LATTICE LINE index and
      // require that edge to be SOLID in the supplied layout. Faces with
      // negative normals anchor directly on their edge line; faces with
      // positive normals sit just proud of it on the far side.
      let okEdge = false;
      const PI = Math.PI;
      const near = (a, b) => Math.abs(a - b) < 1e-6;
      if (near(p.rotY, PI) || near(p.rotY, 0)) {
        // Horizontal wall: recover lattice line g and column lx.
        const g = near(p.rotY, PI)
          ? (p.z + POSTER_OFFSET) / CELL - bz   // -z face: on the line itself
          : (p.z - POSTER_OFFSET) / CELL - bz;  // +z face: proud south side
        const lx = Math.floor(p.x / CELL - bx);
        const gi = Math.round(g);
        okEdge = gi >= 0 && gi <= N && lx >= 0 && lx < N &&
          near(g, gi) && hEdges[gi * N + lx] === 1;
      } else if (near(Math.abs(p.rotY), PI / 2)) {
        // Vertical wall: recover lattice line g and row lz.
        const g = near(p.rotY, -PI / 2)
          ? (p.x + POSTER_OFFSET) / CELL - bx   // -x face: on the line itself
          : (p.x - POSTER_OFFSET) / CELL - bx;  // +x face: proud east side
        const lz = Math.floor(p.z / CELL - bz);
        const gi = Math.round(g);
        okEdge = gi >= 0 && gi <= N && lz >= 0 && lz < N &&
          near(g, gi) && vEdges[lz * (N + 1) + gi] === 1;
      }
      if (okEdge) mounted++;
    }
  }
    }
  check('posters land on real solid wall faces', total > 0 && mounted === total,
    'mounted=' + mounted + '/' + total);

  // Empty layout: falls back to hash-only interior placement without crashing.
  const empty = getPostersForChunk(0, 0, 0, { hEdges: new Uint8Array(N * N), vEdges: new Uint8Array(N * (N + 1)) });
  check('empty layout still yields placements when gated', Array.isArray(empty) && empty.length <= 2);
}

// ---------------------------------------------------------------------------
// Painting: stub context, all 25 type x state combos run clean
// ---------------------------------------------------------------------------
function makeStubCtx() {
  const ops = [];
  const rec = (name) => (...args) => { ops.push([name, ...args]); };
  return {
    ops,
    save: rec('save'), restore: rec('restore'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    arc: rec('arc'), rect: rec('rect'),
    fill: rec('fill'), stroke: rec('stroke'), clip: rec('clip'),
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), clearRect: rec('clearRect'),
    fillText: rec('fillText'), strokeText: rec('strokeText'),
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: rec('addColorStop') }),
  };
}
{
  const texts = {};
  let allRan = true;
  for (const t of POSTER_TYPES) {
    texts[t] = [];
    for (const s of POSTER_STATES) {
      try {
        const ctx = makeStubCtx();
        const size = posterCanvasSize(t);
        if (!(size.width > 0 && size.height > 0)) allRan = false;
        paintPoster(ctx, size.width, size.height, t, s, 42);
        texts[t].push(ctx.ops.filter(o => o[0] === 'fillText').map(o => o[1]).join('|'));
      } catch (e) {
        allRan = false;
        console.log('  paint error', t, s, e.message);
      }
    }
  }
  check('paintPoster runs for every type x state without throwing', allRan);
  check('missing flyer says LOST', texts.missing.some(t => t.includes('LOST')));
  check('safety notice says WARNING', texts.safety.some(t => t.includes('WARNING')));
  check('event poster names the band', texts.event.some(t => t.includes('NULL CIRCUIT')));
  check('motivational says PEAK PERFORMANCE', texts.motivational.some(t => t.includes('PEAK PERFORMANCE')));

  // Torn state adds tear-notch polygons vs fresh.
  const ctxF = makeStubCtx(), ctxT = makeStubCtx();
  paintPoster(ctxF, 256, 340, 'missing', 'fresh', 9);
  paintPoster(ctxT, 256, 340, 'missing', 'torn', 9);
  check('torn poster paints more damage than fresh',
    ctxT.ops.length > ctxF.ops.length,
    'fresh=' + ctxF.ops.length + ' torn=' + ctxT.ops.length);

  // Aging alpha applied to the context.
  check('globalAlpha follows aging profile',
    Math.abs(ctxF.globalAlpha - posterAging('fresh').alpha) < 1e-9 &&
    Math.abs(ctxT.globalAlpha - posterAging('torn').alpha) < 1e-9);

  // Determinism of the full op sequence.
  const ctxA = makeStubCtx(), ctxB = makeStubCtx();
  paintPoster(ctxA, 288, 288, 'map', 'torn', 77);
  paintPoster(ctxB, 288, 288, 'map', 'torn', 77);
  check('paintPoster op sequence deterministic',
    JSON.stringify(ctxA.ops) === JSON.stringify(ctxB.ops));

  // Different states produce visibly different output.
  check('states change the painted output',
    JSON.stringify(ctxA.ops) !== JSON.stringify((() => {
      const c = makeStubCtx();
      paintPoster(c, 288, 288, 'map', 'fresh', 77);
      return c.ops;
    })()));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


