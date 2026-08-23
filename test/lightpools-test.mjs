/**
 * Unit tests for procedural light pools (src/gfx/lightpools.ts).
 * Standalone (no browser): transpiles the module (+ rng) into a temp dir
 * and drives the pure spec/sample API.
 * Run: node test/lightpools-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-lightpools-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/gfx/lightpools.ts', 'gfx/lightpools.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx/lightpools.mjs')).href);
const {
  LightPools, POOL_VARIANT_COUNT, POOL_TEXTURE_SIZE,
  VARIANT_RECT_SOFT, VARIANT_TUBE_OVAL, VARIANT_AGED_BLOB, VARIANT_DUAL_LOBE,
} = mod;

// ---- variant constants + getTexture --------------------------------------

check('four variants declared', POOL_VARIANT_COUNT === 4);
check('variant constants are 0..3',
  VARIANT_RECT_SOFT === 0 && VARIANT_TUBE_OVAL === 1 &&
  VARIANT_AGED_BLOB === 2 && VARIANT_DUAL_LOBE === 3);

const specs = [0, 1, 2, 3].map((v) => LightPools.getTexture(v));

check('every spec has power-of-two size',
  specs.every((s) => s.size === POOL_TEXTURE_SIZE && (s.size & (s.size - 1)) === 0),
  JSON.stringify(specs.map((s) => s.size)));

check('every spec has gradient stops',
  specs.every((s) => s.gradients.length > 0 && s.gradients.every(
    (gr) => gr.stops.length >= 2 &&
      gr.stops.every((st) => st.at >= 0 && st.at <= 1 && st.a >= 0 && st.a <= 1))));

// stop profiles must be ascending in offset so canvas addColorStop is valid
let sortedStops = true;
for (const s of specs) {
  for (const gr of s.gradients) {
    for (let i = 1; i < gr.stops.length; i++) {
      if (gr.stops[i].at < gr.stops[i - 1].at) sortedStops = false;
    }
  }
}
check('gradient stops ascend by offset', sortedStops);

check('specs are distinct per variant',
  new Set(specs.map((s) => JSON.stringify(s.gradients))).size === 4);

check('getTexture caches per variant',
  LightPools.getTexture(1) === LightPools.getTexture(1));

check('unknown variant falls back without throwing',
  (() => { const s = LightPools.getTexture(99); return !!s && s.size === POOL_TEXTURE_SIZE; })());

// ---- deterministic assignment ---------------------------------------------

let assignOk = true;
let rotOk = true;
for (let i = 0; i < 500; i++) {
  const x = (i * 37) % 211 - 100 + i * 0.137;
  const z = (i * 91) % 173 - 80 - i * 0.251;
  const v1 = LightPools.variantFor(x, z);
  const v2 = LightPools.variantFor(x, z);
  if (v1 !== v2 || !Number.isInteger(v1) || v1 < 0 || v1 >= 4) assignOk = false;
  const r1 = LightPools.rotationFor(x, z);
  const r2 = LightPools.rotationFor(x, z);
  if (r1 !== r2 || r1 < 0 || r1 >= Math.PI * 2) rotOk = false;
}
check('variantFor deterministic + in range', assignOk);
check('rotationFor deterministic + in [0,2pi)', rotOk);

const seen = new Set();
for (let x = -40; x < 40; x += 0.5) for (let z = -40; z < 40; z += 0.5) seen.add(LightPools.variantFor(x, z));
check('all four variants occur across space', seen.size === 4, 'saw ' + [...seen].join(','));

check('nearby distinct fixtures can differ',
  new Set([
    LightPools.variantFor(3.1, 7.7),
    LightPools.variantFor(3.9, 7.7),
    LightPools.variantFor(3.1, 8.6),
    LightPools.variantFor(4.7, 8.6),
  ]).size > 1);

// ---- analytic pool shapes ---------------------------------------------------

function alphaAt(variant, u, v) { return LightPools.sampleAlpha(variant, u, v); }

// center is always a bright spot of every variant (aged blob allows for
// its deep noise modulation on top of the composited gradients)
check('center bright for all variants',
  specs.every((s, v) => alphaAt(v, 0.5, 0.5) > (s.noiseAmount > 0.3 ? 0.42 : 0.55)));

// rect soft: roughly square silhouette -> similar falloff along both axes,
// clearly wider than the tube's cross-section
const rectX = alphaAt(VARIANT_RECT_SOFT, 0.5 + 0.30, 0.5);
const rectY = alphaAt(VARIANT_RECT_SOFT, 0.5, 0.5 + 0.30);
const tubeY = alphaAt(VARIANT_TUBE_OVAL, 0.5, 0.5 + 0.30);
const tubeX = alphaAt(VARIANT_TUBE_OVAL, 0.5 + 0.34, 0.5);
check('rect pool near-isotropic', Math.abs(rectX - rectY) < 0.22,
  'x=' + rectX.toFixed(3) + ' y=' + rectY.toFixed(3));
check('tube elongated along its long axis', tubeX > tubeY + 0.15,
  'along=' + tubeX.toFixed(3) + ' across=' + tubeY.toFixed(3));
check('tube narrower than panel across', tubeY < rectY - 0.05,
  'tube=' + tubeY.toFixed(3) + ' rect=' + rectY.toFixed(3));

// dual-lobe: two peaks off-center along v, dip at center relative to peaks
const lobeA = alphaAt(VARIANT_DUAL_LOBE, 0.5, 0.37);
const lobeB = alphaAt(VARIANT_DUAL_LOBE, 0.5, 0.63);
const lobeMid = alphaAt(VARIANT_DUAL_LOBE, 0.5, 0.5);
check('dual-lobe has two peaks with central dip',
  lobeA > lobeMid + 0.08 && lobeB > lobeMid + 0.08,
  'a=' + lobeA.toFixed(3) + ' b=' + lobeB.toFixed(3) + ' mid=' + lobeMid.toFixed(3));

// aged blob: heavy noise makes it asymmetric and rough vs the clean rect
function roughness(v) {
  let sum = 0, n = 0;
  for (let u = 0.35; u <= 0.65; u += 0.02) {
    for (let vv = 0.35; vv <= 0.65; vv += 0.02) {
      sum += Math.abs(alphaAt(v, u + 0.01, vv) - alphaAt(v, u, vv));
      n++;
    }
  }
  return sum / n;
}
check('aged blob rougher than rect', roughness(VARIANT_AGED_BLOB) > roughness(VARIANT_RECT_SOFT) * 1.5,
  'blob=' + roughness(VARIANT_AGED_BLOB).toFixed(4) + ' rect=' + roughness(VARIANT_RECT_SOFT).toFixed(4));
// aged blob silhouette: scan the v=0.52 row for the lit span and require
// it to be lopsided around the texture center (the rect pool is symmetric)
function litSpan(v) {
  let lo = -1, hi = -1;
  for (let u = 0; u <= 1.0001; u += 0.002) {
    if (alphaAt(v, u, 0.52) > 0.10) { if (lo < 0) lo = u; hi = u; }
  }
  return [lo, hi];
}
const [bLo, bHi] = litSpan(VARIANT_AGED_BLOB);
const [rLo, rHi] = litSpan(VARIANT_RECT_SOFT);
check('aged blob visibly irregular',
  Math.abs((bLo + bHi) / 2 - 0.5) > Math.abs((rLo + rHi) / 2 - 0.5) + 0.02,
  'blob span=' + bLo.toFixed(2) + '..' + bHi.toFixed(2) +
  ' rect span=' + rLo.toFixed(2) + '..' + rHi.toFixed(2));

// sampleAlpha stays in [0,1] everywhere on a dense grid for every variant
let rangeOk = true;
for (let v = 0; v < 4; v++) {
  for (let u = 0; u <= 1.001; u += 0.05) {
    for (let vv = 0; vv <= 1.001; vv += 0.05) {
      const a = alphaAt(v, u, vv);
      if (!(a >= 0 && a <= 1) || Number.isNaN(a)) rangeOk = false;
    }
  }
}
check('sampleAlpha bounded [0,1] everywhere', rangeOk);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


