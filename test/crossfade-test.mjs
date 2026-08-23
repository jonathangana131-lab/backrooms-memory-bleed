/*
 * BoundaryCrossfade test - runs headless in Node.
 *
 * src/gfx/crossfade.ts only imports ../core/rng and ../world/constants,
 * so we transpile all three with the workspace TypeScript compiler,
 * rewrite the relative specifiers and drive BoundaryCrossfade directly.
 *
 * Verifies:
 *   1. open air far from any boundary stays at exactly 1.0
 *   2. approaching a boundary ahead thickens fog monotonically
 *   3. multiplier never exceeds FOG_PEAK (1.15) even standing on the seam
 *   4. directional gradient: walking away from a seam never thickens;
 *      turning around clears behind immediately
 *   5. deterministic: identical crossings reproduce bit-identical traces
 *   6. relax after crossing: smooth monotone exhale back to 1.0
 *   7. standing still settles back to clear air
 *   8. per-boundary hash character lives inside [FOG_PEAK_MIN, FOG_PEAK]
 *   9. degenerate dt / NaN inputs are safe; diagonals thicken; reset works
 */
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const opts = {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    isolatedModules: true,
  },
};

writeFileSync(join(root, 'test/.crossfade-rng.gen.mjs'),
  ts.transpileModule(readFileSync(join(root, 'src/core/rng.ts'), 'utf8'), opts).outputText);
writeFileSync(join(root, 'test/.crossfade-constants.gen.mjs'),
  ts.transpileModule(readFileSync(join(root, 'src/world/constants.ts'), 'utf8'), opts).outputText);

const mainSrc = ts.transpileModule(
  readFileSync(join(root, 'src/gfx/crossfade.ts'), 'utf8'), opts,
).outputText
  .replace(/from ['"]\.\.\/core\/rng['"]/, 'from "./.crossfade-rng.gen.mjs"')
  .replace(/from ['"]\.\.\/world\/constants['"]/, 'from "./.crossfade-constants.gen.mjs"');
writeFileSync(join(root, 'test/.crossfade-main.gen.mjs'), mainSrc);

const mod = await import('./.crossfade-main.gen.mjs?t=' + Date.now());
const { BoundaryCrossfade, FOG_BAND, FOG_PEAK, FOG_PEAK_MIN } = mod;

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok -', name);
  else { failures++; console.error('FAIL -', name, detail === undefined ? '' : detail); }
}

const CS = 30;          // CHUNK_SIZE (metres)
const SEAM = 60;        // boundary plane x = 60
const DT = 1 / 60;

// --- 1. open air ----------------------------------------------------------
{
  const bc = new BoundaryCrossfade();
  let maxV = 1;
  for (let i = 0; i < 240; i++) {
    maxV = Math.max(maxV, bc.update(DT, 15, 15, 1, 0)); // middle of chunk 0, moving +x
  }
  check('open air far from any boundary holds exactly 1.0', maxV === 1, 'max=' + maxV);
}

// --- 2. approach thickens monotonically -----------------------------------
{
  const bc = new BoundaryCrossfade();
  const samples = [];
  for (let d = FOG_BAND + 1; d > 0.05; d -= 0.25) {
    samples.push(bc.update(DT, SEAM - d, 15, 1, 0));
  }
  let mono = true;
  for (let i = 1; i < samples.length; i++) if (samples[i] < samples[i - 1] - 1e-9) mono = false;
  check('fog thickens monotonically while closing on a seam ahead',
    mono && samples[samples.length - 1] > 1.001, JSON.stringify(samples));
}

// --- 3. peak cap ------------------------------------------------------------
{
  const bc = new BoundaryCrossfade();
  let maxV = 1;
  for (let i = 0; i < 600; i++) {
    const x = SEAM - Math.max(0, 4.9 - i * 0.01);
    maxV = Math.max(maxV, bc.update(DT, x, 15, 1, 0));
  }
  check('multiplier never exceeds FOG_PEAK=1.15 at the seam itself',
    maxV <= FOG_PEAK && maxV > FOG_PEAK_MIN, 'max=' + maxV);
}

// --- 4. directional gradient -------------------------------------------------
{
  const toward = new BoundaryCrossfade();
  const away = new BoundaryCrossfade();
  const tVals = [], aVals = [];
  for (let d = FOG_BAND; d > 0.5; d -= 0.25) {
    tVals.push(toward.update(DT, SEAM - d, 15, 1, 0));
    aVals.push(away.update(DT, SEAM + d, 15, 1, 0));
  }
  const tMax = Math.max.apply(null, tVals), aMax = Math.max.apply(null, aVals);
  check('walking away from a seam behind you never thickens',
    aMax === 1, 'awayMax=' + aMax);
  check('same distance ahead vs behind: only ahead thickens',
    tMax > 1.02 && tMax > aMax, 'towardMax=' + tMax);

  const bc = new BoundaryCrossfade();
  let hot = 1;
  for (let d = FOG_BAND; d > 0.2; d -= 0.25) hot = bc.update(DT, SEAM - d, 15, 1, 0);
  check('walker is deep in the band before reversing', hot > 1.01, 'hot=' + hot);
  let clearedTop = 0;
  for (let i = 0; i < 90; i++) clearedTop = Math.max(clearedTop, bc.update(DT, SEAM - 0.2, 15, -1, 0));
  check('turning around clears the old room immediately', clearedTop < hot,
    'afterReverse=' + clearedTop);
}

// --- 5. determinism -----------------------------------------------------------
{


  function traceX() {
    const bc = new BoundaryCrossfade();
    const out = [];
    for (let x = SEAM - FOG_BAND - 2; x <= SEAM + 3; x += 0.125) {
      out.push(bc.update(DT, x, -47.3, 1, 0));
    }
    return JSON.stringify(out);
  }
  check('the same x-axis crossing reproduces a bit-identical trace',
    traceX() === traceX());

  function traceZ() {
    const bc = new BoundaryCrossfade();
    const out = [];
    for (let z = SEAM - FOG_BAND - 2; z <= SEAM + 3; z += 0.125) {
      out.push(bc.update(DT, 13.7, z, 0, 1));
    }
    return JSON.stringify(out);
  }
  check('z-axis crossings are equally reproducible', traceZ() === traceZ());
}

// --- 6. relax after crossing ----------------------------------------------------
{
  const bc = new BoundaryCrossfade();
  for (let d = FOG_BAND; d > 0.05; d -= 0.125) bc.update(DT, SEAM - d, 15, 1, 0);
  const peak = bc.value();
  const vals = [];
  for (let x = SEAM + 0.05; x < SEAM + 6; x += 0.125) vals.push(bc.update(DT, x, 15, 1, 0));
  const v0 = vals[0], vEnd = vals[vals.length - 1];
  check('after crossing, fog starts relaxing instead of holding',
    vEnd < peak || v0 < peak, 'peak=' + peak + ' v0=' + v0 + ' vEnd=' + vEnd);
  let monoDown = true;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1] + 1e-9) monoDown = false;
  check('relaxation is a smooth monotone exhale (nothing re-thickens behind)',
    monoDown, JSON.stringify(vals));
  for (let i = 0; i < 600; i++) bc.update(DT, SEAM + 20, 15, 1, 0);
  check('air fully settles to 1.0 well past the seam', bc.value() === 1, 'v=' + bc.value());
}

// --- 7. standing still settles -----------------------------------------------------
{
  const bc = new BoundaryCrossfade();
  for (let d = FOG_BAND; d > 0.1; d -= 0.25) bc.update(DT, SEAM - d, 15, 1, 0);
  for (let i = 0; i < 600; i++) bc.update(DT, SEAM - 0.1, 15, 0, 0);
  check('standing still lets the air settle to 1.0', bc.value() === 1, 'v=' + bc.value());
}

// --- 8. hashed per-boundary character -----------------------------------------------
{
  const peaks = [];
  for (let idx = -40; idx <= 40; idx++) {
    const seamX = idx * CS;
    const bc = new BoundaryCrossfade();
    let maxV = 1;
    for (let d = FOG_BAND; d > 0.01; d -= 0.05) {
      // several substeps per position let the attack ease converge,
      // so we measure the seam's settled character, not attack lag
      for (let s = 0; s < 12; s++) {
        maxV = Math.max(maxV, bc.update(DT, seamX - d, 7, 1, 0));
      }
    }
    peaks.push(maxV);
  }
  const okRange = peaks.every((p) => p >= FOG_PEAK_MIN - 1e-6 && p <= FOG_PEAK + 1e-6);
  const distinct = new Set(peaks.map((p) => p.toFixed(4))).size;
  check('all seam peaks live inside [FOG_PEAK_MIN, FOG_PEAK]', okRange,
    JSON.stringify([Math.min.apply(null, peaks), Math.max.apply(null, peaks)]));
  check('individual seams actually differ (hash varies the character)', distinct > 20,
    'distinct=' + distinct);
}

// --- 9. degenerate inputs --------------------------------------------------------------
{
  const bc = new BoundaryCrossfade();
  const r1 = bc.update(0, 29.99, 0, 1, 0);
  const r2 = bc.update(NaN, 29.99, 0, 1, 0);
  const r3 = bc.update(-1, 29.99, 0, 1, 0);
  const r4 = bc.update(DT, NaN, NaN, 1, 0);
  check('dt<=0 / NaN dt / NaN position freeze rather than corrupt',
    r1 === 1 && r2 === 1 && r3 === 1 && r4 === 1,
    JSON.stringify([r1, r2, r3, r4]));

  const diag = new BoundaryCrossfade();
  let diagMax = 1;
  for (let d = FOG_BAND; d > 0.2; d -= 0.25) {
    diagMax = Math.max(diagMax, diag.update(DT, CS - d / Math.SQRT2, CS - d / Math.SQRT2, 1, 1));
  }
  check('diagonal crossings thicken too (corner seam ahead)', diagMax > 1.01,
    'diagMax=' + diagMax);

  const b = new BoundaryCrossfade();
  b.reset();
  check('reset returns the system to clear air', b.value() === 1);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);


