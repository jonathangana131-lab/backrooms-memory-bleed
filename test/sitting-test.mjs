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


// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
  assert.ok(a.claimedSeat, 'first behavior claims the only seat');

  const bb = new SittingBehavior(56);
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

// --- 6. seated height constant and settle ordering ---
{
  assert.equal(SEAT_DIP_Y, -0.45, 'seated dip is y -0.45 per spec');
  const b = new SittingBehavior(77);
  const seat = { x: 0, z: 1, yaw: 0.5 };
  b.setSeats([seat]);
  // figure stands exactly on the seat but faces the wrong way:
  // settle requires rotation BEFORE sitting completes
  const state = { x: 0, z: 1, yaw: 0.5 + Math.PI / 2, type: 'believer' };
  let t = 0, firstSitting = -1;
  while (t < 300) {
    const r = b.update(STEP, state);
    t += STEP;
    if (!r.sitting && r.target) {
      // caller turns toward target yaw but does not move closer
      let da = r.target.yaw - state.yaw;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      state.yaw += da * Math.min(1, STEP * 4);
    }
    if (r.sitting && firstSitting < 0) {
      firstSitting = t;
      assert.ok(Math.abs(state.yaw - 0.5) < 0.35,
        'rotation well underway before sitting flag rises');
      break;
    }
  }
  assert.ok(firstSitting > 0, 'misaligned figure settles into sitting after turning');
  b.releaseAll();
  console.log('PASS settle ordering and SEAT_DIP_Y');
}

// --- 7. no seats nearby: never engages ---
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


