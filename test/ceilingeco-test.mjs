/**
 * Unit test for the ceiling tile ecosystem (src/gfx/ceilingeco.ts, F43).
 * Standalone (no browser): transpiles the module into a temp dir and drives
 * the ledger + band mapping with injected per-chunk tile state.
 *
 * Acceptance:
 *   1. persistence — removals accumulate monotonically per chunk key across
 *      a JSON round-trip (cross-session), exact totals after reload
 *   2. monotonicity — no call sequence can decrease a chunk's total or its
 *      skitter intensity
 *   3. band mapping exactness — promotions land exactly at each threshold,
 *      intensities are exactly the band values, monotone, saturating
 *   4. determinism — pure functions return identical values across
 *      instances; malformed save JSON fails loud
 *
 * Run: node test/ceilingeco-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-ceilingeco-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/gfx/ceilingeco.ts', 'gfx/ceilingeco.mjs');

const eco = await import(pathToFileURL(path.join(tmp, 'gfx', 'ceilingeco.mjs')).href);
const { CeilingTileLedger, skitterIntensity, skitterBandIndex, SKITTER_BANDS } = eco;

/* ------------------------------------------------------------------ */
/* 1. Persistence: cross-session accumulate                            */
/* ------------------------------------------------------------------ */
{
  const s1 = new CeilingTileLedger();
  s1.recordRemoval('3,-2');        // 1
  s1.recordRemoval('3,-2');        // 2
  for (let i = 0; i < 5; i++) s1.recordRemoval('10,4'); // 5

  const json = s1.toJSON();
  const s2 = CeilingTileLedger.fromJSON(json); // new session
  const t1 = s2.removalCount('3,-2');
  const t2 = s2.removalCount('10,4');
  check('totals survive JSON round-trip exactly',
    t1 === 2 && t2 === 5 && s2.size === 2, `got ${t1}/${t2} size=${s2.size}`);

  s2.recordRemoval('3,-2'); // continues accumulating in the new session
  const resumed = s2.removalCount('3,-2');
  const json2 = s2.toJSON();
  const s3 = CeilingTileLedger.fromJSON(json2);
  check('accumulation continues monotonically across sessions',
    resumed === 3 && s3.removalCount('3,-2') === 3 && s3.removalCount('10,4') === 5,
    `resumed=${resumed} s3=${s3.removalCount('3,-2')}`);

  // untouched chunk stays at zero through every session boundary
  check('unrecorded chunk reads zero in every session',
    s1.removalCount('99,99') === 0 && s3.removalCount('99,99') === 0);

  let threw = false;
  try { CeilingTileLedger.fromJSON('{"formatVersion":9,"removals":[]}'); } catch { threw = true; }
  check('wrong envelope version fails loud', threw);
  threw = false;
  try { CeilingTileLedger.fromJSON('{"formatVersion":1,"removals":[["k","x"]]}'); } catch { threw = true; }
  check('malformed entry fails loud', threw);
}

/* ------------------------------------------------------------------ */
/* 2. Monotonicity                                                     */
/* ------------------------------------------------------------------ */
{
  const led = new CeilingTileLedger();
  led.recordRemoval('7,7', 10);
  const before = led.removalCount('7,7');

  led.recordRemoval('7,7', -5);   // negative is a no-op
  led.recordRemoval('7,7', 0);    // zero is a no-op
  led.recordRemoval('7,7', 2.7);  // fractional floors to a whole tile
  check('negative/zero inputs never decrease total',
    led.removalCount('7,7') >= before,
    `${before} -> ${led.removalCount('7,7')}`);
  check('fractional counts floor to whole tiles', led.removalCount('7,7') === 12);

  // intensity can only rise as removals accumulate (maxTiles fixed)
  const maxTiles = 20;
  let mono = true;
  let prev = -1;
  const led2 = new CeilingTileLedger();
  for (let i = 0; i <= maxTiles * 2; i++) {
    led2.recordRemoval('m,m');
    const v = led2.skitterOf('m,m', maxTiles);
    if (v < prev) mono = false;
    prev = v;
  }
  check('skitter intensity monotone non-decreasing while tiles accumulate', mono);
}

/* ------------------------------------------------------------------ */
/* 3. Band mapping exactness                                           */
/* ------------------------------------------------------------------ */
{
  const maxTiles = 40;
  const at = (missing) => skitterIntensity({ missingCount: missing, maxTiles });
  const bandAt = (missing) => skitterBandIndex({ missingCount: missing, maxTiles });

  // boundaries derived FROM SKITTER_BANDS so the test cannot drift from data:
  // fraction f = m/40 promotes exactly at m = minFraction*40.
  const th = SKITTER_BANDS.map((b) => b.minFraction);
  const exact =
    at(0) === 0 &&
    at(Math.ceil(th[1] * maxTiles - 1)) === SKITTER_BANDS[0].intensity &&
    at(th[1] * maxTiles) === SKITTER_BANDS[1].intensity &&
    at(th[2] * maxTiles) === SKITTER_BANDS[2].intensity &&
    at(th[3] * maxTiles) === SKITTER_BANDS[3].intensity &&
    at(maxTiles * 3) === SKITTER_BANDS[3].intensity;
  check('band promotions exact at each fraction threshold', exact,
    `0:${at(0)} pre:${at(3)} b1:${at(4)} b2:${at(10)} b3:${at(20)} sat:${at(120)}`);

  check('intensity inside a band equals the band value exactly',
    at(15) === SKITTER_BANDS[2].intensity && at(19) === SKITTER_BANDS[2].intensity);

  check('band index saturates beyond full removal',
    bandAt(maxTiles) === SKITTER_BANDS.length - 1 &&
    skitterBandIndex({ missingCount: 100000, maxTiles }) === SKITTER_BANDS.length - 1);

  check('fully intact ceiling is silent',
    at(0) === 0 && skitterIntensity({ missingCount: 0, maxTiles: 40 }) === 0);

  let mono = true;
  let prev = -1;
  for (let m = 0; m <= maxTiles * 3; m++) {
    const v = at(m);
    if (v < prev || !Number.isFinite(v)) mono = false;
    prev = v;
  }
  check('band intensity monotone non-decreasing over all counts', mono);

  check('thresholds strictly ascending with distinct intensities',
    th.every((v, i) => i === 0 || v > th[i - 1]) &&
    new Set(SKITTER_BANDS.map((b) => b.intensity)).size === SKITTER_BANDS.length);

  let threw = false;
  try { skitterBandIndex({ missingCount: 1, maxTiles: 0 }); } catch { threw = true; }
  check('degenerate maxTiles fails loud', threw);
}

/* ------------------------------------------------------------------ */
/* 4. Determinism                                                      */
/* ------------------------------------------------------------------ */
{
  const state = { missingCount: 11, maxTiles: 40 };
  const a = [skitterIntensity(state), skitterBandIndex(state)];
  const b = [skitterIntensity({ ...state }), skitterBandIndex({ ...state })];
  check('band mapping identical across calls and instances',
    a[0] === b[0] && a[1] === b[1], `${a} vs ${b}`);

  const l1 = new CeilingTileLedger();
  const l2 = new CeilingTileLedger();
  for (let i = 0; i < 7; i++) { l1.recordRemoval('d,d'); l2.recordRemoval('d,d'); }
  check('independent ledgers converge to identical serialized state',
    l1.toJSON() === l2.toJSON());
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? 'CEILINGECO_PASS' : `CEILINGECO_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
