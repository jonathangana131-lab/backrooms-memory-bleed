/*
 * F31 Roach ecosystem tests -- pure Node, no browser.
 * Drives RoachEcosystem against a fixture cell grid and checks:
 *   1. spawning: colonies hatch only on moisture cells, capped
 *   2. migration stability AC: 500-tick runs across 10 seeds -- population
 *      bounded, per-tick |dPop| <= STABILITY_MAX_TICK_DELTA, colonies
 *      actually migrate toward food
 *   3. cabinets: infestation monotone within a session, reset by treatment,
 *      grows again after treatment
 *   4. sessions: plain JSON round-trip restores clock/population/levels;
 *      infestation accumulates across sessions; restored runs replay
 *      deterministically
 *
 * The TS module is bundled with esbuild so its '../core/rng' import
 * resolves under plain Node (same loader as gossip-test).
 */
import { createRequire } from 'node:module';
import { writeFileSync, readdirSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const pnpmDir = process.cwd() + '/node_modules/.pnpm';
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
    if (!entry) throw new Error('esbuild not found in node_modules');
    return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
  }
}
const esbuild = loadEsbuild();
const BUILT = process.cwd() + '/test/.roaches-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/entities/roaches.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);
const R = await import('./.roaches-build.mjs');
const {
  RoachEcosystem, STABILITY_MAX_TICK_DELTA, MAX_COLONY_POP, MOISTURE_SPAWN_MIN,
} = R;

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (!cond) failures.push(name);
}

// ---- fixture grid --------------------------------------------------------------
// Moisture pool centered at origin; food gradient rises gently eastward
// toward the depot at (12, 0, 0) so hungry colonies can climb it stepwise.
function moistureAt(x, y, z) {
  const d = Math.abs(x) + Math.abs(z);
  return Math.max(0, 1 - d * 0.25);
}
function foodAt(x, y, z) {
  const d = Math.abs(x - 12) + Math.abs(z);
  return Math.max(0, 0.95 - d * 0.06);
}
const GRID = { moistureAt, foodAt };

/** Candidate strip: moist spawn cells at origin spreading east toward food. */
function candidates(span) {
  const out = [];
  for (let x = 0; x <= span; x++) {
    for (let z = -1; z <= 1; z++) out.push({ x, y: 0, z });
  }
  return out;
}
function makeDeps(seed, cabinets) {
  return { grid: GRID, cabinets: cabinets ?? [], seed };
}

// ---- 1: spawning ------------------------------------------------------------------
{
  const eco = RoachEcosystem.spawnIn(makeDeps(11), [
    { x: 0, y: 0, z: 0 },   // moisture 1.0 -> spawns
    { x: 4, y: 0, z: 0 },   // moisture 0.0 -> refused
    { x: 1, y: 0, z: 0 },   // moisture 0.75 -> spawns
    { x: 2, y: 0, z: 1 },   // moisture 0.25 -> refused
  ]);
  check('colonies hatch only on moisture >= threshold cells',
    eco.colonies.length === 2 &&
    eco.colonies.every((c) => moistureAt(c.x, c.y, c.z) >= MOISTURE_SPAWN_MIN),
    JSON.stringify(eco.colonies));
  check('spawned populations start small and positive',
    eco.colonies.every((c) => c.population > 0 && c.population < 20));

  const none = RoachEcosystem.spawnIn(makeDeps(11), [{ x: 6, y: 0, z: 0 }]);
  check('dry world spawns nothing', none.colonies.length === 0 && none.totalPopulation === 0);

  // candidate cap: huge moist field still yields <= MAX_COLONIES colonies
  const bigField = RoachEcosystem.spawnIn(
    { grid: { moistureAt: () => 1, foodAt: () => 0.5 }, cabinets: [], seed: 3 },
    Array.from({ length: 60 }, (_, i) => ({ x: i, y: 0, z: 0 })));
  check('colony count hard-capped', bigField.colonies.length === 12, String(bigField.colonies.length));
}

// ---- 2: migration stability AC (500 ticks x 10 seeds) --------------------------------
{
  let allBounded = true;
  let allDeltaBounded = true;
  let worstDelta = 0;
  let anyMigrated = false;
  for (let seed = 1; seed <= 10; seed++) {
    const eco = RoachEcosystem.spawnIn(makeDeps(seed), candidates(14));
    if (eco.colonies.length === 0) continue;
    let prev = eco.totalPopulation;
    for (let t = 0; t < 500; t++) {
      eco.doTick();
      const pop = eco.totalPopulation;
      const delta = Math.abs(pop - prev);
      if (delta > worstDelta) worstDelta = delta;
      if (delta > STABILITY_MAX_TICK_DELTA) allDeltaBounded = false;
      if (pop < 0 || pop > MAX_COLONY_POP * eco.colonies.length) allBounded = false;
      prev = pop;
    }
    anyMigrated = anyMigrated ||
      eco.colonies.some((c) => c.x > 0 && foodAt(c.x, c.y, c.z) > foodAt(0, 0, 0));
    check('seed ' + seed + ': every colony inside its population cap',
      eco.colonies.every((c) => c.population >= 0 && c.population <= MAX_COLONY_POP),
      JSON.stringify(eco.colonies.map((c) => c.population)));
  }
  check('500-tick x 10-seed populations stay in bounds', allBounded);
  check('max per-tick |dPop| <= STABILITY_MAX_TICK_DELTA (no oscillation blowups)',
    allDeltaBounded, 'worst=' + worstDelta + ' cap=' + STABILITY_MAX_TICK_DELTA);
  check('hungry colonies actually migrate toward the food depot', anyMigrated);

  // migration directionality: starting beside the depot ends beside it
  const eco = RoachEcosystem.spawnIn(makeDeps(99), [{ x: 0, y: 0, z: 0 }]);
  for (let t = 0; t < 400; t++) eco.doTick();
  check('colonies converge on food-rich cells (avg food rises vs spawn cell)',
    eco.colonies.reduce((s, c) => s + foodAt(c.x, c.y, c.z), 0) / eco.colonies.length
      > foodAt(0, 0, 0),
    JSON.stringify(eco.colonies.map((c) => [c.x, c.z])));
}

// ---- 3: cabinet infestation monotone + treatment ---------------------------------------
{
  const CAB = [{ id: 'cab-kitchen-1', x: 2, y: 0, z: 0 }];
  const eco = RoachEcosystem.spawnIn(makeDeps(7, CAB), [{ x: 0, y: 0, z: 0 }]);
  let monotone = true;
  let reachedPositive = false;
  let prevLevel = eco.infestationOf('cab-kitchen-1');
  for (let t = 0; t < 300; t++) {
    eco.doTick();
    const level = eco.infestationOf('cab-kitchen-1');
    if (level < prevLevel - 1e-9) monotone = false;
    if (level > 0) reachedPositive = true;
    prevLevel = level;
  }
  check('infestation accrues beside an established colony', reachedPositive,
    String(prevLevel));
  check('within-session infestation is monotone non-decreasing', monotone);
  check('infestation respects its ceiling',
    eco.infestationOf('cab-kitchen-1') <= 100, String(eco.infestationOf('cab-kitchen-1')));

  check('treatment event resets the level to zero', eco.treat('cab-kitchen-1') === true
    && eco.infestationOf('cab-kitchen-1') === 0);
  check('treatment on unknown id is rejected', eco.treat('no-such-cabinet') === false);

  let grewAgain = false;
  for (let t = 0; t < 100 && !grewAgain; t++) {
    eco.doTick();
    if (eco.infestationOf('cab-kitchen-1') > 0) grewAgain = true;
  }
  check('treated cabinet re-infests while the colony stays put', grewAgain);
}

// ---- 4: cross-session JSON round-trip ----------------------------------------------------
{
  const CAB = [{ id: 'cab-bath-2', x: 2, y: 0, z: 0 }];
  const s1 = RoachEcosystem.spawnIn(makeDeps(21, CAB), [{ x: 0, y: 0, z: 0 }]);
  for (let t = 0; t < 200; t++) s1.doTick();
  const saved = JSON.parse(JSON.stringify(s1.serialize())); // strict plain-JSON round trip
  const savedLevel = saved.cabinets[0].infestation;

  const s2 = RoachEcosystem.restore(saved, makeDeps(21, CAB));
  check('restore resumes the tick clock exactly', s2.tick === saved.tick);
  check('restore resumes colony positions and populations',
    JSON.stringify(s2.colonies.map((c) => [c.x, c.y, c.z, c.population])) ===
    JSON.stringify(saved.colonies.map((c) => [c.x, c.y, c.z, c.population])));
  check('restore resumes cabinet infestation levels',
    s2.infestationOf('cab-bath-2') === savedLevel);

  for (let t = 0; t < 200; t++) s2.doTick();
  check('infestation accumulates across sessions beyond the save point',
    s2.infestationOf('cab-bath-2') > savedLevel,
    'saved=' + savedLevel.toFixed(2) + ' now=' + s2.infestationOf('cab-bath-2').toFixed(2));

  // determinism across the seam: identical saves replay identically
  const mid = JSON.parse(JSON.stringify(s2.serialize()));
  const a = RoachEcosystem.restore(mid, makeDeps(21, CAB));
  const b = RoachEcosystem.restore(mid, makeDeps(21, CAB));
  for (let t = 0; t < 120; t++) { a.doTick(); b.doTick(); }
  check('restored ecosystems replay identically (determinism law)',
    JSON.stringify(a.serialize()) === JSON.stringify(b.serialize()));

  // junk save data degrades to a fresh, harmless ecosystem
  const junk = RoachEcosystem.restore({ version: 999 }, makeDeps(21, []));
  check('foreign save version restores as an empty safe state',
    junk.colonies.length === 0 && junk.totalPopulation === 0);
}

console.log(failures.length === 0
  ? '\nALL PASS'
  : '\n' + failures.length + ' FAILURE(S): ' + failures.join(', '));
process.exitCode = failures.length === 0 ? 0 : 1;
