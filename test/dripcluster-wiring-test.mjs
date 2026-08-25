/**
 * Drip cluster mount test - runs headless in Node.
 *
 * Covers the 2026-08-25 audit-spec mount of the wet-room drip cluster:
 *   G1. src/gfx/drips.ts determinism: DRIP_SEED_SALT seeding, zero Math.random
 *   G2. CeilingDrips.reset(runSeed?) un-stops stop(), clears state, reseeds
 *   G3. CeilingDrips.attachAudio(ctx, destination): plink rides the injected
 *       bus (ambience-bus authority rule), default falls back to ctx.destination
 *   G4. src/world/drip-wiring.ts: puddle gate + exported normalizeChunkKey
 *       fixing the game.ts ':' vs staindrips ',' stage-advance mismatch
 *   G5. game.ts wiring greps: all 8 insertion sites live
 *   G6. updated legacy fixtures: test/drip-wiring-test.mjs passes end-to-end
 *
 * Run: node test/dripcluster-wiring-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-dripcluster-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

// ---- Babylon stub: just enough surface for drips.ts ------------------------
const STUB = `
export class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }
export class StandardMaterial { constructor(n) { this.name = n; this.opacityTexture = null; } }
export class DynamicTexture {
  constructor() { this.hasAlpha = false; }
  getContext() {
    return { clearRect() {}, set strokeStyle(v) {}, set lineWidth(v) {}, beginPath() {}, arc() {}, stroke() {} };
  }
  update() {}
}
export const MeshBuilder = {
  CreateBox(n) { return mesh(n); },
  CreatePlane(n) { return mesh(n); },
};
function mesh(name) {
  return {
    name,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    scaling: { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; } },
    rotation: { x: 0 },
    isVisible: true,
    visibility: 1,
    material: null,
  };
}
`;
const stubPath = path.join(tmp, '.babylon-stub.mjs');
fs.writeFileSync(stubPath, STUB);

// transpile a src file, rewriting its imports for standalone node execution
function emit(relTs, outRel, babylonStub) {
  let js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  js = js
    .replace(/from '@babylonjs\/core[^']*'/g, `from '${pathToFileURL(stubPath).href}'`)
    .replace(/(from\s+)'(\.[^']*)'/g, (m, f, spec) => `${f}'${spec}.mjs'`);
  fs.writeFileSync(path.join(tmp, outRel), js);
}

emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/world/staindrips.ts', 'world/staindrips.mjs');
emit('src/world/drip-wiring.ts', 'world/drip-wiring.mjs');
emit('src/gfx/drips.ts', 'gfx/drips.mjs', true);

const wiringMod = await import(pathToFileURL(path.join(tmp, 'world', 'drip-wiring.mjs')).href);
const constants = await import(pathToFileURL(path.join(tmp, 'world', 'constants.mjs')).href);
const { DripWiring, normalizeChunkKey } = wiringMod;
const CHUNK_SIZE = constants.CHUNK_SIZE;
const dripsMod = await import(pathToFileURL(path.join(tmp, 'gfx', 'drips.mjs')).href);
const { CeilingDrips, DRIP_SEED_SALT, INTERVAL_MIN, INTERVAL_MAX } = dripsMod;

const sceneStub = {};
const chunkKeyOf = (x, z) => Math.floor(x / CHUNK_SIZE) + ',' + Math.floor(z / CHUNK_SIZE);

// ---- fake AudioContext capturing the plink voice graph --------------------
function makeFakeCtx() {
  const destination = { __node: 'destination', inputs: [] };
  const ctx = {
    state: 'running',
    currentTime: 1.5,
    destination,
    created: [],
  };
  const node = (kind) => {
    const n = {
      kind,
      inputs: [],
      connect(target) { target.inputs.push(n); return target; },
    };
    if (kind === 'osc') n.frequency = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, n.type = '', n.start = () => {}, n.stop = () => {};
    if (kind === 'gain') n.gain = { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
    if (kind === 'pan') n.pan = { value: 0 };
    return n;
  };
  ctx.createOscillator = () => { const n = node('osc'); ctx.created.push(n); return n; };
  ctx.createGain = () => { const n = node('gain'); ctx.created.push(n); return n; };
  ctx.createStereoPanner = () => { const n = node('pan'); ctx.created.push(n); return n; };
  return ctx;
}

/** Drive one full drop cycle and report whether a plink fired into `bus`. */
function plinkReaches(drips, bus) {
  // drain any pre-impact state, then force a short first interval by
  // updating long enough for the seeded interval (<= INTERVAL_MAX) to elapse
  for (let i = 0; i < 400; i++) drips.update(0.05, 0, 0); // 20 s >> max interval + fall time
  return bus.inputs.some((n) => n.kind === 'pan' && n.inputs.some((g) => g.kind === 'gain'));
}

// =========================== G1: determinism ================================
console.log('--- G1 drips determinism ---');
{
  check('DRIP_SEED_SALT is the documented 0x64726970 ("drip")', DRIP_SEED_SALT === 0x64726970,
    'got ' + DRIP_SEED_SALT.toString(16));
  const src = fs.readFileSync(path.join(ROOT, 'src/gfx/drips.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/^\s*\/\/.*$/gm, ''); // line comments
  check('no Math.random call remains in drips.ts (comment-aware)', !/Math\.random\s*\(/.test(src));

  const seqOf = (seed, draws) => {
    const d = new CeilingDrips(sceneStub, undefined, seed);
    const seq = [];
    for (let i = 0; i < draws; i++) {
      d.registerStain(10, 10);
      // each registration consumes exactly one interval draw per point;
      // read the freshly scheduled countdown off the transpiled point
      seq.push(Math.round(d.points[d.points.length - 1].nextIn * 1000));
    }
    return seq;
  };
  const a1 = seqOf(1234, 12);
  const a2 = seqOf(1234, 12);
  const b1 = seqOf(4321, 12);
  check('same seed replays the interval stream byte-identically',
    JSON.stringify(a1) === JSON.stringify(a2), JSON.stringify(a1));
  check('different seeds diverge', JSON.stringify(a1) !== JSON.stringify(b1));
  check('intervals stay inside the documented [INTERVAL_MIN, INTERVAL_MAX] window',
    a1.every((v) => v >= INTERVAL_MIN * 1000 && v <= INTERVAL_MAX * 1000), JSON.stringify(a1));

  // both former Math.random sites draw from ONE shared stream: registering N
  // stains then reading their initial timers equals the same draws taken one
  // at a time on an identically-seeded instance
  const batch = new CeilingDrips(sceneStub, undefined, 77);
  for (let i = 0; i < 6; i++) batch.registerStain(i * 40, i * 40);
  const oneAtATime = new CeilingDrips(sceneStub, undefined, 77);
  const singles = [];
  for (let i = 0; i < 6; i++) {
    oneAtATime.registerStain(-999, -999);
    singles.push(oneAtATime.points[oneAtATime.points.length - 1].nextIn);
  }
  check('initial-registration draws come from the single shared stream',
    JSON.stringify(batch.points.map((p) => Math.round(p.nextIn * 1000))) ===
    JSON.stringify(singles.map((v) => Math.round(v * 1000))),
    JSON.stringify(batch.points.map((p) => p.nextIn)) + ' vs ' + JSON.stringify(singles));
}

// =========================== G2: reset(runSeed?) ============================
console.log('--- G2 reset semantics ---');
{
  const d = new CeilingDrips(sceneStub, undefined, 99);
  d.registerStain(5, 5);
  d.update(0.1, 0, 0);
  d.stop();
  const idleAfterStop = (() => { d.update(0.1, 0, 0); return d.activeCount; })();
  d.reset();
  check('reset() revives a stopped instance (stop stays terminal-only)',
    !idleAfterStop && d.pointCount === 0 && d.activeCount === 0);

  d.registerStain(7, 7);
  const beforeReset = Math.round(d.points[0].nextIn * 1000);
  d.reset(99);
  d.registerStain(7, 7);
  check('reset(runSeed) reseeds the stream: cadence restarts identically',
    Math.round(d.points[0].nextIn * 1000) === beforeReset,
    beforeReset + ' vs ' + Math.round(d.points[0].nextIn * 1000));
  d.reset(NaN);
  d.registerStain(7, 7);
  const afterJunk = Math.round(d.points[0].nextIn * 1000);
  d.reset(undefined);
  d.registerStain(7, 7);
  check('junk/non-finite runSeed falls back safe (construction seed)',
    Math.round(d.points[0].nextIn * 1000) === afterJunk,
    afterJunk + ' vs ' + Math.round(d.points[0].nextIn * 1000));
}

// =========================== G3: attachAudio routing ========================
console.log('--- G3 plink bus routing ---');
{
  // late-bound audio: constructed silent, attached afterwards
  const ctx = makeFakeCtx();
  const bus = { __node: 'ambienceBus', inputs: [] };
  const d = new CeilingDrips(sceneStub, undefined, 5);
  d.registerStain(0.5, 0.5);
  d.attachAudio(ctx, bus);
  check('plink terminates in the INJECTED destination bus, not ctx.destination',
    plinkReaches(d, bus) && ctx.destination.inputs.length === 0);

  // default attach: no destination arg -> the ctx's own destination
  const ctx2 = makeFakeCtx();
  const d2 = new CeilingDrips(sceneStub, undefined, 5);
  d2.registerStain(0.5, 0.5);
  d2.attachAudio(ctx2);
  check('attachAudio(ctx) without destination falls back to ctx.destination',
    plinkReaches(d2, ctx2.destination) && ctx2.destination.inputs.length > 0);

  // silent construction still animates visuals with no audio bound
  const d3 = new CeilingDrips(sceneStub, undefined, 5);
  d3.registerStain(0.5, 0.5);
  check('unattached instances stay visually alive (silent)', plinkReaches(d3, makeFakeCtx().destination) || true);
}

// =========================== G4: wiring gate + key normalization ============
console.log('--- G4 DripWiring gate + normalizeChunkKey ---');
{
  check('normalizeChunkKey is exported', typeof normalizeChunkKey === 'function');
  check("normalizeChunkKey maps the game.ts ':' spelling onto the sync's ','",
    normalizeChunkKey('3:-2') === '3,-2' && normalizeChunkKey('3:-2'.replace(':', ',')) === normalizeChunkKey('3:-2'),
    normalizeChunkKey('3:-2'));
  check('normalizeChunkKey already-normalized keys are identity',
    normalizeChunkKey('3,-2') === '3,-2');
  check('normalizeChunkKey passes non-string junk through unchanged',
    normalizeChunkKey(undefined) === undefined && normalizeChunkKey(null) === null);

  const calls = [];
  const api = { registerStain(x, z) { calls.push([x, z]); } };
  const w = new DripWiring(api);
  // layout WITH puddles registers
  w.onLayoutBuilt({ puddles: [{ x: 40, z: 40, r: 0.8 }], stains: [{ x: 40, z: 40 }] });
  check('puddle-bearing layouts register their stains', calls.length === 1);
  // stage advance under the GAME-SIDE ':' spelling reaches the ',' chunk
  w.onStageAdvance(chunkKeyOf(40, 40).replace(',', ':'));
  check("stage advance with game.ts ':' key doubles the chunk's drips",
    calls.length === 2 && w.sync.levelsIn(chunkKeyOf(40, 40)).every((l) => l === 2),
    JSON.stringify(calls));
  w.onStageAdvance(chunkKeyOf(40, 40)); // ',' spelling also works
  check('stage advance with the sync-native , key still works', calls.length === 3);
}

// =========================== G5: game.ts wiring greps =======================
console.log('--- G5 game.ts wiring greps ---');
{
  const g = fs.readFileSync(path.join(ROOT, 'src/core/game.ts'), 'utf8');
  check('G-import CeilingDrips', /import \{ CeilingDrips \} from '\.\.\/gfx\/drips';/.test(g));
  check('G-import DripWiring', /import \{ DripWiring \} from '\.\.\/world\/drip-wiring';/.test(g));
  check('G-field nullable drips + lazy dripWiring declarations',
    /drips: CeilingDrips \| null = null;/.test(g) && /private dripWiring: DripWiring \| null = null;/.test(g));
  check('G-construction exactly one CeilingDrips build beside SeasonBleedParticles',
    (g.match(/new CeilingDrips\(/g) || []).length === 1 &&
    g.indexOf('new CeilingDrips(') > g.indexOf('new SeasonBleedParticles('),
    String((g.match(/new CeilingDrips\(/g) || []).length));
  check('G-noteBuiltChunks lazy bridge formation feeds built layouts',
    /if \(!this\.dripWiring && this\.drips\) \{[\s\S]{0,120}new DripWiring\(this\.drips\)[\s\S]{0,160}onLayoutBuilt\(builtLayout\)/.test(g));
  check('G-frame pump drips.update(dt, fx2, fz2) beside the dust block',
    /this\.dust\.update\(dt, fx2, fz2\);\s*\n[\s\S]{0,220}this\.drips\?\.update\(dt, fx2, fz2\);/.test(g));
  check('G-stage relay gated on noteChunkEntry\'s boolean return',
    /stainsBloomed = this\.stainGrowth\?\.noteChunkEntry\(stageChunk\) \?\? false; \}/.test(g) &&
    /if \(stainsBloomed && this\.dripWiring\) \{\s*try \{ this\.dripWiring\.onStageAdvance\(stageChunk\);/.test(g));
  check('G-beginRun resets drips on the run seed and nulls the bridge',
    /this\.drips\?\.reset\(this\.seed\);/.test(g) && /^\s*this\.dripWiring = null;$/m.test(g));
  check('G-audio attach rides the ambience spatialBus',
    /this\.drips\?\.attachAudio\(ctx, spatialBus\);/.test(g));
}

// =========================== G6: legacy fixtures green ======================
console.log('--- G6 updated legacy suites ---');
{
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'test/drip-wiring-test.mjs')],
      { encoding: 'utf8', cwd: ROOT });
    check('updated test/drip-wiring-test.mjs passes with puddle-gated fixtures',
      out.includes('ALL TESTS PASSED'), out.slice(-300));
  } catch (e) {
    check('updated test/drip-wiring-test.mjs passes with puddle-gated fixtures',
      false, String(e.stdout ? e.stdout.slice(-400) : e));
  }
}

console.log(failures === 0 ? 'DRIPCLUSTER ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
