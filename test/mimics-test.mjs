/*
 * F28 Mimic props tests -- pure Node, no browser.
 * Drives MimicProps against scripted observation providers and checks:
 *   1. freeze iff observed: across gaze on/off toggles the mimic moves
 *      exactly on unobserved ticks and never on observed ones
 *   2. approach speed cap: per-tick displacement while creeping never
 *      exceeds CREEP_SPEED * dt
 *   3. frustum+LOS visibility: within reveal proximity in direct view it
 *      freezes and latches its true-nature flag; outside that range a
 *      direct view alone neither freezes nor reveals
 *   4. gaze hold: rest shorter than GAZE_HOLD_SECONDS reveals nothing;
 *      reaching the threshold latches the flag, which never unlatches
 *   5. determinism per seed: identical seed + script replays identical
 *      trajectories; different seeds diverge
 *
 * The TS module is bundled with esbuild so its '../core/rng' and
 * '../world/collision' imports resolve under plain Node (same loader as
 * roaches-test).
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
const BUILT = process.cwd() + '/test/.mimics-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/entities/mimics.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);
const {
  MimicProps, CREEP_SPEED, GAZE_HOLD_SECONDS, REVEAL_PROXIMITY_METRES,
} = await import('./.mimics-build.mjs');

const failures = [];
let passed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (cond) passed++; else failures.push(name);
}

// ---- 1: freeze iff observed across gaze toggles -----------------------------------
{
  const DT = 1 / 60;
  // alternating script with irregular runs: T T F F F T F T T F ...
  const script = [];
  for (let i = 0; i < 600; i++) {
    script.push((i % 7 === 0 || i % 7 === 1 || i % 7 === 3 || i % 7 === 6));
  }
  const m = new MimicProps({
    props: [{ id: 'sofa', x: -12, z: -4 }],
    seed: 555,
    gazeRestingOn: (_x, _z) => script[tick],
  });
  let tick = 0;
  let okFreeze = true;
  let okMovesWhenBlind = true;
  let movesSeen = 0;
  let lx = m.mimics[0].x, lz = m.mimics[0].z;
  for (; tick < script.length; tick++) {
    // player stands far away so the mimic is always still creeping when blind
    m.update(DT, -30, 20);
    const d = Math.hypot(m.mimics[0].x - lx, m.mimics[0].z - lz);
    if (script[tick]) {
      if (d > 0) okFreeze = false; // moved while observed
    } else if (d > 0) movesSeen++;
    if (!script[tick] && d <= 0 && tick > GAZE_HOLD_SECONDS / DT) okMovesWhenBlind = false;
    lx = m.mimics[0].x; lz = m.mimics[0].z;
  }
  check('freeze iff observed: zero movement on every observed tick', okFreeze);
  check('unobserved ticks keep creeping (moves seen: ' + movesSeen + ')', movesSeen > 100);
  check('blind ticks always produce motion until arrival', okMovesWhenBlind);
}

// ---- 2: approach speed cap ---------------------------------------------------------
{
  const DT = 1 / 60;
  const m = new MimicProps({
    props: [{ id: 'crate', x: 10, z: 10 }, { id: 'locker', x: -9, z: 14 }],
    seed: 31337,
  });
  let maxSpeed = 0;
  for (let t = 0; t < 60 * 300; t++) {
    // wandering player path so creeps chase across open floor
    const px = Math.cos(t * DT * 0.5) * 6;
    const pz = Math.sin(t * DT * 0.37) * 8;
    const bx = m.mimics.map((mm) => ({ x: mm.x, z: mm.z }));
    m.update(DT, px, pz);
    for (let i = 0; i < m.mimics.length; i++) {
      const v = Math.hypot(m.mimics[i].x - bx[i].x, m.mimics[i].z - bx[i].z) / DT;
      maxSpeed = Math.max(maxSpeed, v);
    }
  }
  check('creep speed cap respected (' + maxSpeed.toFixed(4) + ' <= ' + CREEP_SPEED + ')',
    maxSpeed <= CREEP_SPEED + 1e-9);
}

// ---- 3: direct-view proximity reveal + freeze ---------------------------------------
{
  const DT = 1 / 60;
  const m = new MimicProps({
    props: [{ id: 'desk', x: 0, z: 0 }],
    seed: 9,
    directViewOf: () => true, // camera looks straight at it the whole time
  });
  // start the player just outside reveal range; LOS visible but too far
  let px = 0, pz = REVEAL_PROXIMITY_METRES + 2;
  let revealedOutsideRange = false;
  let enteredRange = false;
  let movedInsideRange = false;
  let lx = 0, lz = 0;
  for (let t = 0; t < 60 * 120; t++) {
    m.update(DT, px, pz);
    const d = Math.hypot(m.mimics[0].x - px, m.mimics[0].z - pz);
    if (d > REVEAL_PROXIMITY_METRES) {
      if (m.mimics[0].revealed) revealedOutsideRange = true;
    } else {
      if (!enteredRange) { enteredRange = true; lx = m.mimics[0].x; lz = m.mimics[0].z; }
      else {
        if (Math.hypot(m.mimics[0].x - lx, m.mimics[0].z - lz) > 0) movedInsideRange = true;
        lx = m.mimics[0].x; lz = m.mimics[0].z;
      }
    }
  }
  check('direct view beyond proximity range does not reveal early', !revealedOutsideRange);
  check('close direct view latches the true-nature flag', m.mimics[0].revealed);
  check('no movement once within reveal range in direct view', enteredRange && !movedInsideRange);

  // direct view WITHOUT proximity must not freeze a distant mimic
  const far = new MimicProps({
    props: [{ id: 'bed', x: 40, z: 40 }],
    seed: 10,
    directViewOf: () => true,
  });
  far.update(DT, 0, 0);
  const fx = far.mimics[0].x, fz = far.mimics[0].z;
  far.update(DT, 0, 0);
  check('distant in-frustum mimic still creeps (visibility alone is not proximity)',
    Math.hypot(far.mimics[0].x - fx, far.mimics[0].z - fz) > 0);
}

// ---- 4: gaze hold reveal + latch ----------------------------------------------------
{
  const DT = 1 / 60;
  let gazing = false;
  const m = new MimicProps({
    props: [{ id: 'gurney', x: 5, z: 5 }],
    seed: 21,
    gazeRestingOn: () => gazing,
  });
  // player stands close enough that creep would be visible if it moved
  const px = 6.5, pz = 6.5;
  const holdTicks = Math.ceil(GAZE_HOLD_SECONDS / DT);
  for (let t = 0; t < holdTicks - 3; t++) { gazing = true; m.update(DT, px, pz); }
  check('gaze under the threshold does not expose the mimic', !m.mimics[0].revealed);
  gazing = true;
  m.update(DT, px, pz); m.update(DT, px, pz); m.update(DT, px, pz); // 72 ticks = 1.2 s
  check('reaching GAZE_HOLD_SECONDS exposes the mimic', m.mimics[0].revealed,
    'held ' + m.mimics[0].gazeHeldSec.toFixed(4) + 's');
  gazing = false;
  for (let t = 0; t < 60 * 5; t++) m.update(DT, 60, 60); // walk far away
  check('true-nature flag never unlatches', m.isRevealed('gurney') === true);
  check('unknown id reads as unrevealed', m.isRevealed('nope') === false);
}

// ---- 5: determinism per seed --------------------------------------------------------
{
  function replay(seed) {
    let gazing = false;
    const m = new MimicProps({
      props: [{ id: 'a', x: 15, z: -3 }, { id: 'b', x: -11, z: 8 }, { id: 'c', x: 2, z: 22 }],
      seed,
      gazeRestingOn: () => gazing,
    });
    const trace = [];
    for (let t = 0; t < 60 * 240; t++) {
      gazing = t % 23 < 9;
      m.update(1 / 60, Math.sin(t * 0.01) * 4, Math.cos(t * 0.013) * 5);
      trace.push(m.mimics.map((mm) => mm.x.toFixed(5) + ',' + mm.z.toFixed(5)).join('|'));
    }
    return trace.join(';');
  }
  const t1 = replay(8080);
  const t2 = replay(8080);
  const t3 = replay(4711);
  check('identical seed replays byte-identical trajectories', t1 === t2);
  check('different seed produces different wobble trajectories', t1 !== t3);
}

console.log('\nMIMICS: ' + passed + ' checks passed, ' + failures.length + ' failed');
if (failures.length > 0) {
  console.log('FAILED: ' + failures.join(' | '));
  process.exit(1);
}
