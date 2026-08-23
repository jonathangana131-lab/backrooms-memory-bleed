/**
 * Unit test for radio geometry specs (src/world/radiogeometry.ts).
 * Standalone (no browser): transpiles the module (and its radioprops
 * dependency) into a temp dir and checks part ordering, box dimensions and
 * placement against RADIO_PROP constants, dial emissive hashing, seed
 * sensitivity, determinism, and mesher addBox() argument compatibility.
 * Run: node test/radiogeometry-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-radiogeo-'));
function transpile(rel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, rel), 'utf8'),
    { fileName: rel, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    // Node ESM needs explicit extensions on relative imports.
    .replace(/from '(\.\/[^']+)'/g, String.fromCharCode(102) + "rom '$1.mjs'");
  const out = path.join(tmp, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const rp = await transpile('src/world/radioprops.ts');
const rg = await transpile('src/world/radiogeometry.ts');
const { RADIO_PROP, DIAL_COLOR } = rp;
const { RadioGeometry, dialGlowFor, DIAL_GLOW_MIN, DIAL_GLOW_MAX, ANTENNA_BOX_SIDE } = rg;

const PLACE = { x: 31.83, z: -17.42, y: 0.76 }; // DESK_TOP_Y-style placement
const specs = RadioGeometry.specsFor(PLACE);
const eps = 1e-9;

// --- 1. shape of the returned plan -------------------------------------------
check('returns exactly three box specs', specs.length === 3, 'len=' + specs.length);
check(
  'parts in stable body/antenna/dial order',
  specs.map((s) => s.part).join(',') === 'body,antenna,dial',
);

// --- 2. body box --------------------------------------------------------------
{
  const b = specs[0];
  check('body is 0.26 wide x 0.15 tall x 0.12 deep',
    b.w === 0.26 && b.d === 0.12 && Math.abs(b.y1 - b.y0 - 0.15) < eps,
    'w=' + b.w + ' d=' + b.d + ' h=' + (b.y1 - b.y0));
  check('body dimensions match RADIO_PROP', b.w === RADIO_PROP.width && b.d === RADIO_PROP.depth);
  check('body rests on the placement plane', b.y0 === PLACE.y && Math.abs(b.y1 - (PLACE.y + 0.15)) < eps,
    'y0=' + b.y0 + ' y1=' + b.y1);
  check('body centered on the placement column', b.x === PLACE.x && b.z === PLACE.z);
}

// --- 3. antenna thin box -------------------------------------------------------
{
  const a = specs[1];
  check('antenna approximated as thin box (0.01 x 0.34 x 0.01)',
    a.w === 0.01 && a.d === 0.01 && Math.abs(a.y1 - a.y0 - 0.34) < eps,
    'w=' + a.w + ' d=' + a.d + ' h=' + (a.y1 - a.y0));
  check('antenna length matches RADIO_PROP antenna height',
    Math.abs(a.y1 - a.y0 - RADIO_PROP.antenna.height) < eps);
  check('antenna offset back-left per RADIO_PROP mount',
    a.x === PLACE.x + RADIO_PROP.antenna.offsetX &&
    a.z === PLACE.z + RADIO_PROP.antenna.offsetZ);
  check('antenna rises from the body top', Math.abs(a.y0 - (PLACE.y + 0.15)) < eps);
}

// --- 4. dial quad ---------------------------------------------------------------
{
  const d = specs[2];
  check('dial sized from RADIO_PROP dial quad',
    d.w === RADIO_PROP.dial.width && Math.abs(d.y1 - d.y0 - RADIO_PROP.dial.height) < eps);
  check('dial centered at dial centerY above the surface',
    Math.abs((d.y0 + d.y1) / 2 - (PLACE.y + RADIO_PROP.dial.centerY)) < eps);
  check('dial sits on the front (+Z) face', d.z > PLACE.z, 'z=' + d.z);
  check('dial is hair-thin', d.d <= 0.006, 'd=' + d.d);
  check('dial carries an amber-packed tint', typeof d.tint === 'number' && d.tint > 0);
  const amber = parseInt(DIAL_COLOR.replace('#', ''), 16);
  const dr = (amber >> 16) & 255, dg = (amber >> 8) & 255, db = amber & 255;
  check('tint channels are scaled amber (never exceed base color)',
    ((d.tint >> 16) & 255) <= dr && ((d.tint >> 8) & 255) <= dg && (d.tint & 255) <= db);
  check('dial is the only emissive part',
    d.emissive !== undefined &&
    specs[0].emissive === undefined && specs[1].emissive === undefined);
}

// --- 5. deterministic glow by hash of seed ---------------------------------------
{
  check('DIAL_GLOW_MIN < DIAL_GLOW_MAX within 0..1',
    0 <= DIAL_GLOW_MIN && DIAL_GLOW_MIN < DIAL_GLOW_MAX && DIAL_GLOW_MAX <= 1);
  const g1 = dialGlowFor(PLACE, 'radio:7:-3');
  const g2 = dialGlowFor(PLACE, 'radio:7:-3');
  check('same seed gives identical glow', g1 === g2);
  check('glow inside [MIN, MAX]', DIAL_GLOW_MIN <= g1 && g1 <= DIAL_GLOW_MAX, 'g=' + g1);

  const distinct = new Set();
  let covered = false;
  for (let cx = 0; cx < 400; cx++) {
    const g = dialGlowFor(PLACE, 'radio:' + cx + ':5');
    distinct.add(Math.round(g * 10000));
    if (g > DIAL_GLOW_MIN + 0.9 * (DIAL_GLOW_MAX - DIAL_GLOW_MIN)) covered = true;
  }
  check('glow varies across seeds (>50 distinct values in 400 draws)',
    distinct.size > 50, 'distinct=' + distinct.size);
  check('some radios glow near max', covered);

  const noSeedA = RadioGeometry.specsFor(PLACE)[2].emissive;
  const noSeedB = RadioGeometry.specsFor({ ...PLACE })[2].emissive;
  check('specs without a seed hash coordinates deterministically', noSeedA === noSeedB);

  const seededSpecs = RadioGeometry.specsFor(PLACE, 'radio:12:9');
  check('seed flows into the dial emissive spec',
    seededSpecs[2].emissive === dialGlowFor(PLACE, 'radio:12:9'));
  check('different seed changes the dial tint',
    seededSpecs[2].tint !== RadioGeometry.specsFor(PLACE)[2].tint);
}

// --- 6. full determinism ----------------------------------------------------------
{
  check('like-for-like repeat call is identical',
    JSON.stringify(RadioGeometry.specsFor(PLACE, 'radio:7:-3')) ===
    JSON.stringify(RadioGeometry.specsFor(PLACE, 'radio:7:-3')));
  check('default-seed repeat call is identical',
    JSON.stringify(RadioGeometry.specsFor(PLACE)) ===
    JSON.stringify(RadioGeometry.specsFor({ ...PLACE })));
}

// --- 7. mesher addBox() argument compatibility --------------------------------------
{
  // The mesher consumes specs via addBox(m, x, z, y0, y1, w, d): center
  // column plus FULL extents and an explicit y range. Verify every spec can
  // feed that call sanely.
  let ok = true;
  for (const s of specs) {
    if (!(Number.isFinite(s.x) && Number.isFinite(s.z))) ok = false;
    if (!(s.y0 < s.y1)) ok = false;
    if (!(s.w > 0 && s.d > 0)) ok = false;
  }
  check('all specs are finite with y0<y1 and positive w/d', ok);
  const [b, a, d] = specs;
  check('antenna footprint fits inside the body footprint',
    Math.abs(a.x - b.x) + ANTENNA_BOX_SIDE / 2 <= b.w / 2 + eps &&
    Math.abs(a.z - b.z) + ANTENNA_BOX_SIDE / 2 <= b.d / 2 + eps);
  check('antenna tops out under 0.55m (desk prop scale)',
    a.y1 - PLACE.y < 0.55, 'top=' + (a.y1 - PLACE.y));
  check('dial never pokes past the body front by more than 1cm',
    d.z - d.d / 2 >= b.z + b.d / 2 - eps && d.z - b.z <= b.d / 2 + 0.01);
}

console.log(failures === 0 ? '\nALL TESTS PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


