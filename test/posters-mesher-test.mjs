/**
 * Unit tests for the poster emission layer (src/gfx/posters-mesher.ts).
 * Standalone (no browser/Babylon): transpiles the module (+ its runtime
 * deps) into a temp dir and drives the pure generate()/emit()/
 * renderPosterInto() API with a recording canvas stub.
 * Run: node test/posters-mesher-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-postersmesher-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  // rewrite relative imports to .mjs and drop Babylon runtime imports -
  // bakePoster needs a real Scene/GPU so it is not exercised headless.
  const fixed = js
    .replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'")
    .replace(/import\s*\{[^}]*\}\s*from\s*'@babylonjs[^']*';/g, '');
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/gfx/posters.ts', 'gfx/posters.mjs');
emit('src/gfx/posters-mesher.ts', 'gfx/posters-mesher.mjs');

const pmMod = await import(pathToFileURL(path.join(tmp, 'gfx/posters-mesher.mjs')).href);
const postersMod = await import(pathToFileURL(path.join(tmp, 'gfx/posters.mjs')).href);
const {
  PosterMesherPass,
  posterQuadSize,
  posterTintForState,
  posterTextureKey,
  posterSeedFor,
  renderPosterInto,
  POSTER_QUAD_WIDTH,
  POSTER_QUAD_OFFSET,
  POSTER_MIN_Y,
  ALL_POSTER_TEXTURE_KEYS,
} = pmMod;
const { getPostersForChunk, posterAging, posterCanvasSize, POSTER_TYPES, POSTER_STATES } = postersMod;

function close(a, b, eps = 1e-6) {


  return Math.abs(a - b) <= eps;
}

// ---- recording PosterCtx stub ----------------------------------------------

function makeRecordingCtx() {
  const calls = [];
  const grad = { addColorStop: (o, c) => calls.push(['addColorStop', o, c]) };
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    measureText: (t) => ({ width: String(t).length * 7 }),
    createLinearGradient: (...a) => { calls.push(['createLinearGradient', ...a]); return grad; },
    save: rec('save'), restore: rec('restore'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'), rect: rec('rect'),
    fill: rec('fill'), stroke: rec('stroke'), clip: rec('clip'),
    fillRect: rec('fillRect'), strokeRect: rec('strokeRect'), clearRect: rec('clearRect'),
    fillText: rec('fillText'), strokeText: rec('strokeText'),
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    _alphaSets: [],
    get globalAlpha() { return this._alpha ?? 1; },
    set globalAlpha(v) { if (this._alpha === undefined) this._alphaSets.push(v); this._alpha = v; },
    font: '', textAlign: 'left', textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
  };
}

// ---- texture baking (renderPosterInto over paintPoster) --------------------

{
  let sizesOk = true;
  let alphaOk = true;
  let drewOk = true;
  let tearsSeen = 0;
  for (const type of POSTER_TYPES) {
    for (const state of POSTER_STATES) {
      const ctxA = makeRecordingCtx();
      const size = renderPosterInto(ctxA, type, state, 1234);
      const want = posterCanvasSize(type);
      if (size.width !== want.width || size.height !== want.height) sizesOk = false;

      // the first aging alpha assignment matches the state's profile
      // (later painters may compound it with *= factors)
      if (ctxA._alphaSets[0] !== posterAging(state).alpha) alphaOk = false;

      // real drawing happened beyond save/restore bookkeeping
      const draws = ctxA.calls.filter((c) => c[0] === 'fillRect' || c[0] === 'fillText' || c[0] === 'arc' || c[0] === 'lineTo').length;
      if (draws < 5) drewOk = false;

      // torn states punch destination-out tear notches
      if (state !== 'fresh') {
        const notchFills = ctxA.calls.filter((c) => c[0] === 'beginPath' && c.length === 1).length;
        if (notchFills > 0) tearsSeen += 1;
      }

      // determinism: same args -> identical recorded op stream
      const ctxB = makeRecordingCtx();
      renderPosterInto(ctxB, type, state, 1234);
      if (JSON.stringify(ctxA.calls) !== JSON.stringify(ctxB.calls)) drewOk = false;
    }
  }
  check('baked canvas size matches posterCanvasSize per type', sizesOk);
  check('baking applies each state\'s aging alpha', alphaOk);
  check('baked canvases actually draw artwork (and reproducibly)', drewOk);
  check('torn/faded variants run the tear-notch pass', tearsSeen >= 10, String(tearsSeen));

  // seed sensitivity: different seeds diverge somewhere
  const a = makeRecordingCtx();
  const b = makeRecordingCtx();
  renderPosterInto(a, 'map', 'torn', 1);
  renderPosterInto(b, 'map', 'torn', 2);
  check('seed changes the baked artwork', JSON.stringify(a.calls) !== JSON.stringify(b.calls));
}

// ---- quad contract (CornerAO drop-in shape) ---------------------------------

function triNormal(p, a, b, c) {
  const ax = p[b * 3] - p[a * 3], ay = p[b * 3 + 1] - p[a * 3 + 1], az = p[b * 3 + 2] - p[a * 3 + 2];
  const bx = p[c * 3] - p[a * 3], by = p[c * 3 + 1] - p[a * 3 + 1], bz = p[c * 3 + 2] - p[a * 3 + 2];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function centroid(q) {
  let x = 0, y = 0, z = 0;
  for (let v = 0; v < 4; v++) { x += q.positions[v * 3]; y += q.positions[v * 3 + 1]; z += q.positions[v * 3 + 2]; }
  return [x / 4, y / 4, z / 4];
}

function makePlacement(type, state, x, z, rotY, y = 1.55) {
  return { x, z, y, rotY, type, state };
}

const pass = new PosterMesherPass();

{
  const placements = [
    makePlacement('missing', 'faded', 3.25, -7.5, Math.PI),
    makePlacement('event', 'torn', 12.5, 4, 0),
    makePlacement('safety', 'fresh', -2, 9.75, Math.PI / 2),
  ];
  const quads = pass.generate(placements);
  check('one quad per placement', quads.length === placements.length);

  let shapeOk = true;
  for (const q of quads) {
    if (!Array.isArray(q.positions) || q.positions.length !== 12) shapeOk = false;
    if (!Array.isArray(q.tints) || q.tints.length !== 12) shapeOk = false;
    if (!Array.isArray(q.normal) || q.normal.length !== 3) shapeOk = false;
    for (let v = 0; v < 4; v++) {
      const r = q.tints[v * 3], g = q.tints[v * 3 + 1], b = q.tints[v * 3 + 2];
      if (!(r === g && g === b)) shapeOk = false;
    }
  }
  check('QuadInstance shape matches CornerAO contract', shapeOk);

  const normalsOk = quads.every((q, i) => {
    const n = placements[i].rotY;
    return close(q.normal[0], Math.sin(n), 1e-12)
      && q.normal[1] === 0
      && close(q.normal[2], Math.cos(n), 1e-12);
  });
  check('normal follows the placement yaw (sin, 0, cos)', normalsOk);

  const windOk = quads.every((q) => {
    const n = q.normal;
    const t1 = triNormal(q.positions, 0, 1, 2);
    const t2 = triNormal(q.positions, 0, 2, 3);
    const dot = (t) => t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
    return dot(t1) > 1e-9 && dot(t2) > 1e-9;
  });
  check('corners wind CCW seen from the wall-normal side', windOk);

  const centOk = quads.every((q, i) => {
    const p = placements[i];
    const [cx, cy, cz] = centroid(q);
    const ex = p.x + Math.sin(p.rotY) * POSTER_QUAD_OFFSET;
    const ez = p.z + Math.cos(p.rotY) * POSTER_QUAD_OFFSET;
    return close(cx, ex) && close(cy, p.y) && close(cz, ez);
  });
  check('quad centers on the anchor lifted along the wall normal', centOk);

  // physical size: width constant, height per type aspect
  const dims = POSTER_TYPES.map((t) => {
    const q = pass.generate([makePlacement(t, 'fresh', 0, 0, 0)])[0];
    const xs = [], ys = [];
    for (let v = 0; v < 4; v++) { xs.push(q.positions[v * 3]); ys.push(q.positions[v * 3 + 1]); }
    return [(Math.max(...xs) - Math.min(...xs)), (Math.max(...ys) - Math.min(...ys))];
  });
  const aspectOk = POSTER_TYPES.every((t, i) => {
    const s = posterQuadSize(t);
    const c = posterCanvasSize(t);
    return close(s.width, POSTER_QUAD_WIDTH)
      && close(s.height, POSTER_QUAD_WIDTH * (c.height / c.width), 1e-12)
      && close(dims[i][0], s.width, 1e-9) && close(dims[i][1], s.height, 1e-9);
  });
  check('quads carry constant width and per-type aspect height', aspectOk);
  const distinctH = new Set(dims.map((d) => Math.round(d[1] * 1000))).size;
  check('different types bake differently-sized quads', distinctH >= POSTER_TYPES.length - 1, JSON.stringify(dims));

  check('empty placement list yields empty batch', pass.generate([]).length === 0);
}

// ---- state-driven visuals ----------------------------------------------------

{
  const mk = (s) => pass.generate([makePlacement('missing', s, 5, 5, 0)])[0];
  const fresh = mk('fresh'), faded = mk('faded'), torn = mk('torn');

  check('tint formula tracks posterAging alpha per state',
    close(fresh.tints[0], posterTintForState('fresh'), 1e-12)
    && close(faded.tints[0], posterTintForState('faded'), 1e-12)
    && close(torn.tints[0], posterTintForState('torn'), 1e-12));

  check('aged/torn states reduce alpha below fresh',
    faded.tints[0] < fresh.tints[0] && torn.tints[0] < fresh.tints[0]);
  check('faded is the most bleached state', faded.tints[0] < torn.tints[0]);
  check('tints stay in (0, 1]',
    [fresh, faded, torn].every((q) => q.tints[0] > 0 && q.tints[0] <= 1));
  check('alpha field mirrors the shared tint scalar',
    [fresh, faded, torn].every((q) => q.alpha === q.tints[0] && q.tints.every((t) => t === q.alpha)));

  // texture binding metadata
  check('textureKey identifies type+state pair',
    fresh.textureKey === posterTextureKey('missing', 'fresh')
    && fresh.type === 'missing' && fresh.state === 'fresh');
  const keys = new Set(ALL_POSTER_TEXTURE_KEYS);
  check('texture-key catalog covers every type x state exactly once',
    keys.size === POSTER_TYPES.length * POSTER_STATES.length
    && ALL_POSTER_TEXTURE_KEYS.length === keys.size);
  check('posterSeedFor is a stable function of position',
    posterSeedFor(makePlacement('map', 'torn', 7.25, -3.5, 0))
      === posterSeedFor(makePlacement('map', 'torn', 7.25, -3.5, 0)));
}

// ---- options & degenerate input -----------------------------------------------

{
  const custom = new PosterMesherPass({ offset: 0.05 });
  const q = custom.generate([makePlacement('event', 'faded', 1, 1, 0)])[0];
  const [cx, , cz] = centroid(q);
  check('offset option moves the standoff along the normal', close(cx, 1) && close(cz, 1 + 0.05));

  const junk = pass.generate([null, makePlacement('map', 'fresh', NaN, 0, 0), undefined]);
  check('degenerate placements emit nothing', junk.length === 0);

  // vertical clamp keeps corners on the wall face
  const low = pass.generate([makePlacement('safety', 'fresh', 2, 2, 0, 0.001)])[0];
  const high = pass.generate([makePlacement('motivational', 'torn', 2, 2, 0, 99)])[0];
  const ysOf = (q) => [0, 3, 6, 9].map((i) => q.positions[i + 1]);
  const lo = new PosterMesherPass({ offset: 0 }).generate([makePlacement('safety', 'fresh', 2, 2, 0, 0.001)])[0];
  check('low anchors clamp inside the wall band', ysOf(lo).every((y) => y >= POSTER_MIN_Y - 1e-9), JSON.stringify(ysOf(lo)));
  check('high anchors clamp below the ceiling line', ysOf(high).every((y) => y <= 3.05 - POSTER_MIN_Y + 1e-9), JSON.stringify(ysOf(high)));
  void low;
}

// ---- integration with getPostersForChunk ---------------------------------------

{
  // scan chunks until several gate on (~1 in 7)
  const found = [];
  for (let cx = -20; cx < 40 && found.length < 8; cx++) {
    for (let cz = -20; cz < 40 && found.length < 8; cz++) {
      const ps = getPostersForChunk(cx, cz, 42);
      if (ps.length) found.push(ps);
    }
  }
  check('found gated chunks carrying posters', found.length >= 3, String(found.length));

  const flat = found.flat();
  const quads = pass.generate(flat);
  check('emits one quad per real placement', quads.length === flat.length);

  const bandOk = quads.every((q) => {
    for (let v = 0; v < 4; v++) {
      const y = q.positions[v * 3 + 1];
      if (!(y > 0 && y < 3.05)) return false;
    }
    return true;
  });
  check('all integrated quads sit on the wall face', bandOk);

  const statesCovered = new Set(quads.map((q) => q.state));
  const typesCovered = new Set(quads.map((q) => q.type));
  check('integrated batches carry valid state/type metadata',
    [...statesCovered].every((s) => POSTER_STATES.includes(s))
    && [...typesCovered].every((t) => POSTER_TYPES.includes(t)));

  // determinism: byte-identical regeneration, order-stable
  const again = pass.generate([...flat].reverse());
  const firstReversed = [...quads].reverse();
  let stable = again.length === firstReversed.length;
  if (stable) {
    for (let i = 0; i < again.length; i++) {
      for (let c = 0; c < 12; c++) {
        if (again[i].positions[c] !== firstReversed[i].positions[c]) stable = false;
        if (again[i].tints[c] !== firstReversed[i].tints[c]) stable = false;
      }
      if (again[i].normal.some((n, k) => n !== firstReversed[i].normal[k])) stable = false;
      if (again[i].textureKey !== firstReversed[i].textureKey) stable = false;
    }
  }
  check('regeneration is order-stable and byte-identical', stable);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


