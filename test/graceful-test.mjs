/**
 * Graceful entity despawn tests -- pure Node, no engine.
 * Run: node test/graceful-test.mjs
 */
import assert from 'node:assert/strict';
import { GracefulDespawn, isOutsideGaze, GAZE_COS_THRESHOLD, GAZE_HALF_ANGLE_DEG, FADE_DURATION_S } from '../src/entities/graceful.ts';

const DEG = Math.PI / 180;

/** Unit forward vector pointing deg off +z. */
function fwd(deg) {
  const a = deg * DEG;
  return { x: Math.sin(a), z: Math.cos(a) };
}

const cam = { x: 0, z: 0 };

// --- 1. gaze cone decides instant vs fade ---
{
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
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(0), cam, { x: Math.sin(40 * DEG) * 10, z: Math.cos(40 * DEG) * 10 }), true);
  // behind the player: definitely instant
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(0), cam, { x: 0, z: -10 }), true);
  console.log('PASS gaze cone');
}

// --- 2. threshold constant and offset-camera geometry ---
{
  assert.ok(Math.abs(GAZE_COS_THRESHOLD - Math.cos(35 * DEG)) < 1e-12, 'threshold must be cos(35deg)');
  // non-origin camera: entity behind the view direction
  const cam = { x: 5, z: 5 };
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(90), cam, { x: 5, z: -5 }), true);
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(90), cam, { x: 15, z: 5 }), false);
  // unnormalized forward must be normalized internally
  assert.equal(GracefulDespawn.shouldInstantDespawn({ x: 42, z: 0 }, cam, { x: 15, z: 5 }), false);
  // degenerate zero-distance: never pop, force the fade path
  assert.equal(GracefulDespawn.shouldInstantDespawn(fwd(0), { x: 1, z: 1 }, { x: 1, z: 1 }), false);
  console.log('PASS threshold + geometry');
}

// --- 3. constants + watched-fade material cloning ---
{
  assert.equal(GAZE_HALF_ANGLE_DEG, 35, 'gaze cone half-angle is a documented 35 deg');
  assert.equal(FADE_DURATION_S, 1, 'watched fades last about a second');

  const shared = { name: 'sharedMat', opacity: 1, clone() { return { name: 'sharedMat.clone' }; } };
  const childMat = { name: 'childMat', opacity: 1, clone() { return { name: 'childMat.clone' }; } };
  const mesh = {
    material: shared,
    getChildMeshes() { return [{ material: childMat }, {}]; },
  };
  const first = GracefulDespawn.beginWatchedFade(mesh);
  assert.ok(first, 'fade begins when materials are clonable');
  assert.equal(first.opacity, 1, 'the clone starts fully opaque');
  assert.ok(first !== shared && first !== childMat, 'fading uses a private clone, never the shared material');

  // bare mocks without clone() must degrade to the slow path, not throw
  const bare = GracefulDespawn.beginWatchedFade({ material: { opacity: 1 } });
  assert.equal(bare, null, 'nothing clonable -> null, caller keeps the fade path');
  const empty = GracefulDespawn.beginWatchedFade({});
  assert.equal(empty, null, 'mesh without material -> null too');
  console.log('PASS watched fade');
}

console.log('\nALL graceful despawn tests passed.');
