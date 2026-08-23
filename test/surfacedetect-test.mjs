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


  assert.equal(d.districtSurface(DISTRICT_MAZE), 'carpet');
  assert.equal(d.districtSurface(DISTRICT_CORRIDOR_GRID), 'carpet');
});

check('OPEN_OFFICE and HONEYCOMB map to tile, STORAGE to metal', () => {
  const d = new SurfaceDetector();
  assert.equal(d.districtSurface(DISTRICT_OPEN_OFFICE), 'tile');
  assert.equal(d.districtSurface(DISTRICT_HONEYCOMB), 'tile');
  assert.equal(d.districtSurface(DISTRICT_STORAGE), 'metal');
  assert.equal(d.districtSurface(99), 'carpet'); // unknown districts fall back
});

/* ------------------------------------------------------------------ */
/* Hysteresis                                                          */
/* ------------------------------------------------------------------ */

check('first observation commits immediately', () => {
  const d = new SurfaceDetector();
  assert.equal(d.detect(0, 0, DISTRICT_MAZE), 'carpet');
  assert.equal(d.currentSurface, 'carpet');
});

check('surface change needs sustained travel to commit', () => {
  const d = new SurfaceDetector();
  d.detect(0, 0, DISTRICT_MAZE); // commit carpet
  // step into OPEN_OFFICE (tile) but stay inside the hysteresis distance
  assert.equal(d.detect(0.1, 0, DISTRICT_OPEN_OFFICE), 'carpet');
  assert.equal(d.detect(0.2, 0, DISTRICT_OPEN_OFFICE), 'carpet');
  // travelling past SURFACE_HYSTERESIS_DIST from the candidate anchor commits
  assert.equal(d.detect(SURFACE_HYSTERESIS_DIST + 0.05, 0, DISTRICT_OPEN_OFFICE), 'tile');
  assert.equal(d.currentSurface, 'tile');
});

check('returning to the committed surface drops stale candidacy', () => {
  const d = new SurfaceDetector();
  d.detect(0, 0, DISTRICT_MAZE);
  d.detect(0.1, 0, DISTRICT_OPEN_OFFICE); // pending tile candidacy
  d.detect(0.15, 0, DISTRICT_MAZE);       // back on carpet: candidacy dropped
  // crossing again restarts the hysteresis clock from a fresh anchor
  assert.equal(d.detect(0.2, 0, DISTRICT_OPEN_OFFICE), 'carpet');
  assert.equal(d.detect(SURFACE_HYSTERESIS_DIST + 0.25, 0, DISTRICT_OPEN_OFFICE), 'tile');
});

check('a single large step past the boundary commits immediately', () => {
  const d = new SurfaceDetector();
  d.detect(0, 0, DISTRICT_MAZE);
  // teleport far into tile territory: anchor is the last sampled position
  assert.equal(d.detect(5, 5, DISTRICT_OPEN_OFFICE), 'tile');
});

/* ------------------------------------------------------------------ */
/* Splash override                                                     */
/* ------------------------------------------------------------------ */

check('registered puddles override the district surface immediately', () => {
  const d = new SurfaceDetector();
  d.detect(0, 0, DISTRICT_MAZE);
  d.setPuddles([{ x: 2, z: 0 }]);
  assert.ok(d.isInPuddle(2.2, 0));
  assert.equal(d.detect(2.2, 0, DISTRICT_MAZE), 'splash');
  assert.equal(d.currentSurface, 'splash');
  assert.equal(d.isInPuddle(4, 4), false);
  assert.equal(d.detect(4, 4, DISTRICT_MAZE), 'carpet');
});

check('puddle radius matches the documented constant', () => {
  const d = new SurfaceDetector();
  d.setPuddles([{ x: 10, z: 10 }]);
  const at = PUDDLE_RADIUS * Math.SQRT1_2; // inside the circle
  assert.equal(d.isInPuddle(10 + at, 10 + at - 0.001), true);
  assert.equal(d.isInPuddle(10 + PUDDLE_RADIUS + 0.01, 10), false);
});

console.log('ok - ' + passed + ' checks passed');
process.exit(passed > 0 ? 0 : 1);
