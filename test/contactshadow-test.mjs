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
  PROP_FOOTPRINTS, SHADOW_Y, SHADOW_ALPHA, SHADOW_TEXTURE_SIZE, SHADOW_MARGIN,
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
  prev = a;
}
check('alpha falls monotonically toward the rim', monotonic);

// ---- placement generation ---------------------------------------------------

const PROPS = [
  { kind: 'desk', x: 10.31, z: -4.2, rot: 0, variant: 0 },
  { kind: 'desk', x: 10.31, z: -4.2, rot: 1, variant: 0 }, // same spot, quarter-turned
  { kind: 'crate', x: -7.7, z: 12.05, rot: 0, variant: 3 }, // variant-sized stack
  { kind: 'battery', x: 3, z: 3, rot: 0, variant: 2 }, // debris-scale: no blob
];

const shadows = generateForProps(PROPS);

check('battery gets no blob, everything else does',
  shadows.length === 3 && shadows.every((s) => s.kind !== 'battery'),
  String(shadows.length));
check('shadows hover at SHADOW_Y', shadows.every((s) => s.y === SHADOW_Y),
  JSON.stringify(shadows.map((s) => s.y)));
check('same layout regenerates byte-identical shadows',
  JSON.stringify(generateForProps(PROPS)) === JSON.stringify(shadows));

const desks = shadows.filter((s) => s.kind === 'desk');
const flat = desks[0], turned = desks[1];
const MARGIN_HALF = 0.5 * SHADOW_MARGIN; // half footprint * 1.12 peek-out

// Jitter stays inside +/-8%, so the blob peeks out ~12% either way.
check('unrotated desk shades along its long axis',
  Math.abs(flat.rx / flat.rz - 1.5 / 0.75) < 1e-9 &&
  flat.rx > 1.5 * MARGIN_HALF * 0.92 && flat.rx < 1.5 * MARGIN_HALF * 1.08,
  'rx=' + flat.rx + ' rz=' + flat.rz);
check('quarter turn swaps the ellipse axes',
  Math.abs(turned.rx - flat.rz) < 1e-12 && Math.abs(turned.rz - flat.rx) < 1e-12,
  'rx=' + turned.rx + ' rz=' + turned.rz);
check('peak alpha rides the same size jitter as the radius',
  close(flat.alpha / SHADOW_ALPHA, flat.rx / (1.5 * MARGIN_HALF), 1e-12),
  'alpha=' + flat.alpha);
check('rotation jitter is organic, not structural',
  shadows.every((s) => Math.abs(s.rot) <= 0.06),
  JSON.stringify(shadows.map((s) => s.rot)));
check('crate blob tracks its variant stack',
  shadows[2].rx > 0 && shadows[2].rz > 0 &&
  close(shadows[2].rx / shadows[2].rz, 1, 1e-9),
  'rx=' + shadows[2].rx + ' rz=' + shadows[2].rz);

// ---- texture painting -------------------------------------------------------

{
  let cleared = null;
  let filled = null;
  let gradArgs = null;
  let gradCount = 0;
  const stops = [];
  const ctx2d = {
    clearRect(x, y, w, h) { cleared = { x, y, w, h }; },
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      gradCount++;
      gradArgs = { x0, y0, r0, x1, y1, r1 };
      return { addColorStop(at, color) { stops.push({ at, color }); } };
    },
    fillStyle: null,
    fillRect(x, y, w, h) { filled = { x, y, w, h }; },
  };
  paintShadowTexture(ctx2d, specA.size);

  check('texture is cleared before painting',
    !!cleared && cleared.x === 0 && cleared.y === 0 &&
    cleared.w === specA.size && cleared.h === specA.size);
  check('one radial gradient centered mid-texture',
    gradCount === 1 && gradArgs.x0 === 0.5 * specA.size && gradArgs.y0 === 0.5 * specA.size &&
    gradArgs.r0 === 0 && gradArgs.r1 === grad.r * specA.size,
    JSON.stringify(gradArgs));
  check('every falloff stop reaches the gradient in order',
    stops.length === grad.stops.length &&
    stops.every((st, i) => st.at === grad.stops[i].at),
    JSON.stringify(stops.map((st) => st.at)));
  check('rim stop fades to fully transparent black',
    stops[stops.length - 1].color === 'rgba(0, 0, 0, 0.000000)',
    stops[stops.length - 1].color);
  check('gradient rasterized across the full texture',
    !!filled && filled.x === 0 && filled.y === 0 &&
    filled.w === specA.size && filled.h === specA.size);
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
