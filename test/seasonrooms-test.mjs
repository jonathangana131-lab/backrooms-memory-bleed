/**
 * Season rooms tests (src/world/seasonrooms.ts, F57).
 * Standalone (no browser): transpiles rng.ts + seasonrooms.ts into a temp
 * dir and drives the model directly, same idiom as mapfragments-test.
 *
 * Acceptance:
 *   1. exactly-one invariant - sessionSeasonBleeds yields exactly one
 *      bleed room over 200 seeds x per-seed landmark universes
 *   2. within-session stability - the elected room and its descriptor are
 *      invariant across repeated calls, call order permutations, and
 *      incremental discovery prefixes that already contain the winner
 *   3. season variety - more than 2 distinct seasons hit over 50 seeds;
 *      assignments vary across seeds
 *   4. determinism - byte-identical assignment JSON per (seed, room set)
 *   5. catalog validity - four frozen descriptors with distinct tints and
 *      in-range particle fields; fail-loud on empty/duplicate ids
 *
 * Run: node test/seasonrooms-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-seasonrooms-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/seasonrooms.ts', 'src/world/seasonrooms.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const sr = await import(pathToFileURL(path.join(tmp, 'src/world/seasonrooms.mjs')).href);

// Landmark-room universe for one seed, mimicking architect.landmarkFor's
// ~1-in-40 chunk gate and LANDMARK_KINDS naming ("cx,cz" key idiom).
function landmarkUniverse(seed, chunks = 400) {
  const ids = [];
  for (let c = 0; c < chunks; c++) {
    if ((Math.imul(c ^ seed ^ 0x14bd, 0x9e3779b1) >>> 0) % 40 === 7) ids.push(c + ',0');
  }
  return ids;
}

// ---- 1. exactly-one invariant over 200 seeds ------------------------------
{
  let ok = true;
  let totalRooms = 0;
  for (let s = 0; s < 200 && ok; s++) {
    const seed = (s * 2654435761) >>> 0;
    const universe = landmarkUniverse(seed);
    totalRooms += universe.length;
    const bleeds = sr.sessionSeasonBleeds(seed, universe);
    if (bleeds.size !== (universe.length === 0 ? 0 : 1)) {
      check(`exactly-one at seed ${seed}`, false, `size=${bleeds.size} rooms=${universe.length}`);
      ok = false;
    }
    if (universe.length > 0 && !bleeds.has(sr.pickBleedRoom(seed, universe))) {
      check(`map/pick agreement at seed ${seed}`, false); ok = false;
    }
  }
  if (ok) check('exactly-one bleed room over 200 seeds (incl. landmark-free seeds)', true,
    `${totalRooms} landmark rooms scanned`);
}

// ---- 2. within-session stability ------------------------------------------
{
  const SEED = 0x57c0e57;
  const universe = landmarkUniverse(SEED);
  const first = sr.sessionSeasonBleeds(SEED, universe);
  let stable = JSON.stringify([...first]) === JSON.stringify([...sr.sessionSeasonBleeds(SEED, universe)]);
  // order permutation must not move the election
  const shuffled = [...universe].reverse();
  stable = stable && JSON.stringify([...first]) === JSON.stringify([...sr.sessionSeasonBleeds(SEED, shuffled)]);
  // incremental discovery: prefix containing the winner keeps it
  const winner = sr.pickBleedRoom(SEED, universe);
  stable = stable && sr.pickBleedRoom(SEED, [winner]) === winner &&
    sr.pickBleedRoom(SEED, universe.slice(0, Math.max(1, universe.indexOf(winner) + 1))) === winner;
  check(`election stable across repeats, permutations, discovery prefixes (winner ${winner})`, stable);

  const desc = first.get(winner);
  const again = sr.sessionSeasonBleeds(SEED, universe).get(winner);
  check('descriptor identical within session', JSON.stringify(desc) === JSON.stringify(again));
}

// ---- 3. season variety across seeds ---------------------------------------
{
  const seasons = new Set();
  const winners = new Set();
  for (let s = 0; s < 50; s++) {
    const seed = (0xa5f00d + s * 40503) >>> 0;
    const universe = landmarkUniverse(seed);
    const w = sr.pickBleedRoom(seed, universe);
    winners.add(w);
    seasons.add(sr.foreignSeason(seed, w));
  }
  check(`>2 distinct seasons over 50 seeds (${[...seasons].join(',')})`, seasons.size > 2);
  check('elections vary across seeds', winners.size > 25, String(winners.size));
  let varies = false;
  const base = sr.foreignSeason(1234, '9,3');
  for (let s = 0; s < 64 && !varies; s++) {
    varies = sr.foreignSeason((1234 + s * 7919) >>> 0, '9,3') !== base ||
      sr.foreignSeason(1234, s + ',3') !== base;
  }
  check('foreign season varies across seeds AND rooms', varies);
}

// ---- 4. determinism --------------------------------------------------------
{
  const snapshot = (seed, universe) =>
    JSON.stringify([...sr.sessionSeasonBleeds(seed, universe)]) +
    '|' + JSON.stringify(sr.seasonCatalog());
  const SEED = 987654321;
  const u = landmarkUniverse(SEED);
  check('byte-identical replay per (seed, room set)',
    snapshot(SEED, u) === snapshot(SEED, [...u].reverse()));
  let differs = false;
  for (let s = 1; s <= 32 && !differs; s++) {
    differs = snapshot(SEED, u) !== snapshot((SEED + s) >>> 0, landmarkUniverse((SEED + s) >>> 0));
  }
  check('assignment differs across nearby seeds', differs);
}

// ---- 5. catalog validity + fail-loud --------------------------------------
{
  const cat = sr.seasonCatalog();
  const ids = sr.SEASON_IDS;
  check('catalog has exactly the four seasons',
    ids.length === 4 && ids.every((id) => cat[id]));
  const tints = new Set(ids.map((id) => cat[id].tint));
  const kinds = new Set(ids.map((id) => cat[id].particle.kind));
  check('tints distinct, packed 24-bit', tints.size === 4 &&
    [...tints].every((t) => Number.isInteger(t) && t >= 0 && t <= 0xffffff));
  check('particle archetypes distinct with sane fields', kinds.size === 4 && ids.every((id) => {
    const p = cat[id].particle;
    return p.densityPerM3 > 0 && Math.abs(p.fallSpeedMps) <= 10 && p.swayHz > 0 &&
      p.rgb >= 0 && p.rgb <= 0xffffff;
  }));
  let frozenThrows = false;
  try { cat.summer.tint = 0; } catch { frozenThrows = true; }
  check('catalog is frozen', frozenThrows);

  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  check('empty room list -> null election, empty bleeds',
    sr.pickBleedRoom(1, []) === null && sr.sessionSeasonBleeds(1, []).size === 0);
  check('empty roomId string throws', threw(() => sr.seasonScore(1, '')));
  check('duplicate roomIds throw',
    threw(() => sr.pickBleedRoom(1, ['3,-2', '3,-2'])));
  check('singleton elects itself',
    sr.pickBleedRoom(42, ['5,5']) === '5,5' && sr.sessionSeasonBleeds(42, ['5,5']).size === 1);
}

console.log(failures === 0 ? 'SEASONROOMS_PASS' : `SEASONROOMS_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
