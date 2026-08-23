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



check('cardinal bearing lights exactly one edge at full strength', () => {
  for (const [bearing, edge] of [
    [0, 'north'],
    [Math.PI / 2, 'east'],
    [Math.PI, 'south'],
    [-Math.PI / 2, 'west'],
  ]) {
    const w = edgeWeights(bearing);
    assert.equal(w[edge], 1, edge + ' should be 1.0');


    for (const other of EDGE_NAMES) {
      if (other !== edge) assert.equal(w[other], 0, other + ' should be 0');
    }
  }
});

check('diagonal bearing splits two adjacent edges at half strength', () => {
  const ne = edgeWeights(Math.PI / 4); // ahead-right corner
  assert.equal(ne.north, 0.5);
  assert.equal(ne.east, 0.5);


  assert.equal(ne.south, 0);
  assert.equal(ne.west, 0);
  const sw = edgeWeights(-Math.PI * 0.75); // behind-left corner
  assert.equal(sw.south, 0.5);
  assert.equal(sw.west, 0.5);
  assert.equal(sw.north, 0);
  assert.equal(sw.east, 0);
});

check('weights always sum to ~1 for any bearing (energy conserving)', () => {
  for (let i = 0; i <= 48; i++) {
    const w = edgeWeights((i / 48) * Math.PI * 2 - Math.PI);
    const sum = EDGE_NAMES.reduce((acc, n) => acc + w[n], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, 'sum was ' + sum + ' at i=' + i);
  }
});

/* ------------------------------------------------------------------ */
/* Motion-reduction probe                                              */
/* ------------------------------------------------------------------ */

function stubStorage(map) {
  return { getItem: (k) => (map.has(k) ? map.get(k) : null) };
}

check('readMotionReduction reads the bmb-accessibility flag', () => {
  assert.equal(readMotionReduction(null), false); // no storage at all
  assert.equal(
    readMotionReduction(stubStorage(new Map())),
    false,
    'missing key means off',
  );
  assert.equal(
    readMotionReduction(
      stubStorage(new Map([['bmb-accessibility', JSON.stringify({ motionReduction: true })]])),
    ),
    true,
  );
  assert.equal(
    readMotionReduction(


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

  // Style injected once into head, layer attached to the HUD.
  const styleEl = doc.head.children.find((c) => c.className === 'bmb-whispercue-styles');
  assert.ok(styleEl, 'stylesheet element injected');
  assert.match(styleEl.textContent, /bmb-whispercue-layer/);
  assert.equal(hud.children.length, 1);
  const layer = hud.children[0];
  assert.equal(layer.className, 'bmb-whispercue-layer');
  assert.equal(layer.children.length, 4);

  // CSS stays atmospheric: pointer-events none, faint gradients only.
  const css = whisperCueCssText();
  assert.match(css, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /border:/);

  cue.trigger(Math.PI, 0); // whisper directly behind -> south edge
  const south = findEdge(layer, 'south');
  const north = findEdge(layer, 'north');
  assert.equal(parseFloat(south.styleProps['opacity']), SHIMMER_PEAK_OPACITY);
  assert.equal(parseFloat(north.styleProps['opacity']), 0);

  // Camera facing west makes that same behind-source read as east.
  cue.trigger(Math.PI, -Math.PI / 2);
  assert.equal(parseFloat(findEdge(layer, 'east').styleProps['opacity']), SHIMMER_PEAK_OPACITY);

  cue.update(0.6);
  const mid = parseFloat(findEdge(layer, 'east').styleProps['opacity']);
  assert.ok(mid > 0 && mid < SHIMMER_PEAK_OPACITY, 'fading over time');

  cue.dispose();
  assert.ok(layer.removed, 'dispose removes the layer');
  assert.equal(hud.children.length, 0);
});

check('WhisperCue honors reduced motion from storage at trigger time', () => {
  const doc = makeStubDocument();
  const hud = doc.createElement('hud');
  hud.ownerDocument = doc;

  const realStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');


