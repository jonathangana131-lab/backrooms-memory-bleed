/* GazeController verification: peripheral cone, proximity weight,
 * watcher stare vs glance-away, rate-limited smoothing.
 * Run: node --experimental-strip-types test/gaze-test.mjs
 */
import assert from 'node:assert/strict';
import { GazeController } from '../src/entities/gaze.ts';

const STEP = 1 / 30;
const DEG = Math.PI / 180;

function settle(g, seconds, px, pz, fx, fz, bodyYaw) {
  const n = Math.round(seconds / STEP);
  let last = 0;
  for (let i = 0; i < n; i++) last = g.update(STEP, px, pz, fx, fz, bodyYaw);
  return last;
}

// --- 1. API contract: update returns the offset it stores ---
{
  const g = new GazeController();
  const r = g.update(STEP, 0, 5, 0, 0, 0);
  assert.equal(typeof r, 'number', 'update must return a number');
  assert.equal(r, g.headYawOffset, 'returned value must match headYawOffset');
  console.log('PASS api contract');
}

// --- 2. peripheral awareness: orients inside the cone, relaxes outside ---
{
  // figure at origin facing +z (bodyYaw 0). Player 10m away at 40 deg off-axis:
  // inside the default +/-60 deg cone even while "walking" (body yaw unchanged).
  const g = new GazeController();
  const px = Math.sin(40 * DEG) * 10, pz = Math.cos(40 * DEG) * 10;
  const off = settle(g, 3, px, pz, 0, 0, 0);
  assert.ok(Math.abs(off) > 0.1, 'head must orient toward player inside peripheral arc');
  assert.equal(Math.sign(off), Math.sign(px), 'offset sign must point toward the player');
  assert.ok(g.state.inPeripheral, 'state.inPeripheral true inside cone');

  // player dead ahead -> zero offset needed
  const g0 = new GazeController();
  const off0 = settle(g0, 3, 0, 10, 0, 0, 0);
  assert.ok(Math.abs(off0) < 1e-6, 'dead-ahead player needs no offset');

  // player behind (180 deg): outside the cone -> no tracking
  const gb = new GazeController();
  const offb = settle(gb, 4, 0, -10, 0, 0, 0);
  assert.ok(!gb.state.inPeripheral, 'behind is outside the cone');
  assert.ok(Math.abs(offb) < 1e-6, 'head must not track a player outside the arc');

  // narrow custom cone honours the option
  const gn = new GazeController({ peripheralHalfAngleDeg: 20 });
  settle(gn, 2, px, pz, 0, 0, 0);
  assert.ok(!gn.state.inPeripheral, '40deg off-axis is outside a 20deg half-cone');
  console.log('PASS peripheral cone');
}

// --- 3. gaze weight scales with proximity ---
{
  const rawAt = (degOff, dist) => degOff * DEG; // target angle magnitude
  // place players at +50 deg so neck clamp (75deg) never truncates
  const pos = (dist) => [Math.sin(50 * DEG) * dist, Math.cos(50 * DEG) * dist];


