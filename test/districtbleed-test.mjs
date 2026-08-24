/**
 * Unit test for district color bleed (src/gfx/districtbleed.ts, F53).
 * Standalone (no browser): transpiles the module into a temp dir and drives
 * the pure palette/district queries.
 *
 * Acceptance:
 *   1. gradient continuity — across adversarial palettes and deterministic
 *      layouts, every horizontally/vertically adjacent chunk pair differs by
 *      at most MAX_TINT_STEP_DELTA per channel (exhaustive pattern scan)
 *   2. interiors exact — chunks with zero differing 4-neighbours return
 *      their exact palette colour
 *   3. weight symmetry — the difference predicate between two chunks is
 *      mutual; border weights depend only on differing-neighbour counts
 *   4. junk fallback — ordinals missing from the palette and malformed
 *      palette entries resolve to FALLBACK_COLOR (documented)
 *   5. determinism — identical inputs give identical tints across calls
 *
 * Run: node test/districtbleed-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-districtbleed-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/gfx/districtbleed.ts', 'gfx/districtbleed.mjs');

const db = await import(pathToFileURL(path.join(tmp, 'gfx', 'districtbleed.mjs')).href);
const {
  FALLBACK_DISTRICT, FALLBACK_COLOR, BLEED_GAIN, MAX_TINT_STEP_DELTA,
  chunkKey, resolveDistrict, resolveColor, countDifferingNeighbors,
  borderBlendWeight, districtTint, createDistrictBleeder,
} = db;

// Adversarial palettes spanning full channel range.
const PALETTES = [
  { 0: { r: 255, g: 255, b: 255 }, 1: { r: 0, g: 0, b: 0 }, 2: { r: 255, g: 0, b: 0 } },
  { 0: { r: 0, g: 0, b: 0 }, 1: { r: 255, g: 255, b: 255 }, 5: { r: 0, g: 255, b: 0 }, 9: { r: 0, g: 0, b: 255 } },
];

/** Deterministic layouts over a GRID×GRID window. */
const GRID = 8;
function makeLayout(kind) {
  const m = new Map();
  for (let x = -GRID; x <= GRID; x++) {
    for (let z = -GRID; z <= GRID; z++) {
      let d;
      if (kind === 'stripes') d = (x >= 0 ? 0 : 1);
      else if (kind === 'checker') d = ((x + z) % 2 === 0 ? 0 : 1);
      else if (kind === 'islands') d = ((x % 3 === 0 && z % 3 === 0) ? 2 : (x > 0 ? 0 : 1));
      else d = ((x * 7 + z * 13) % 4 < 2 ? 0 : 1); // blobs
      m.set(chunkKey(x, z), d);
    }
  }
  return m;
}
const LAYOUTS = ['stripes', 'checker', 'islands', 'blobs'].map(makeLayout);
LAYOUTS.push(new Map()); // fully unmapped world

/* ------------------------------------------------------------------ */
/* 1. Gradient continuity (adjacent delta ≤ MAX_TINT_STEP_DELTA)       */
/* ------------------------------------------------------------------ */
{
  let worst = 0;
  let worstAt = '';
  for (const palette of PALETTES) {
    for (const districts of LAYOUTS) {
      for (let x = -GRID; x < GRID; x++) {
        for (let z = -GRID; z < GRID; z++) {
          const pairs = [
            [districtTint(palette, districts, x, z), districtTint(palette, districts, x + 1, z)],
            [districtTint(palette, districts, x, z), districtTint(palette, districts, x, z + 1)],
          ];
          for (const [a, b] of pairs) {
            for (const ch of ['r', 'g', 'b']) {
              const delta = Math.abs(a[ch] - b[ch]);
              if (delta > worst) { worst = delta; worstAt = `${x},${z} ${ch}`; }
            }
          }
        }
      }
    }
  }
  check('gradient continuity bound', worst <= MAX_TINT_STEP_DELTA + 1e-9,
    `worst ${worst} at ${worstAt}, bound ${MAX_TINT_STEP_DELTA}`);
  check('bound is non-trivial (stresses exercised)', worst > MAX_TINT_STEP_DELTA / 2,
    `worst only ${worst}`);
  check('constant value exact', MAX_TINT_STEP_DELTA === 255 * (1 - BLEED_GAIN / 2));
}

/* ------------------------------------------------------------------ */
/* 2. Interiors exact                                                  */
/* ------------------------------------------------------------------ */
{
  const palette = PALETTES[0];
  // Two half-planes split at x=2: chunks with x<=0 are interiors of 0,
  // chunks with x>=3 are interiors of 1.
  const districts = new Map();
  for (let x = -4; x <= 4; x++) {
    for (let z = -4; z <= 4; z++) districts.set(chunkKey(x, z), x >= 2 ? 1 : 0);
  }
  const interior = districtTint(palette, districts, 0, 0);
  check('interior exact channels',
    interior.r === 255 && interior.g === 255 && interior.b === 255, JSON.stringify(interior));
  const interiorB = districtTint(palette, districts, 3, 0);
  check('interior other district exact',
    interiorB.r === 0 && interiorB.g === 0 && interiorB.b === 0, JSON.stringify(interiorB));

  // One differing neighbour → exactly own*(1-w)+neighbor*w per channel.
  const stripe = LAYOUTS[0]; // x>=0 → 0, x<0 → 1
  const t = districtTint(palette, stripe, 0, 3); // neighbor (-1,3) differs
  const w = borderBlendWeight(1);
  check('one-neighbor blend exact',
    t.r === 255 + (0 - 255) * w && t.b === t.r,
    JSON.stringify(t) + ` w=${w}`);
  check('weight quarter gain', borderBlendWeight(1) === BLEED_GAIN / 4);
  check('weight full gain', borderBlendWeight(4) === BLEED_GAIN);
  check('weight clamps junk input', borderBlendWeight(99) === BLEED_GAIN &&
    borderBlendWeight(-3) === 0);

  // Bleeder surface agrees with the free function.
  const bleeder = createDistrictBleeder(palette, stripe);
  check('bleeder matches free fn',
    JSON.stringify(bleeder.tintAt(0, 3)) === JSON.stringify(t));
  check('border strength probe',
    bleeder.borderStrengthAt(0, 3) === 1 && bleeder.borderStrengthAt(3, 3) === 0);
  check('isolated chunk sees 4 borders',
    (() => {
      const iso = new Map([[chunkKey(0, 0), 2]]);
      return countDifferingNeighbors(iso, 0, 0) === 4; // unmapped neighbors differ
    })());
}

/* ------------------------------------------------------------------ */
/* 3. Weight symmetry                                                  */
/* ------------------------------------------------------------------ */
{
  let symmetric = true;
  for (const districts of LAYOUTS) {
    for (let x = -GRID; x < GRID; x++) {
      for (let z = -GRID; z < GRID; z++) {
        const aCountsB =
          resolveDistrict(districts, x + 1, z) !== resolveDistrict(districts, x, z);
        const bCountsA =
          resolveDistrict(districts, x, z) !== resolveDistrict(districts, x + 1, z);
        if (aCountsB !== bCountsA) symmetric = false;
        // Mutual visibility implies both are borders together.
        const da = countDifferingNeighbors(districts, x, z) > 0;
        const dbb = countDifferingNeighbors(districts, x + 1, z) > 0;
        if (aCountsB && !(da && dbb)) symmetric = false;
      }
    }
  }
  check('difference predicate symmetric', symmetric);
  check('resolveDistrict fallback constant',
    resolveDistrict(new Map(), 5, -5) === FALLBACK_DISTRICT);
}

/* ------------------------------------------------------------------ */
/* 4. Junk ordinals & malformed palettes                               */
/* ------------------------------------------------------------------ */
{
  check('junk ordinal -> FALLBACK_COLOR',
    JSON.stringify(resolveColor(PALETTES[0], 99)) === JSON.stringify(FALLBACK_COLOR));
  const emptyPalette = {};
  const junkInterior = new Map([
    [chunkKey(0, 0), 42], [chunkKey(1, 0), 42], [chunkKey(-1, 0), 42],
    [chunkKey(0, 1), 42], [chunkKey(0, -1), 42],
  ]);
  const tint = districtTint(emptyPalette, junkInterior, 0, 0);
  check('junk interior renders fallback exactly',
    tint.r === FALLBACK_COLOR.r && tint.g === FALLBACK_COLOR.g && tint.b === FALLBACK_COLOR.b,
    JSON.stringify(tint));

  // Two distinct junk ordinals: border counts, but colours identical → no-op blend.
  const twoJunk = new Map([
    [chunkKey(0, 0), 42], [chunkKey(1, 0), 77], [chunkKey(-1, 0), 42],
    [chunkKey(0, 1), 42], [chunkKey(0, -1), 42],
  ]);
  const j0 = districtTint(emptyPalette, twoJunk, 0, 0);
  check('distinct junk ordinals still border',
    countDifferingNeighbors(twoJunk, 0, 0) === 1);
  check('distinct junk ordinals visually no-op',
    Math.abs(j0.r - FALLBACK_COLOR.r) < 1e-9, JSON.stringify(j0));

  // Malformed palette entries fall back as a whole entry.
  const bad = { 0: { r: NaN, g: 10, b: 10 }, 1: { r: 300, g: 0, b: 0 }, 2: 'nope' };
  check('NaN channel -> fallback', resolveColor(bad, 0).r === FALLBACK_COLOR.r);
  check('out-of-range channel -> fallback', resolveColor(bad, 1).r === FALLBACK_COLOR.r);
  check('non-object entry -> fallback', resolveColor(bad, 2).r === FALLBACK_COLOR.r);
}

/* ------------------------------------------------------------------ */
/* 5. Determinism                                                      */
/* ------------------------------------------------------------------ */
{
  const palette = PALETTES[1];
  const districts = LAYOUTS[2];
  let det = true;
  for (let i = 0; i < 50; i++) {
    const x = (i * 13) % GRID - 4, z = (i * 29) % GRID - 4;
    if (JSON.stringify(districtTint(palette, districts, x, z)) !==
        JSON.stringify(districtTint(palette, districts, x, z))) det = false;
  }
  check('tints deterministic across calls', det);
}

console.log(failures === 0 ? 'DISTRICTBLEED_PASS' : `DISTRICTBLEED_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
