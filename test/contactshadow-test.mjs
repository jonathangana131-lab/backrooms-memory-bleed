/**
 * Unit tests for contact shadows (src/gfx/contactshadow.ts).
 * Standalone (no browser): transpiles the module (+ rng) into a temp
 * dir and drives the pure spec/sample/paint/placement API.
 * Run: node test/contactshadow-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-contactshadow-'));
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
emit('src/gfx/contactshadow.ts', 'gfx/contactshadow.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx/contactshadow.mjs')).href);
const {
  generateForProps, getShadowSpec, sampleShadowAlpha, paintShadowTexture,
  PROP_FOOTPRINTS, SHADOW_Y, SHADOW_ALPHA, SHADOW_TEXTURE_SIZE,
} = mod;

const EPS = 1e-9;
function close(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ---- shared texture spec ---------------------------------------------------

const specA = getShadowSpec();
const specB = getShadowSpec();
check('texture spec is shared/cached across calls', specA === specB);
check('spec size is power of two',
  specA.size === SHADOW_TEXTURE_SIZE && (specA.size & (specA.size - 1)) === 0,
  String(specA.size));
check('spec has exactly one radial gradient', specA.gradients.length === 1);

const grad = specA.gradients[0];
check('gradient is centered', grad.cx === 0.5 && grad.cy === 0.5);

let stopsAscend = true;
for (let i = 1; i < grad.stops.length; i++) {
  if (!(grad.stops[i].at > grad.stops[i - 1].at)) stopsAscend = false;
}
check('gradient stops ascend by offset', stopsAscend);
check('gradient ends at alpha 0 at the rim',
  grad.stops[grad.stops.length - 1].a === 0 &&
  grad.stops[grad.stops.length - 1].at === 1);

// ---- analytic falloff ------------------------------------------------------

check('center alpha == SHADOW_ALPHA (0.15)', sampleShadowAlpha(0) === SHADOW_ALPHA);
check('SHADOW_ALPHA constant is 0.15', SHADOW_ALPHA === 0.15);
check('rim alpha fades to 0', sampleShadowAlpha(1) === 0);
check('alpha clamps beyond rim', sampleShadowAlpha(5) === 0 && sampleShadowAlpha(-3) === SHADOW_ALPHA);

let monotonic = true;
let prev = Infinity;
for (let t = 0; t <= 1.0001; t += 0.01) {
  const a = sampleShadowAlpha(Math.min(t, 1));
  if (a > prev + EPS) monotonic = false;

(Showing lines 1-80 of 222. Use offset=81 to continue.)

