/* PatrolSchedule verification: waypoint loops, shift work, turn smoothing.
 * Run: node --experimental-strip-types test/schedules-test.mjs
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const { PatrolSchedule, watcherPatrol } = await import('../src/entities/schedules.ts');

const STEP = 1 / 30;

function simulate(s, seconds, speed = 1) {
  const out = { vx: [], vz: [], resting: [] };
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) {
    const v = s.update(STEP, speed);
    out.vx.push(v.vx);
    out.vz.push(v.vz);
    out.resting.push(s.resting);
  }
  return out;
}

// --- 1. determinism: same spawn + seed -> identical loops and motion ---
{
  const a = new PatrolSchedule(3.7, -12.2, 4242);
  const b = new PatrolSchedule(3.7, -12.2, 4242);
  assert.deepEqual([...a.waypoints], [...b.waypoints], 'waypoints must be deterministic');
  const sa = simulate(a, 20), sb = simulate(b, 20);
  assert.deepEqual(sa.vx, sb.vx, 'velocities must be deterministic');
  assert.deepEqual(sa.resting, sb.resting, 'rest cycles must be deterministic');

  const c = new PatrolSchedule(-50, 80, 4242); // same seed, different spawn
  assert.notDeepEqual([...a.waypoints], [...c.waypoints], 'spawn hash must alter the loop');
  console.log('PASS determinism');
}

// --- 2. loop shape: 4-6 waypoints, all 8-20m from spawn ---
{
  for (const [sx, sz] of [[0, 0], [100, -40], [-7.5, 13.25]]) {
    for (let seed = 0; seed < 200; seed++) {
      const s = new PatrolSchedule(sx, sz, seed * 2654435761);
      assert.ok(s.waypoints.length >= 4 && s.waypoints.length <= 6, 'waypoint count 4-6');
      for (const w of s.waypoints) {
        const d = Math.hypot(w.x - sx, w.z - sz);
        assert.ok(d >= 8 - 1e-9 && d <= 20 + 1e-9, `waypoint radius ${d} within [8,20]`);
      }
    }
  }
  console.log('PASS loop shape (600 schedules)');
}

// --- 3. waypoint dwell: pauses 2-5s at each stop ---
{
  const s = new PatrolSchedule(0, 0, 99);
  let dwellFrames = 0, maxDwell = 0, dwellCount = 0, walking = false;
  // walk long enough to hit at least two waypoints at speed 2
  for (let i = 0; i < Math.round(120 / STEP); i++) {
    const v = s.update(STEP, 2);
    if (!s.resting) {
      if (v.vx === 0 && v.vz === 0) {
        if (walking) { dwellCount++; }
        walking = false;
        dwellFrames++;
      } else {
        if (dwellFrames > 0) maxDwell = Math.max(maxDwell, dwellFrames);
        dwellFrames = 0;
        walking = true;
      }
    }
  }
  assert.ok(dwellCount >= 2, 'reached at least two waypoints, got ' + dwellCount);
  const dwellSecs = maxDwell * STEP;
  assert.ok(dwellSecs <= 5 + STEP, `dwell ${dwellSecs.toFixed(2)}s <= 5s`);
  assert.ok(dwellSecs >= 2 - STEP, `dwell ${dwellSecs.toFixed(2)}s >= 2s`);
  console.log('PASS waypoint dwell (' + dwellSecs.toFixed(2) + 's)');
}

// --- 4. path smoothing: heading changes are rate-limited ---
{
  const MAX_RATE = 1.8 + 1e-6; // documented default
  const s = new PatrolSchedule(0, 0, 77);
  let prev = null;
  for (let i = 0; i < Math.round(60 / STEP); i++) {
    const v = s.update(STEP, 1.4);
    const moving = Math.hypot(v.vx, v.vz) > 1e-6;
    const prevMoving = prev && Math.hypot(prev.vx, prev.vz) > 1e-6;
    if (moving && prevMoving) {
      const a0 = Math.atan2(prev.vx, prev.vz);
      const a1 = Math.atan2(v.vx, v.vz);
      let d = a1 - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      assert.ok(Math.abs(d) <= MAX_RATE * STEP + 1e-6,
        `heading jumped ${Math.abs(d).toFixed(4)} rad in one frame`);
    }
    prev = v;
  }
  console.log('PASS path smoothing');
}

// --- 5. shift work: active 3-5min, rest 1-2min, then active again ---
{
  const s = new PatrolSchedule(0, 0, 555);
  const sim = simulate(s, 480); // 8 minutes covers one full cycle either way
  const firstActiveEnd = sim.resting.indexOf(true);
  assert.ok(firstActiveEnd > 0, 'eventually rests');
  const activeSecs = firstActiveEnd * STEP;
  assert.ok(activeSecs >= 180 - 1e-9, `active ${activeSecs.toFixed(1)}s >= 180s`);
  assert.ok(activeSecs <= 300, `active ${activeSecs.toFixed(1)}s <= 300s`);
  const restStartFrame = firstActiveEnd;
  let restFrames = 0;
  while (restStartFrame + restFrames < sim.resting.length && sim.resting[restStartFrame + restFrames]) restFrames++;
  const restSecs = restFrames * STEP;
  assert.ok(restSecs >= 60 - 1e-9, `rest ${restSecs.toFixed(1)}s >= 60s`);
  assert.ok(restSecs <= 120, `rest ${restSecs.toFixed(1)}s <= 120s`);
  assert.ok(sim.resting[sim.resting.length - 1] === false || restStartFrame + restFrames < sim.resting.length,
    'cycle repeats after the break');
  // during rest it stands perfectly still
  const mid = restStartFrame + Math.floor(restFrames / 2);
  assert.equal(sim.vx[mid], 0, 'no vx while resting');
  assert.equal(sim.vz[mid], 0, 'no vz while resting');
  console.log(`PASS shift work (active ${activeSecs.toFixed(0)}s, rest ${restSecs.toFixed(0)}s)`);
}

// --- 6. watchers are exempt: alwaysOn never rests ---
{
  const w = watcherPatrol(10, 10, 12345);
  const plain = new PatrolSchedule(10, 10, 12345, { alwaysOn: true });
  for (const s of [w, plain]) {
    const sim = simulate(s, 400);
    assert.ok(!sim.resting.some(Boolean), 'watcher never rests across 6.6 minutes');
  }
  assert.ok(w.resting === false, 'resting flag stays false');
  console.log('PASS watcher exemption');
}

console.log('SCHEDULES_TEST_PASS');


