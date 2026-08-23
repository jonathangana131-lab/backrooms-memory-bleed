/* SittingBehavior verification: chapel preference, seat claims, sit cycles.
 * Run: node --experimental-strip-types test/sitting-test.mjs
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

const { SittingBehavior, SEAT_DIP_Y, SIT_MIN_SEC, SIT_MAX_SEC } =
  await import('../src/entities/sitting.ts');

const STEP = 1 / 30;

/** Teleport-free driver: applies each tick's returned movement/facing. */
function drive(b, state, seconds) {
  const frames = [];
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) {
    const r = b.update(STEP, state);
    if (!r.sitting) {
      state.x += r.moveX;
      state.z += r.moveZ;
      state.yaw = r.yaw;
    } else {
      state.yaw = r.yaw; // settling faces whatever the pews face
    }
    frames.push(r);
  }
  return frames;
}

/** Step without steering anywhere: collect raw results. */
function idleRun(b, state, seconds) {
  const frames = [];
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) frames.push(b.update(STEP, state));
  return frames;
}

// --- 1. basic sit cycle: approach, settle, stay ---
{
  const seat = { x: 4, z: -3, yaw: 1.2 };
  // not every seed feels the pull; find one that does and follow it through
  let picked = null;
  for (let seed = 1; seed <= 80 && !picked; seed++) {
    const b = new SittingBehavior(seed);
    b.setSeats([seat]);
    const state = { x: 0, z: 0, yaw: 0, type: 'believer' };
    const frames = drive(b, state, 30);
    if (b.claimedSeat) picked = { b, frames, state };
    else b.releaseAll();
  }
  assert.ok(picked, 'some seeds feel the pull to sit');
  assert.ok(picked.frames.some((r) => r.sitting), 'figure eventually starts settling');
  assert.ok(picked.frames[picked.frames.length - 1].sitting, 'still sitting at the end');
  assert.ok(Math.hypot(picked.state.x - seat.x, picked.state.z - seat.z) < 0.5,
    'figure ended at the bench, not mid-route');
  picked.b.releaseAll();
  console.log('PASS basic sit cycle');
}

// --- 2. believers prefer CHAPEL pews ---------------------------------------
{
  const seats = [
    { x: 1, z: 0, yaw: Math.PI / 2 },                 // near chair
    { x: 6, z: 3, yaw: 0, chapel: true },             // pew A
    { x: 6, z: 5, yaw: 0, chapel: true },             // pew B
  ];
  let chapelPicks = 0;
  const trials = 400;
  for (let seed = 0; seed < trials; seed++) {
    const b = new SittingBehavior(seed * 2654435761 + 7);
    b.setSeats(seats);
    const state = { x: 0, z: 0, yaw: 0, type: 'believer' };
    let t = 0;
    while (!b.claimedSeat && t < 600) { b.update(STEP, state); t += STEP; }
    if (b.claimedSeat?.chapel) chapelPicks++;
    b.releaseAll();
  }
  const frac = chapelPicks / trials;
  // believers sit at all only 80% of rolls; when they sit they take a pew.
  // P(pew chosen) here = 0.8 (decides to sit) since any sit picks a pew.
  assert.ok(frac > 0.65 && frac < 0.92, `chapel pick fraction ${frac.toFixed(2)} near 0.8`);

  // control: non-believers mostly take the nearest (non-chapel) seat
  let chairPicks = 0;
  for (let seed = 0; seed < trials; seed++) {
    const b = new SittingBehavior(seed * 40503 + 13);
    b.setSeats(seats);
    const state = { x: 0, z: 0, yaw: 0, type: 'wanderer' };
    let t = 0;
    while (!b.claimedSeat && t < 900) { b.update(STEP, state); t += STEP; }
    if (b.claimedSeat && !b.claimedSeat.chapel) chairPicks++;
    b.releaseAll();
  }
  assert.ok(chairPicks > 0, 'some wanderers should still sit on plain chairs');
  console.log(`PASS believer chapel preference (pew fraction ${frac.toFixed(2)})`);
}

// --- 3. occupancy: two figures never converge on the same seat ---
{
  const seats = Array.from({ length: 3 }, (_, i) => ({ x: 2 + i * 2, z: 0, yaw: 0 }));
  const figures = [];
  for (let i = 0; i < 6; i++) {
    const b = new SittingBehavior(i * 7919 + 17);
    b.setSeats(seats);
    figures.push({ b, s: { x: -8 + i * 0.5, z: 5, yaw: 0, type: 'believer' } });
  }
  // everyone ticks simultaneously against the shared claim registry
  for (let f = 0; f < Math.round(40 / STEP); f++) {
    for (const g of figures) g.b.update(STEP, g.s);
  }
  const claimed = figures.map((g) => g.b.claimedSeat).filter(Boolean);
  assert.ok(claimed.length >= 3, 'several figures found their way onto benches',
    String(claimed.length));
  assert.equal(new Set(claimed).size, claimed.length,
    'no seat is claimed by two behaviors at once');
  for (const g of figures) g.b.releaseAll();
  console.log('PASS occupancy exclusivity');
}

// --- 4. releaseAll frees claims ---------------------------------------------
{
  const seat = { x: 2, z: 0, yaw: 0 };
  const a = new SittingBehavior(11);
  a.setSeats([seat]);
  const sa = { x: 0, z: 0, yaw: 0, type: 'believer' };
  for (let i = 0; i < 30 * 20 && !a.claimedSeat; i++) a.update(STEP, sa);
  assert.ok(a.claimedSeat, 'first behavior claims the only seat');

  const bb = new SittingBehavior(60);
  bb.setSeats([seat]);
  const sb = { x: 2.5, z: 2, yaw: 1, type: 'wanderer' };
  let gotIt = false;
  for (let i = 0; i < 30 * 20; i++) {
    bb.update(STEP, sb);
    if (bb.claimedSeat === seat) { gotIt = true; break; }
  }
  assert.equal(gotIt, false, 'second behavior cannot claim a held seat');

  a.releaseAll();
  bb.releaseAll();
  for (let i = 0; i < 30 * 20 && !gotIt; ) {
    // fresh decision window starts promptly after releaseAll
    const r = bb.update(STEP, sb);
    i++;
    if (bb.claimedSeat === seat) gotIt = true;
  }
  assert.ok(gotIt, 'freed seat becomes claimable again');
  bb.releaseAll();
  console.log('PASS releaseAll frees claims');
}

// --- 5. settle ordering: alignment comes with the seat ----------------------
{
  const b = new SittingBehavior(77);
  const seat = { x: 0, z: 1, yaw: 0.5 };
  b.setSeats([seat]);
  // figure stands exactly on the seat but faces the wrong way
  const state = { x: 0, z: 1, yaw: 0.5 + Math.PI / 2, type: 'believer' };
  let t = 0, firstSitting = -1;
  while (t < 300) {
    const r = b.update(STEP, state);
    t += STEP;
    // the returned yaw is the facing the caller applies this tick
    state.yaw = r.yaw;
    if (r.sitting && firstSitting < 0) firstSitting = t;
  }
  assert.ok(firstSitting > 0, 'misaligned figure settles into sitting anyway');
  assert.ok(Math.abs(state.yaw - 0.5) < 1e-9,
    'seated figure ends facing the seat direction');
  b.releaseAll();
  console.log('PASS settle ordering');
}

// --- 6. no seats nearby: never engages ---
{
  const b = new SittingBehavior(31);
  b.setSeats([]);
  const state = { x: 0, z: 0, yaw: 0, type: 'believer' };
  const frames = idleRun(b, state, 90);
  assert.ok(frames.every((r) => !r.sitting && r.target === undefined),
    'empty seat list means pure patrol');
  console.log('PASS no-seat no-op');
}

console.log('ALL SITTING TESTS PASSED');
