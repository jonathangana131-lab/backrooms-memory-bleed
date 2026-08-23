/**
 * Radio dial mesh integration tests (src/gfx/radiodial-mesh.ts): the
 * Babylon bridge bakes radiodial faces into DynamicTextures and wires
 * them into a StandardMaterial. Babylon is replaced by a recording stub,
 * so every painter op is observable.
 *
 *   node test/radiodial-mesh-test.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

// ---- transpile source modules ----------------------------------------------
const COPTS = { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } };

function transpile(rel, rewrites) {
  const src = readFileSync(join(root, rel), 'utf8');
  let out = ts.transpileModule(src, COPTS).outputText;
  // rewrite lists are flat: [pattern, replacement, pattern, replacement, ...]
  for (let i = 0; i + 1 < rewrites.length; i += 2) {
    out = out.replace(rewrites[i], rewrites[i + 1]);
  }
  return out;
}

writeFileSync(
  join(root, 'test/.dialmesh-rng.gen.mjs'),
  transpile('src/core/rng.ts', []),
);
writeFileSync(
  join(root, 'test/.dialmesh-dial.gen.mjs'),
  transpile('src/gfx/radiodial.ts', [
    /from '..\/core\/rng'/g,
    "from './.dialmesh-rng.gen.mjs'",
  ]),
);
writeFileSync(
  join(root, 'test/.dialmesh.gen.mjs'),
  transpile('src/gfx/radiodial-mesh.ts', [
    /from '@babylonjs\/core[^']*'/g,
    "from './.dialmesh-stub.gen.mjs'",
    /from '.\/radiodial'/g,
    "from './.dialmesh-dial.gen.mjs'",
  ]),
);

// ---- Babylon stub: DynamicTexture + StandardMaterial + Color3 --------------
const STUB_SRC = [
  'export class Color3 {',


  '  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }',
  '}',
  'export class StandardMaterial {',
  '  constructor(name, scene) { void scene;',
  '    this.name = name;',
  '    this.diffuseTexture = null; this.emissiveTexture = null;',
  '    this.emissiveColor = null; this.specularColor = null;',
  '    this.backFaceCulling = true; }',
  '}',
  // Recording DynamicTexture: getContext() hands back a stub satisfying the
  // DialCtx surface paintDialInto needs, logging every op in call order.
  'export class DynamicTexture {',
  '  constructor(name, opts, scene, generateMipMaps) {',
  '    this.name = name; this.opts = opts;',
  '    this.generateMipMaps = generateMipMaps; this.scene = scene;',
  '    this.updated = false; this.updateArg = null;',
  '    const self = this;',
  '    const ops = [];',
  '    const rec = (op) => (...args) => { ops.push([op, ...args]); };',
  '    const grad = (op, args) => { rec(op)(...args); const stops = []; return { stops, addColorStop: (t, col) => stops.push([t, col]) }; };',
  '    this.ops = ops;',
  '    this.ctx = {',
  '      save: rec("save"), restore: rec("restore"),',
  '      fillRect: rec("fillRect"), strokeRect: rec("strokeRect"),',
  '      beginPath: rec("beginPath"), closePath: rec("closePath"),',
  '      moveTo: rec("moveTo"), lineTo: rec("lineTo"), arc: rec("arc"),',
  '      fill: rec("fill"), stroke: rec("stroke"),',
  '      fillText: rec("fillText"),',
  '      createLinearGradient: (...a) => grad("createLinearGradient", a),',
  '      createRadialGradient: (...a) => grad("createRadialGradient", a),',
  '      font: "", textAlign: "", textBaseline: "",',
  '      fillStyle: "", strokeStyle: "", lineWidth: 0,',
  '      shadowColor: "", shadowBlur: 0,',
  '    };',
  '  }',
  '  getContext() { return this.ctx; }',
  '  update(arg) { this.updated = true; this.updateArg = arg === undefined ? null : arg; }',
  '}',
].join('\n');
writeFileSync(join(root, 'test/.dialmesh-stub.gen.mjs'), STUB_SRC);

const mod = await import(join(root, 'test/.dialmesh.gen.mjs').replace(/\\/g, '/'));
const dialMod = await import(join(root, 'test/.dialmesh-dial.gen.mjs').replace(/\\/g, '/'));
const { createDialTexture, createDialLitTexture, createDialMaterial } = mod;
const {
  dialCanvasSize, dialBrandFor, dialRestFreq, needleXFor, DIAL_BRANDS,

} = dialMod;

const EPS = 1e-6;

// ---- minimal scene stub (factories never touch it beyond passing it on) ----
const scene = { name: 'stub-scene' };

{
  // --- resting face texture ---------------------------------------------------
  const tex = createDialTexture(scene, 42);
  check('texture sized from dialCanvasSize',
    tex.opts.width === dialCanvasSize().width && tex.opts.height === dialCanvasSize().height);
  check('face uploaded to the GPU once without mip regeneration flag arg',
    tex.updated === true && tex.updateArg === false, JSON.stringify(tex.updateArg));
  check('resting face paints a full procedural pass', tex.ops.length > 100, 'ops=' + tex.ops.length);

  const again = createDialTexture(scene, 42);
  check('same seed -> byte-identical face',
    JSON.stringify(tex.ops) === JSON.stringify(again.ops));
  check('different seed -> different grain/needle',
    JSON.stringify(createDialTexture(scene, 43).ops) !== JSON.stringify(tex.ops));
}

{
  // --- lit twin -----------------------------------------------------------------
  const dim = createDialTexture(scene, 7);
  const lit = createDialLitTexture(scene, 7);
  check('lit twin differs from the resting face',
    JSON.stringify(lit.ops) !== JSON.stringify(dim.ops));
  check('lit twin uploads too', lit.updated === true);
}

{
  // --- material wiring ------------------------------------------------------------
  const mat = createDialMaterial(scene, 9);
  check('material carries both faces',
    !!mat.diffuseTexture && !!mat.emissiveTexture);
  check('emissive color is the warm documented amber',
    Math.abs(mat.emissiveColor.r - 1.0) < EPS &&
    Math.abs(mat.emissiveColor.g - 0.82) < EPS &&
    Math.abs(mat.emissiveColor.b - 0.45) < EPS);
  check('specular killed: bakelite does not gleam',
    mat.specularColor.r === 0 && mat.specularColor.g === 0 && mat.specularColor.b === 0);
  check('back-face culling stays on', mat.backFaceCulling === true);
  check('material named after its seed', mat.name.includes('9'));
}

// ---- clean up the temp transpile artifacts this test wrote ----
for (const f of ['.dialmesh.gen.mjs', '.dialmesh-dial.gen.mjs', '.dialmesh-rng.gen.mjs', '.dialmesh-stub.gen.mjs']) {
  try { unlinkSync(join(root, 'test', f)); } catch { /* already gone */ }
}

console.log(failures === 0 ? '\nALL RADIODIAL MESH TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
