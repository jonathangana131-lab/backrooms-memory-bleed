  // dead ahead at 10m -> looking -> no instant despawn
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(0), cam, { x: 0, z: 10 }), false);
  // 20 deg off-axis: inside the 35 deg cone -> still watched
  assert.equal(isOutsideGaze(fwd(20), cam, { x: Math.sin(20 * DEG) * 10, z: Math.cos(20 * DEG) * 10 }), false);
  // hugging the cone boundary from either side (exact cos(35) equality is float-noise territory)
  const inside = { x: Math.sin(34 * DEG) * 10, z: Math.cos(34 * DEG) * 10 };
  const outside = { x: Math.sin(36 * DEG) * 10, z: Math.cos(36 * DEG) * 10 };
  assert.equal(isOutsideGaze(fwd(0), cam, inside), false, 'just inside the cone counts as looked at');
  assert.equal(isOutsideGaze(fwd(0), cam, outside), true, 'just outside the cone allows instant despawn');
  // 40 deg off-axis: outside the cone -> instant despawn allowed
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(40), cam, { x: Math.sin(40 * DEG) * 10, z: Math.cos(40 * DEG) * 10 }), true);
  // behind the player: definitely instant
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(0), cam, { x: 0, z: -10 }), true);
  console.log('PASS gaze cone');


// [unrecovered line]
// [unrecovered line]
// --- 2. threshold constant and offset-camera geometry ---
{
  assert.ok(Math.abs(GAZE_COS_THRESHOLD - Math.cos(35 * DEG)) < 1e-12, 'threshold must be cos(35deg)');
  // non-origin camera: entity behind the view direction
  const cam = { x: 5, z: 5 };
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(90), cam, { x: 5, z: -5 }), true);
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(90), cam, { x: 15, z: 5 }), false);
  // unnormalized forward must be normalized internally
  assert.equal(GracefulDespawn.shouldInstantDespawn({ x: 0, z: 42 }, cam, { x: 15, z: 5 }), false);
  // degenerate zero-distance: never pop, force the fade path
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(0), { x: 1, z: 1 }, { x: 1, z: 1 }), false);
  console.log('PASS threshold + geometry');


