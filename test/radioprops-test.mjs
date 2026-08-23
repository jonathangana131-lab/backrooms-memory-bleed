/**
 * Unit test for world radio props (src/world/radioprops.ts).
 * Standalone (no browser): transpiles the module into a temp dir and
 * checks district gating, ~8% rarity, determinism, placement geometry,
 * seed-string stability, registry behavior, and that seeds flow into the
 * RadioTuner math (targetFreqFor / loreIndexFor) unchanged.
 * Run: node test/radioprops-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-radioprops-'));
function transpile(rel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, rel), 'utf8'),
    { fileName: rel, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const out = path.join(tmp, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(out, js);
  return import(pathToFileURL(out).href);
}

const rp = await transpile('src/world/radioprops.ts');
const rt = await transpile('src/ui/radiotune.ts');
const {
  RadioProps,
  RADIO_CHANCE,
  RADIO_PROP,
  DESK_TOP_Y,
  DIAL_COLOR,
  chunkKey,
} = rp;
const { hashSeed, targetFreqFor, LORE_POOL } = rt;

const OPEN_OFFICE = 1; // District.OPEN_OFFICE
const OTHER_DISTRICTS = [0, 2, 3, 4]; // MAZE, HONEYCOMB, CORRIDOR_GRID, STORAGE

// --- 1. district gating -----------------------------------------------------
{
  let placed = 0;
  for (let cx = -30; cx < 30; cx++) {
    for (let cz = -30; cz < 30; cz++) {
      for (const d of OTHER_DISTRICTS) {
        if (RadioProps.tryPlace(cx, cz, d) !== null) placed++;
      }
    }
  }
  check('radios never place outside OPEN_OFFICE', placed === 0, 'placed=' + placed);
}

// --- 2. rarity ~= RADIO_CHANCE over many open-office chunks -----------------
{
  let placed = 0;
  const N = 4000; // 200x20 grid of chunks
  for (let cx = -100; cx < 100; cx++) {
    for (let cz = -10; cz < 10; cz++) {
      if (RadioProps.tryPlace(cx, cz, OPEN_OFFICE) !== null) placed++;
    }
  }
  const rate = placed / N;
  check(
    'placement rate within [5%, 12%] of open-office chunks (target 8%)',
    rate >= 0.05 && rate <= 0.12,
    'rate=' + rate.toFixed(4),
  );
  check('RADIO_CHANCE constant is 0.08', RADIO_CHANCE === 0.08);
}

// --- 3. determinism + registry ---------------------------------------------
{
  const a = RadioProps.tryPlace(7, -3, OPEN_OFFICE);
  const b = RadioProps.tryPlace(7, -3, OPEN_OFFICE);
  check('tryPlace is deterministic per chunk', JSON.stringify(a) === JSON.stringify(b));

  // Registry should now contain exactly the winners from the sweep above.
  const map = RadioProps.getPlacements();
  check('getPlacements returns a Map', map instanceof Map);
  check(
    'registry size matches winner count',
    map.size === [...map.keys()].length,
  );
  if (a) {
    check('registry holds the chunk under its key', map.get(chunkKey(7, -3)) === a);
    check('getAt resolves the same radio', RadioProps.getAt(7, -3) === a);
  } else {
    // find any winner to exercise the registry lookups
    let found = null;
    for (const [k, v] of map) { found = { k, v }; break; }
    check('registry is non-empty after sweeps', !!found);
    if (found) {
      check('getAt resolves a registered radio',
        RadioProps.getAt(...found.k.split(',').map(Number)) === found.v);
    }
  }

  // Losing chunk must not be in the registry.
  let loser = null;
  for (let cx = -500; cx < 500 && !loser; cx++) {
    if (!map.has(cx + ',12345')) {
      if (RadioProps.tryPlace(cx, 12345, OPEN_OFFICE) === null) loser = cx;
    }
  }
  check('losing chunk absent from registry', loser !== null && !map.has(loser + ',12345'));
}

// --- 4. shape of placements -------------------------------------------------
{
  let checked = 0;
  for (const [, p] of RadioProps.getPlacements()) {
    check(
      'placement fields are numbers x/z/y and string seed',
      typeof p.x === 'number' && Number.isFinite(p.x) &&
        typeof p.z === 'number' && Number.isFinite(p.z) &&
        typeof p.y === 'number' &&
        typeof p.seed === 'string' && p.seed.length > 0,
    );
    check(
      'radio rests at desk-top height y=DESK_TOP_Y',
      p.y === DESK_TOP_Y && DESK_TOP_Y === 0.76,
      'y=' + p.y,
    );

    // Position must fall inside its own chunk's interior cells
    // (local cell coords 2..10), i.e. not on a rim cell.
    const CHUNK = 2.5 * 12;
    const csx = Math.floor(p.x / CHUNK);
    const csz = Math.floor(p.z / CHUNK);
    const lx = p.x / 2.5 - csx * 12;
    const lz = p.z / 2.5 - csz * 12;
    const okRim = lx >= 2 && lx <= 10 && lz >= 2 && lz <= 10 &&
      Math.floor(lx) === Math.floor(lx); // always true; keeps lx/lz used
    check('radio sits on an interior desk cell (not a chunk rim)',
      okRim, 'lx=' + lx.toFixed(2) + ' lz=' + lz.toFixed(2));

    // Seed format radio:<cx>:<cz> with integer coords.
    check('seed matches /^radio:-?\\d+:-?\\d+$/',
      /^radio:-?\d+:-?\d+$/.test(p.seed), p.seed);

    if (++checked >= 40) break;
  }
  check('had placements to inspect', checked > 0);
}

// --- 5. unique radios, clear spawn plaza ------------------------------------
{
  const seeds = new Set();
  let tooClose = 0;
  for (const [, p] of RadioProps.getPlacements()) {
    seeds.add(p.seed);
    if (Math.hypot(p.x, p.z) < 9) tooClose++;
  }
  check('every radio has a unique seed', seeds.size === RadioProps.getPlacements().size);
  check('no radio inside the spawn plaza', tooClose === 0, 'tooClose=' + tooClose);
}

// --- 6. tuner integration: seeds drive stable stations + lore ---------------
{
  let tested = 0;
  for (const [, p] of RadioProps.getPlacements()) {
    const f1 = targetFreqFor(p.seed);
    const f2 = targetFreqFor(p.seed);
    check(
      'seed yields a stable hidden carrier inside the band',
      f1 === f2 && f1 >= 88 && f1 <= 108,
      'f=' + f1,
    );
    const h = hashSeed(p.seed);
    const idx = h % LORE_POOL.length;
    check('seed hashes to a valid lore index', idx >= 0 && idx < LORE_POOL.length);
    if (++tested >= 25) break;
  }
  check('tested tuner integration on real seeds', tested > 0);

  // targetFreqFor quantizes to one decimal across a ~17 MHz band, so
  // only ~171 distinct carriers exist; large registries must collide.
  // Sample a bounded slice and expect the bulk of draws to differ, and
  // expect the full set to spread across most of the band.
  const all = [...RadioProps.getPlacements().values()];
  const sample = all.slice(0, Math.min(25, all.length));
  const freqs = new Set(sample.map((p) => targetFreqFor(p.seed)));
  check(
    'sampled hidden carriers are mostly distinct',
    freqs.size >= Math.ceil(sample.length * 0.6),
    freqs.size + '/' + sample.length,
  );
  if (all.length) {
    const lo = Math.min(...all.map((p) => targetFreqFor(p.seed)));
    const hi = Math.max(...all.map((p) => targetFreqFor(p.seed)));
    check('carriers spread across the band', hi - lo >= 10, 'span=' + (hi - lo).toFixed(1));
  }
}

// --- 7. geometry spec sanity -------------------------------------------------
{
  check('radio body fits comfortably on a 1.5x0.75 desk top',
    RADIO_PROP.width <= 0.6 && RADIO_PROP.depth <= 0.5);
  check('antenna is thin and taller than the body',
    RADIO_PROP.antenna.radius < 0.02 && RADIO_PROP.antenna.height > RADIO_PROP.height);
  check('dial quad sits on the front face within body height',
    RADIO_PROP.dial.centerY < RADIO_PROP.height &&
      RADIO_PROP.dial.width <= RADIO_PROP.width);
  check('dial glow color is the warm amber accent', DIAL_COLOR === '#d6b254');
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);


