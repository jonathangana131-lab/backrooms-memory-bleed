/*
 * Functional verification of the footstep surface detector
 * (src/player/surfacedetect.ts): district -> surface mapping, puddle
 * splash override, and boundary hysteresis.
 *
 * Run: node --experimental-strip-types test/surfacedetect-test.mjs
 */
import assert from 'node:assert/strict';
import {
  DISTRICT_MAZE,
  DISTRICT_OPEN_OFFICE,
  DISTRICT_HONEYCOMB,
  DISTRICT_CORRIDOR_GRID,
  DISTRICT_STORAGE,
  PUDDLE_RADIUS,
  SURFACE_HYSTERESIS_DIST,
  SurfaceDetector,
} from '../src/player/surfacedetect.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

/* ------------------------------------------------------------------ */
/* District mapping                                                    */
/* ------------------------------------------------------------------ */

check('district constants match world/constants values', () => {
  assert.equal(DISTRICT_MAZE, 0);
  assert.equal(DISTRICT_OPEN_OFFICE, 1);
  assert.equal(DISTRICT_HONEYCOMB, 2);
  assert.equal(DISTRICT_CORRIDOR_GRID, 3);
  assert.equal(DISTRICT_STORAGE, 4);
});

check('MAZE and CORRIDOR_GRID default to carpet', () => {
  const d = new SurfaceDetector();


