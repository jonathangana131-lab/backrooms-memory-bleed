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


  // full lock inside ~5 m
  const gNear = new GazeController();
  settle(gNear, 3, ...pos(3), 0, 0, 0);
  assert.ok(gNear.state.weight > 0.95, 'close player locks the gaze fully');

  // mid-fade: tracking weakens but stays meaningful
  const gMid = new GazeController();
  const offMid = settle(gMid, 4, ...pos(12), 0, 0, 0);
  assert.ok(gMid.state.weight > 0.3 && gMid.state.weight < 0.8,
    'mid-distance weight sits in the fade band, got ' + gMid.state.weight.toFixed(3));
  // offset tracks the weighted target angle (50 deg off-axis, inside the clamp)
  assert.ok(Math.abs(offMid - rawAt(50, 12) * gMid.state.weight) < 0.05,
    'offset equals raw angle scaled by weight');

  // gentle bias at the fade edge
  const gFar = new GazeController();
  settle(gFar, 6, ...pos(20), 0, 0, 0);
  assert.ok(gFar.state.weight > 0.05 && gFar.state.weight < 0.35,
    'far bias is weak-but-present, got ' + gFar.state.weight.toFixed(3));

  // beyond FADE_END the head does not track at all
  const gOut = new GazeController();
  settle(gOut, 6, ...pos(30), 0, 0, 0);
  assert.ok(gOut.state.weight < 0.01, 'tracking dies beyond the fade end');
  console.log('PASS proximity weight');
}

// --- 4. watcher stare vs glance-away ---
{
  // watchers hold unbroken eye contact: 6 s of close mutual gaze without flinch
  const w = new GazeController({ watcher: true });
  settle(w, 6, 0, 3, 0, 0, 0);
  assert.ok(!w.state.averting, 'a watcher never glances away');
  // only non-watchers run the mutual-gaze clock; watchers are exempt from it
  assert.ok(w.state.mutualGazeTime === 0, 'watcher is exempt from the gaze clock');
  assert.ok(w.state.weight > 0.95, 'watcher stays locked');

  // non-watchers across seeds: first aversion lands within 2-4s of contact
  for (let seed = 0; seed < 40; seed++) {
    const g = new GazeController({ seed });
    let t = 0, firstAvert = NaN;
    while (t < 20) {
      g.update(STEP, 0, 3, 0, 0, 0);
      t += STEP;
      if (g.state.averting) { firstAvert = t; break; }
    }
    assert.ok(!isNaN(firstAvert), 'seed ' + seed + ': non-watcher must glance away');
    assert.ok(firstAvert >= 2 - 1e-9 && firstAvert <= 4 + 1e-9,
      'seed ' + seed + ': first aversion at ' + firstAvert.toFixed(2) + 's, want 2-4s');
    // during aversion the head points well clear of the player; the 90 deg/s
    // cap needs a few frames to travel there from a settled straight-ahead pose
    let cleared = false;
    for (let f = 0; f < Math.round(2 / STEP) && g.state.averting; f++) {
      g.update(STEP, 0, 3, 0, 0, 0);
      if (Math.abs(g.headYawOffset) > 0.4) { cleared = true; break; }
    }
    assert.ok(cleared, 'seed ' + seed + ': averted gaze must leave the player');
  }

  // after looking away it comes back
  const g = new GazeController({ seed: 3 });
  let sawAvert = false, cameBack = false;
  for (let i = 0; i < Math.round(12 / STEP); i++) {
    g.update(STEP, 0, 3, 0, 0, 0);
    if (g.state.averting) sawAvert = true;
    else if (sawAvert) { cameBack = true; break; }
  }
  assert.ok(sawAvert && cameBack, 'gaze must return after glancing away');
  console.log('PASS watcher stare / glance-away');
}

// --- 5. smooth motion: rate-limited, never snaps ---
{
  const g = new GazeController();
  settle(g, 2, 0, 10, 0, 0, 0);           // settled straight ahead
  const before = g.headYawOffset;
  // teleport the player to +80 deg off-axis at 3m
  const px = Math.sin(80 * DEG) * 3, pz = Math.cos(80 * DEG) * 3;
  const maxStep = 90 * DEG * STEP;
  let prev = before, totalMoved = 0, worst = 0;
  const frames = Math.round(4 / STEP);
  for (let i = 0; i < frames; i++) {
    const cur = g.update(STEP, px, pz, 0, 0, 0);
    const moved = Math.abs(cur - prev);
    if (moved > worst) worst = moved;
    totalMoved += moved;
    prev = cur;
  }
  // whatever happens, no frame may snap past the turn-rate cap
  assert.ok(worst <= maxStep * (1 + 1e-9),
    'per-frame turn exceeded the cap: ' + (worst / STEP * 180 / Math.PI).toFixed(1) + ' deg/s');
  // +80 deg is outside the +/-60 deg cone: tracking dies out entirely -- only a
  // brief transient remains while the old proximity weight drains away
  assert.ok(Math.abs(prev) < 1 * DEG,
    'head must relax off an out-of-cone player, got ' + (prev * 180 / Math.PI).toFixed(3) + ' deg');

  // same rate limit on a real traversal: jump INSIDE the cone to +55 deg at 3 m
  // (watcher, so glance-away never interrupts the measurement)
  const g2 = new GazeController({ watcher: true });
  settle(g2, 2, 0, 10, 0, 0, 0);
  const px2 = Math.sin(55 * DEG) * 3, pz2 = Math.cos(55 * DEG) * 3;
  let prev2 = g2.headYawOffset, worst2 = 0;
  for (let i = 0; i < frames; i++) {
    const cur = g2.update(STEP, px2, pz2, 0, 0, 0);
    worst2 = Math.max(worst2, Math.abs(cur - prev2));
    prev2 = cur;
  }
  assert.ok(worst2 <= maxStep * (1 + 1e-9),
    'traversal exceeded the cap: ' + (worst2 / STEP * 180 / Math.PI).toFixed(1) + ' deg/s');
  assert.ok(Math.abs(prev2 - 55 * DEG) < 0.02,
    'head must arrive at the player despite the cap, got '
      + (prev2 * 180 / Math.PI).toFixed(2) + ' deg, want ~55');
  console.log('PASS rate-limited smoothing');
}

console.log('\nALL gaze tests passed.');


