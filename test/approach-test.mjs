/**
 * Watcher approach footstep tests -- pure Node, no audio device.
 * Drives logic-only WatcherSteps instances (null AudioContext) and verifies:
 *   1. mirror-step cadence: half-stride offset, then the player's rate
 *   2. stop -> exactly TRAIL_STEPS more steps, then silence
 *   3. SURFACE follows the WATCHER's floor; unknown labels fall back to carpet
 *   4. distance envelope rides each step record; dead cut inside 3 m
 *   5. untracked watchers hold their stride and say nothing
 * Run: node test/approach-test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WatcherSteps, approachGain,
  STEP_INTERVAL, MIRROR_OFFSET, TRAIL_STEPS, CUT_DIST,
} from '../src/audio/approach.ts';

const DT = 1 / 60;

/** Drive a logic-only watcher for `seconds`, holding the given state. */
function run(w, seconds, dist, playerMoving, surface = 'carpet') {
  for (let t = 0; t < seconds; t += DT) w.update(DT, dist, playerMoving, surface);
}

// --- 1. mirror cadence -------------------------------------------------------
test('steps sync to the player offset half a stride', () => {
  const w = new WatcherSteps(null, null);
  // first step lands around MIRROR_OFFSET after the walk starts
  let firstAt = NaN;
  for (let t = 0; t < 2; t += DT) {
    const n = w.fired.length;
    w.update(DT, 8, true, 'carpet');
    if (n === 0 && w.fired.length === 1) { firstAt = t + DT; break; }
  }
  assert.ok(!isNaN(firstAt), 'a walking watcher steps');
  assert.ok(Math.abs(firstAt - MIRROR_OFFSET) <= DT,
    `first step at ${firstAt.toFixed(3)}s, want ~${MIRROR_OFFSET}`);
  void STEP_INTERVAL;

  // steady-state cadence matches the player's stride interval
  const gaps = [];
  let last = null;
  for (let t = 0; t < 6; t += DT) {
    const n = w.fired.length;
    w.update(DT, 8, true, 'carpet');
    if (w.fired.length > n) {
      if (last !== null) gaps.push(t - last);
      last = t;
    }
  }
  assert.ok(gaps.length >= 5, 'several steps fired');
  for (const g of gaps) assert.ok(Math.abs(g - STEP_INTERVAL) <= DT * 2,
    `gap ${g.toFixed(3)}s tracks the ${STEP_INTERVAL}s stride`);
});

// --- 2. realization window -----------------------------------------------------
test('stopping earns exactly two trailing steps then silence', () => {
  const w = new WatcherSteps(null, null);
  run(w, 4, 8, true);
  const walked = w.fired.length;
  assert.ok(walked > 2, 'walking produced steps');
  run(w, 4, 8, false); // player stands still
  assert.equal(w.fired.length - walked, TRAIL_STEPS,
    'the watcher takes exactly ' + TRAIL_STEPS + ' more steps');
  const before = w.fired.length;
  run(w, 6, 8, false);
  assert.equal(w.fired.length, before, 'then goes quiet for good');
});

// --- 3. surface belongs to the watcher ------------------------------------------
test('unknown floor labels fall back to carpet', () => {
  const w = new WatcherSteps(null, null);
  run(w, 3, 8, true, 'gravel');
  assert.ok(w.fired.length > 0);
  for (const f of w.fired) assert.equal(f.surface, 'carpet');

  // known labels pass through untouched
  const metal = new WatcherSteps(null, null);
  run(metal, 3, 8, true, 'metal');
  assert.ok(metal.fired.length > 0);
  for (const f of metal.fired) assert.equal(f.surface, 'metal');
});

// --- 4. distance envelope --------------------------------------------------------
test('distance envelope rides each step record', () => {
  const far = new WatcherSteps(null, null);
  run(far, 4, 24, true);
  const near = new WatcherSteps(null, null);
  run(near, 4, 7, true);
  assert.ok(near.fired.length > 0 && far.fired.length > 0);
  const avg = (w) => w.fired.reduce((s, f) => s + f.gain, 0) / w.fired.length;
  assert.ok(avg(near) > avg(far) * 3, 'closer watcher is much louder');

  const cut = new WatcherSteps(null, null);
  run(cut, 4, 2.9, true); // inside 3 m: silence before the encounter
  assert.ok(cut.fired.length > 0, 'steps still tick inside the cut radius');
  for (const f of cut.fired) assert.equal(f.gain, 0, 'every close step is muted');
});

test('approachGain curve hits its documented landmarks', () => {
  assert.equal(approachGain(CUT_DIST), 0, 'cut radius is dead silence');
  assert.equal(approachGain(2), 0, 'inside the cut is dead silence');
  assert.equal(approachGain(26), 0, 'at the far edge nothing is audible');
  assert.equal(approachGain(40), 0, 'beyond the far edge stays silent');
  assert.ok(approachGain(7) === 1, 'plateau range runs at full loudness');
  assert.ok(approachGain(20) > 0 && approachGain(20) < 0.2,
    'far steps are nearly imperceptible');
  assert.ok(approachGain(3.5) > 0 && approachGain(3.5) < 0.2,
    'close fade rises steeply out of the hush');
});

// --- 5. untracked watcher ---------------------------------------------------------
test('untracked watcher holds its stride and says nothing', () => {
  const w = new WatcherSteps(null, null);
  run(w, 2, 8, true);
  assert.ok(w.fired.length > 0);
  const before = w.fired.length;
  run(w, 4, null, true); // despawned / untracked
  assert.equal(w.fired.length, before, 'no steps while untracked');
  // resuming tracking resumes stepping without a burst
  run(w, 1.5, 8, true);
  assert.ok(w.fired.length > before, 'steps resume once tracked again');
});
