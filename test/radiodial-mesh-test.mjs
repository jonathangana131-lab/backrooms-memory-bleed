import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- transpile source modules ----------------------------------------------
const COPTS = { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } };

function transpile(rel, rewrites) {
  const src = readFileSync(join(root, rel), 'utf8');
  let out = ts.transpileModule(src, COPTS).outputText;
  for (const [re, to] of rewrites) out = out.replace(re, to);
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

(Showing lines 20-59 of 235. Use offset=60 to continue.)

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
  '    this.ops = ops;',
  '    this.ctx = {',
  '      save: rec("save"), restore: rec("restore"),',
  '      fillRect: rec("fillRect"), strokeRect: rec("strokeRect"),',
  '      beginPath: rec("beginPath"), closePath: rec("closePath"),',
  '      moveTo: rec("moveTo"), lineTo: rec("lineTo"), arc: rec("arc"),',
  '      fill: rec("fill"), stroke: rec("stroke"),',
  '      fillText: rec("fillText"),',
  '      createLinearGradient: rec("createLinearGradient"),',
  '      createRadialGradient: rec("createRadialGradient"),',
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

(Showing lines 55-104 of 232. Use offset=105 to continue.)

