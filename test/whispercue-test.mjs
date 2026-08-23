/*
 * Functional verification of the whisper direction cue
 * (src/ui/whispercue.ts): angle/bearing math, four-zone edge weighting,
 * diagonal half-strength splitting, motion-reduction storage probing,
 * the DOM-free fade state machine, and the DOM layer against a stub
 * document.
 *
 * Run: node --experimental-strip-types test/whispercue-test.mjs
 */
import assert from 'node:assert/strict';
import {
  EDGE_NAMES,
  REDUCED_EFFECT_SCALE,
  REDUCED_HOLD_MS,
  SHIMMER_FADE_MS,
  SHIMMER_PEAK_OPACITY,
  WhisperCue,
  WhisperCueState,
  angleDistance,
  edgeWeights,
  normalizeAngle,
  readMotionReduction,
  relativeBearing,
  whisperCueCssText,
} from '../src/ui/whispercue.ts';
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

/* ------------------------------------------------------------------ */
/* Angle + bearing math                                                */
/* ------------------------------------------------------------------ */

check('normalizeAngle wraps into (-PI, PI]', () => {
  assert.equal(normalizeAngle(0), 0);
  assert.ok(Math.abs(normalizeAngle(Math.PI * 3) - Math.PI) < 1e-9);
  assert.ok(Math.abs(normalizeAngle(-Math.PI * 3) - Math.PI) < 1e-9); // -PI canonicalized to +PI
  assert.ok(Math.abs(normalizeAngle(Math.PI / 2 + Math.PI * 2) - Math.PI / 2) < 1e-9);
  assert.equal(normalizeAngle(NaN), 0); // junk input is safe, not fatal
});

check('angleDistance picks the short way around', () => {
  assert.ok(angleDistance(-Math.PI + 0.1, Math.PI - 0.1) < 0.21); // across the seam
  assert.ok(Math.abs(angleDistance(Math.PI / 2, -Math.PI / 2) - Math.PI) < 1e-9);
});

check('relativeBearing subtracts camera yaw', () => {
  // Source behind (+PI), camera turned left by PI/4 -> source is now ahead-right.
  const b = relativeBearing(Math.PI, Math.PI * 0.75);
  assert.ok(Math.abs(b - Math.PI / 4) < 1e-9);
  // Identical heading -> dead ahead regardless of absolute value.
  assert.equal(relativeBearing(7.5, 7.5), 0);
});

/* ------------------------------------------------------------------ */
/* Edge zone weighting                                                 */
/* ------------------------------------------------------------------ */


