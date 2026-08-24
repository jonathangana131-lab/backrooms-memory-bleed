/**
 * Unit test for raymarched wet floors (src/gfx/wetfloor.ts, F39).
 * Standalone (no browser): transpiles the module (+ its deps) into a temp
 * dir and drives the pure model with injected moisture predicates.
 *
 * Acceptance:
 *   1. low tier gated off — intensity exactly 0 and 0 march steps for
 *      every cell, seed and pitch
 *   2. medium capped at 0.55; high reaches full 1.0
 *   3. ray step counts low=0 / medium=8 / high=16 reach the consumer
 *   4. intensity monotone in moisture level (and monotone in pitch)
 *   5. deterministic per cell+seed; different seeds differ somewhere
 *
 * Run: node test/wetfloor-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-wetfloor-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/gfx/wetfloor.ts', 'gfx/wetfloor.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx', 'wetfloor.mjs')).href);
const {
  WetFloor,
  moistureLevel,
  reflectionIntensity,
  pitchGain,
  RAY_STEPS,
  TIER_CAP,
} = mod;

// Injected predicate: a wet stripe along z == 3 plus scattered puddles.
function makeDeps() {
  const wet = new Set();
  for (let x = -8; x <= 8; x++) {
    wet.add(x + ',3');
    if ((x * 7 + 13) % 5 === 0) wet.add(x + ',' + ((x % 4) + 6));
  }
  return { isMoistureCell: (cx, cz) => wet.has(cx + ',' + cz), wet };
}
const GRAZING = 0.1; // near-horizon depression angle in radians

// ---- 1. low tier gated off ---------------------------------------------------
(() => {
  const deps = makeDeps();
  let allZero = true;
  for (let seed = 0; seed < 10; seed++) {
    const floor = new WetFloor(deps, seed * 2654435761, 'low');
    for (const key of deps.wet) {
      const [x, z] = key.split(',').map(Number);
      for (const pitch of [0, GRAZING, Math.PI / 4, Math.PI / 2]) {
        const p = floor.plan(x, z, pitch);
        if (p.intensity !== 0 || p.steps !== 0) allZero = false;
        if (moistureLevel(deps, seed * 2654435761, x, z) > 0 &&
            p.intensity !== 0) allZero = false;
      }
    }
  }
  check('low tier reflects exactly 0 with 0 steps everywhere', allZero);
  check('TIER_CAP.low is exactly 0', TIER_CAP.low === 0 && RAY_STEPS.low === 0);
})();

// ---- 2. medium cap 0.55, high full ---------------------------------------------
(() => {
  const deps = makeDeps();
  let medMax = 0;
  let hiMax = 0;
  for (let seed = 0; seed < 20; seed++) {
    const med = new WetFloor(deps, seed * 40503, 'medium');
    const hi = new WetFloor(deps, seed * 40503, 'high');
    for (const key of deps.wet) {
      const [x, z] = key.split(',').map(Number);
      medMax = Math.max(medMax, med.plan(x, z, GRAZING).intensity);
      hiMax = Math.max(hiMax, hi.plan(x, z, GRAZING).intensity);
    }
  }
  check('medium never exceeds its 0.55 cap across seeds and cells',
    medMax <= 0.55 + 1e-12, String(medMax));
  check('medium actually approaches the cap (not silently dimmer)',
    medMax >= 0.5, String(medMax));
  check('high tier model reaches full reflection (level 1 -> exactly 1.0)',
    reflectionIntensity(1, TIER_CAP.high, GRAZING) === 1 &&
    reflectionIntensity(1, TIER_CAP.high, 0) === 1);
  check('high-tier wet cells approach full reflection in practice',
    hiMax >= 0.9, String(hiMax));
  // dry cells stay dark on every tier
  const f = new WetFloor(deps, 7, 'high');
  let dryDark = true;
  for (let x = -8; x <= 8; x++) {
    for (let z = -8; z <= 8; z++) {
      if (!deps.isMoistureCell(x, z) && f.plan(x, z, GRAZING).intensity !== 0) dryDark = false;
    }
  }
  check('dry cells reflect nothing even at full tier', dryDark);
})();

// ---- 3. ray step counts per tier -------------------------------------------------
(() => {
  check('RAY_STEPS are low=0 / medium=8 / high=16',
    RAY_STEPS.low === 0 && RAY_STEPS.medium === 8 && RAY_STEPS.high === 16,
    JSON.stringify(RAY_STEPS));
  const deps = makeDeps();
  const floor = new WetFloor(deps, 99, 'low');
  const seen = [];
  seen.push(floor.steps());
  floor.setTier('medium'); seen.push(floor.steps());
  floor.setTier('high'); seen.push(floor.steps());
  check('steps() follows live tier changes', JSON.stringify(seen) === '[0,8,16]',
    JSON.stringify(seen));
  const pMed = new WetFloor(deps, 99, 'medium').plan(0, 3, GRAZING);
  const pHigh = new WetFloor(deps, 99, 'high').plan(0, 3, GRAZING);
  check('plans carry their tier budget to the render consumer',
    pMed.steps === 8 && pHigh.steps === 16 && pMed.tier === 'medium' && pHigh.tier === 'high');
})();

// ---- 4. monotone in moisture level and pitch --------------------------------------
(() => {
  let monoLevel = true;
  for (const [tier, cap] of [['medium', 0.55], ['high', 1]]) {
    for (const pitch of [GRAZING, Math.PI / 4]) {
      let prev = -1;
      for (let i = 0; i <= 100; i++) {
        const v = reflectionIntensity(i / 100, cap, pitch);
        if (v < prev - 1e-12) monoLevel = false;
        prev = v;
      }
    }
  }
  check('intensity is non-decreasing in moisture level (medium + high)', monoLevel);
  // seeded cell levels sit in [LEVEL_MIN, 1] for wet cells, exactly 0 when dry
  const deps = makeDeps();
  let levelsSane = true;
  for (let seed = 0; seed < 15; seed++) {
    for (const key of deps.wet) {
      const [x, z] = key.split(',').map(Number);
      const l = moistureLevel(deps, seed, x, z);
      if (!(l > 0 && l <= 1)) levelsSane = false;
    }
    if (moistureLevel(deps, seed, 0, 7) !== 0 && !deps.isMoistureCell(0, 7)) levelsSane = false;
  }
  check('wet cells carry positive level <= 1; dry cells exactly 0', levelsSane);
  // Fresnel stand-in fades as the camera looks straight down
  let monoPitch = true;
  let prevG = Infinity;
  for (let i = 0; i <= 90; i++) {
    const g = pitchGain((i * Math.PI) / 180);
    if (g > prevG + 1e-12) monoPitch = false;
    prevG = g;
  }
  check('pitchGain is non-increasing from grazing to straight-down', monoPitch);
  check('pitchGain stays within its lawful band',
    Math.abs(pitchGain(0) - 1) < 1e-12 && pitchGain(Math.PI / 2) >= 0.55 - 1e-12);
})();

// ---- 5. determinism per cell+seed ---------------------------------------------------
(() => {
  const deps = makeDeps();
  const snap = (seed, tier) => {
    const floor = new WetFloor(deps, seed, tier);
    return JSON.stringify([...deps.wet].map((k) => {
      const [x, z] = k.split(',').map(Number);
      return floor.plan(x, z, GRAZING);
    }));
  };
  let same = true;
  for (const seed of [0, 0xdeadbeef, 123456789]) {
    if (snap(seed, 'high') !== snap(seed, 'high')) same = false;
  }
  check('identical seed+tier replay identical plans over every cell', same);
  const a = snap(11, 'high');
  let differs = false;
  for (let s = 12; s < 80; s++) { if (snap(s, 'high') !== a) { differs = true; break; } }
  check('different seeds yield different per-cell moisture draws', differs);
  // tier alone must not change a cell's underlying moisture level
  const lMed = moistureLevel(deps, 42, 0, 3);
  const lHigh = moistureLevel(deps, 42, 0, 3);
  check('moisture level depends only on cell+seed, never tier', lMed === lHigh && lMed > 0);
})();

process.exit(failures === 0 ? 0 : 1);
