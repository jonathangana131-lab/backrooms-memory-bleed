/**
 * Prop avoidance steering tests.
 *
 * Run: node test/avoidance-test.mjs
 */
import { PropAvoidance } from '../src/entities/avoidance.ts';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? ` (${detail})` : ''}`);
  }
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ------------------------------------------------------------------
// No obstacles: pass-through
{
  const pa = new PropAvoidance();
  const r = pa.steer(1, 0, 0, 0);
  check('no obstacles returns desired unchanged', r.vx === 1 && r.vz === 0);
  const r2 = new PropAvoidance().steer(0, 0, 5, 5);
  check('zero desired velocity passes through', r2.vx === 0 && r2.vz === 0);
}

// ------------------------------------------------------------------
// Head-on prop: velocity bends around it, never reverses
{
  const pa = new PropAvoidance();
  pa.setObstacles([{ x: 4, z: 0, radius: 1 }]);
  // Entity at origin heading +X straight at a prop 3m ahead (inside
  // radius+margin influence of 1.3 only when closer; place it close).
  const px = 3.5;
  const r = pa.steer(1, 0, px, 0);
  check('repulsion deflects toward +Z', r.vz > 0.01, `vz=${r.vz}`);
  check('never reverses: forward component stays positive', r.vx > 0, `vx=${r.vx}`);
  // Speed preserved
  const speed = Math.hypot(r.vx, r.vz);
  check('speed preserved', approx(speed, 1, 1e-6), `speed=${speed}`);
}

// ------------------------------------------------------------------
// Outside margin: no deflection
{
  const pa = new PropAvoidance();
  pa.setObstacles([{ x: 4, z: 0, radius: 1 }]);
  const far = pa.steer(1, 0, 0, 0); // 4m from centre, outside 1.3m zone
  check('prop beyond margin does not deflect', far.vx === 1 && far.vz === 0);
}

// ------------------------------------------------------------------
// Performance pre-filter: obstacles beyond 8m are ignored
{
  const pa = new PropAvoidance();
  pa.setObstacles([
    { x: 50, z: 0, radius: 20 },   // huge but 50m away
    { x: 0, z: -60, radius: 30 },  // also out of range
  ]);
  const r = pa.steer(1, 0, 0, 0);
  check('obstacles beyond 8m ignored', r.vx === 1 && r.vz === 0);

  // Exactly at the 8m boundary is still checked.
  pa.setObstacles([{ x: 7.8, z: 0, radius: 0.1 }]);
  const edge = pa.steer(1, 0, 0, 0); // 7.8m < 8m check range, but 7.8 > 0.4 influence
  check('in-range but non-overlapping prop causes no deflection', edge.vx === 1 && edge.vz === 0);
}

// ------------------------------------------------------------------
// setObstacles copies its input
{
  const pa = new PropAvoidance();
  const obs = [{ x: 1, z: 0, radius: 0.5 }];
  pa.setObstacles(obs);
  obs.length = 0;
  const r = pa.steer(1, 0, 0.9, 0); // influenced only if the copy kept the obstacle
  check('snapshot actually steers', r.vz !== 0, 'expected lateral push from copied obstacle');
}

// ------------------------------------------------------------------
// Blend weights: full-strength perpendicular repulsion yields exactly
// the 60/40 mix => 33.69 degrees of deflection off intent
{
  const pa = new PropAvoidance();
  pa.setObstacles([{ x: 0, z: 0, radius: 0.5 }]);
  // Dead centre: escape is perpendicular (+Z) at full strength, so the
  // blend is 0.6*(1,0) + 0.4*(0,1).
  const r = pa.steer(1, 0, 0, 0);
  const dirAngle = Math.atan2(r.vz, r.vx);
  const expected = Math.atan2(0.4, 0.6);
  check('blend matches 60/40 weights',
    approx(dirAngle, expected, 1e-6),
    `angle=${((dirAngle * 180) / Math.PI).toFixed(2)} want ${((expected * 180) / Math.PI).toFixed(2)}`);
}

// ------------------------------------------------------------------
// Dead-centre degenerate case: escapes perpendicular, never reversed
{
  const pa = new PropAvoidance();
  pa.setObstacles([{ x: 0, z: 0, radius: 0.5 }]);
  const r = pa.steer(1, 0, 0, 0);
  check('dead-centre entity keeps moving forward', r.vx > 0, `vx=${r.vx}`);
  check('dead-centre escape is finite', Number.isFinite(r.vx) && Number.isFinite(r.vz));
}

// ------------------------------------------------------------------
// Multiple overlapping props: repulsion capped, still forward
{
  const pa = new PropAvoidance();
  pa.setObstacles([
    { x: 1, z: 0, radius: 0.9 },
    { x: 0.8, z: 0.2, radius: 0.9 },
    { x: 1.1, z: -0.15, radius: 0.9 },
  ]);
  const r = pa.steer(1, 0, 0, 0);
  check('stacked props cannot reverse travel', r.vx > 0, `vx=${r.vx}`);
  check('stacked props still deflect', r.vz > 0, `vz=${r.vz}`);
  check('stacked props keep speed sane', approx(Math.hypot(r.vx, r.vz), 1, 1e-6));
}

// ------------------------------------------------------------------
// Arbitrary diagonal desired direction
{
  const pa = new PropAvoidance();
  pa.setObstacles([{ x: 3, z: 3, radius: 1 }]);
  // Entity at (2.5, 2.5) heading along +X+Z directly at the prop.
  const len = Math.SQRT1_2;
  const r = pa.steer(len, len, 2.5, 2.5);
  const dot = (r.vx * len + r.vz * len) / Math.hypot(r.vx, r.vz);
  check('diagonal intent never reversed', dot > 0, `dot=${dot.toFixed(3)}`);
  const speed = Math.hypot(r.vx, r.vz);
  check('diagonal speed preserved', approx(speed, 1, 1e-6), `speed=${speed}`);
}

if (failures > 0) {
  console.error(`
${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\nAll avoidance tests passed.');
}


