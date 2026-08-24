/*
 * F26 The Archivist -- pure Node, no browser.
 * Drives the Archivist sim against an injected landmark list, memory
 * store, and player script and checks:
 *   1. reaction table: photo-count bands map to shy / curious / receptive
 *      exactly at the boundaries
 *   2. cross-session persistence: photographs land in the injected store
 *      under the run id, survive a plain JSON round-trip, and a NEXT
 *      session constructed against prior run ids comes back with the
 *      matching tier
 *   3. stand-off invariant under pursuit: a sprint-speed player charging
 *      the Archivist head-on can never close inside its stand-off ring,
 *      across seeds and all three tiers, with and without wall boxes
 *   4. never-approaches: a stationary player is never approached closer
 *      than the stand-off ring while the Archivist circuits landmarks
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
const BUILT = process.cwd() + '/test/.archivist-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/entities/archivist.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);
const {
  Archivist, reactionForPhotos, MOOD_STANDOFF_SCALE,
  ARCHIVIST_STORE_PREFIX, RETREAT_SPEED,
} = await import('./.archivist-build.mjs');

const failures = [];
let passed = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (cond) passed++; else failures.push(name);
}

// ---- fixtures -----------------------------------------------------------------

class MemoryStore {
  constructor() { this.map = new Map(); }
  get(k) { return this.map.get(k); }
  set(k, v) { this.map.set(k, v); }
}

const LANDMARKS = [
  { x: 0, z: 0 }, { x: 18, z: 4 }, { x: 26, z: -12 },
  { x: 8, z: -22 }, { x: -14, z: -10 },
];
/** Wall boxes that force sliding during retreat (never enclosing). */
const BOXES = [
  { minX: 5, minZ: -40, maxX: 7, maxZ: 40 },
  { minX: -40, minZ: 8, maxX: 40, maxZ: 10 },
];

// ---- 1: reaction table ----------------------------------------------------------
{
  const cases = [
    [0, 'shy'], [-5, 'shy'],
    [1, 'curious'], [2, 'curious'], [3, 'curious'],
    [4, 'receptive'], [5, 'receptive'], [99, 'receptive'],
    // fractional photo counts are impossible; floor behavior documented anyway
    [3.9, 'curious'],
  ];
  let ok = true;
  for (const [n, want] of cases) {
    const got = reactionForPhotos(n);
    if (got !== want) { ok = false; console.log('  band mismatch:', n, '->', got, 'want', want); }
  }
  check('reaction table maps photo-count bands to shy/curious/receptive', ok);
  const order = MOOD_STANDOFF_SCALE.shy > MOOD_STANDOFF_SCALE.curious
    && MOOD_STANDOFF_SCALE.curious > MOOD_STANDOFF_SCALE.receptive;
  check('stand-off scale shrinks monotonically shy > curious > receptive', order);
}

// ---- 2: cross-session persistence -------------------------------------------------
{
  const store = new MemoryStore();
  // session A: three photographs under run r1
  const a = new Archivist({ landmarks: LANDMARKS, store, runId: 'r1', seed: 101 });
  check('fresh run with no history starts shy', a.mood === 'shy');
  a.photograph(); a.photograph();
  const afterTwo = a.photograph();
  check('photograph() returns this-run tally', afterTwo === 3, 'got ' + afterTwo);
  check('photosThisRun tracks session tally', a.photosThisRun === 3);

  // plain-JSON round-trip through the persisted value
  const raw = JSON.parse(JSON.stringify(store.map.get(ARCHIVIST_STORE_PREFIX + 'r1')));
  check('encounter record survives plain JSON round-trip', raw && raw.photos === 3 && raw.tier === 'curious',
    JSON.stringify(raw));

  // session B: new run id, reads prior runs -> curious at 3 prior photos
  const b = new Archivist({
    landmarks: LANDMARKS, store, runId: 'r2', priorRunIds: ['r1'], seed: 202,
  });
  check('next session reads prior encounters: 3 photos -> curious', b.mood === 'curious'
    && b.priorPhotos === 3, b.mood + '/' + b.priorPhotos);
  b.photograph();

  // session C: both priors -> 4 photos -> receptive
  const c = new Archivist({
    landmarks: LANDMARKS, store, runId: 'r3', priorRunIds: ['r1', 'r2'], seed: 303,
  });
  check('session C sums priors: 4 photos -> receptive', c.mood === 'receptive' && c.priorPhotos === 4,
    c.mood + '/' + c.priorPhotos);

  // resuming the SAME run id restores its own tally instead of double counting;
  // mood reflects the combined band (3 prior + 1 own -> receptive)
  const b2 = new Archivist({
    landmarks: LANDMARKS, store, runId: 'r2', priorRunIds: ['r1'], seed: 202,
  });
  check('same run id resume restores own tally without double count',
    b2.photosThisRun === 1 && b2.mood === 'receptive' && b2.priorPhotos === 3,
    b2.photosThisRun + '/' + b2.mood + '/' + b2.priorPhotos);
}

// ---- 3: stand-off invariant under pursuit -----------------------------------------
{
  const DT = 1 / 60;
  const SPRINT = 4.4; // player sprint speed; retreat speed must beat it
  check('retreat speed exceeds player sprint (invariant premise)', RETREAT_SPEED > SPRINT);

  let allHold = true;
  let sawRetreatMotion = true;
  for (const seed of [7, 88, 12345]) {
    for (const priorPhotos of [0, 2, 6]) {
      const st = new MemoryStore();
      st.set(ARCHIVIST_STORE_PREFIX + 'q', { version: 1, photos: priorPhotos, tier: 'curious' });
      const a2 = new Archivist({ landmarks: LANDMARKS, store: st, runId: 'p', priorRunIds: ['q'], seed });
      const standoff = a2.standoff;
      // player charges head-on from 30 m out at sprint speed, forever
      let px = a2.body.x + 30, pz = a2.body.z;
      let minD = Infinity;
      let movedTotal = 0;
      const bx = a2.body.x, bz = a2.body.z;
      for (let t = 0; t < 60 * 90; t++) {
        const dx = a2.body.x - px, dz = a2.body.z - pz;
        const d = Math.hypot(dx, dz) || 1e-9;
        px += (dx / d) * SPRINT * DT;
        pz += (dz / d) * SPRINT * DT;
        a2.update(DT, px, pz, []);
        minD = Math.min(minD, Math.hypot(a2.body.x - px, a2.body.z - pz));
        movedTotal += Math.hypot(a2.body.x - bx, a2.body.z - bz);
      }
      if (!(minD >= standoff - 1e-4)) {
        allHold = false;
        console.log('  pursuit breach: seed', seed, 'photos', priorPhotos, 'minD', minD.toFixed(4),
          'standoff', standoff.toFixed(3));
      }
      if (movedTotal <= 0) sawRetreatMotion = false;
    }
  }
  check('stand-off invariant holds under sprint pursuit across seeds x tiers', allHold);
  check('archivist actively retreats (not frozen in place)', sawRetreatMotion);

  // same pursuit against wall boxes: sliding must not break the ring
  let holdWithWalls = true;
  {
    const a = new Archivist({ landmarks: LANDMARKS, store: new MemoryStore(), runId: 'w', seed: 42 });
    let px = a.body.x + 30, pz = a.body.z - 25;
    for (let t = 0; t < 60 * 120; t++) {
      const dx = a.body.x - px, dz = a.body.z - pz;
      const d = Math.hypot(dx, dz) || 1e-9;
      px += (dx / d) * SPRINT * DT;
      pz += (dz / d) * SPRINT * DT;
      a.update(DT, px, pz, BOXES);
      const dd = Math.hypot(a.body.x - px, a.body.z - pz);
      if (dd < a.standoff - 1e-3) { holdWithWalls = false; break; }
    }
  }
  check('stand-off invariant holds under pursuit among wall boxes', holdWithWalls);
}

// ---- 4: never approaches a stationary player --------------------------------------
{
  let ok = true;
  for (const seed of [3, 77]) {
    const a = new Archivist({ landmarks: LANDMARKS, store: new MemoryStore(), runId: 's', seed });
    const px = LANDMARKS[2].x, pz = LANDMARKS[2].z; // camped on a landmark room
    for (let t = 0; t < 60 * 900; t++) {
      a.update(1 / 60, px, pz, []);
      if (Math.hypot(a.body.x - px, a.body.z - pz) < a.standoff - 1e-4) { ok = false; break; }
    }
  }
  check('wandering circuit never closes inside the stand-off ring', ok);
}

// ---- 5: determinism per seed -------------------------------------------------------
{
  function replay(seed) {
    const st = new MemoryStore();
    st.set(ARCHIVIST_STORE_PREFIX + 'q', { version: 1, photos: 2, tier: 'curious' });
    const a = new Archivist({ landmarks: LANDMARKS, store: st, runId: 'd', priorRunIds: ['q'], seed });
    // walk a scripted figure-eight past the archivist
    let px = a.body.x + 14, pz = a.body.z;
    const trace = [];
    for (let t = 0; t < 60 * 240; t++) {
      const ang = t * (1 / 60) * 0.7;
      px = a.body.x + Math.cos(ang) * 9;
      pz = a.body.z + Math.sin(ang * 2) * 7;
      a.update(1 / 60, px, pz, []);
      trace.push(a.body.x.toFixed(5) + ',' + a.body.z.toFixed(5));
    }
    return trace.join(';');
  }
  const t1 = replay(999);
  const t2 = replay(999);
  const t3 = replay(31337);
  check('identical seed replays byte-identical trajectories', t1 === t2);
  check('different seed produces a different trajectory', t1 !== t3);
}

console.log('\nARCHIVIST: ' + passed + ' checks passed, ' + failures.length + ' failed');
if (failures.length > 0) {
  console.log('FAILED: ' + failures.join(' | '));
  process.exit(1);
}
