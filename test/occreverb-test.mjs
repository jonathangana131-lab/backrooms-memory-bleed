/**
 * Live occlusion reverb tests (F88) - pure Node, no audio device.
 * Verifies the F88 acceptance proof:
 *   1. RT60 monotone in volume for a fixed material (uniform scaling and
 *      single-axis growth), clamped to [MIN_RT60_SEC, MAX_RT60_SEC]
 *   2. material table honored - identical geometry across materials yields
 *      strictly longer RT60 for strictly lower absorption coefficients
 *   3. descriptors are convolver-ready - early delays ascend and equal
 *      2*extent/c per axis pair; wetGain stays in 0..1 and grows with RT60
 *   4. AC reverb-zone transition - crossing rooms opens exactly ONE blended
 *      transition that completes within TRANSITION_TAU_SEC +/- 10%;
 *      completion fires once; mid-fade crossings retarget instead of stacking
 *   5. determinism - pure arithmetic over injected rooms replays identical
 *      descriptors for identical inputs
 *   6. junk inputs safe - NaN positions, outside-room poses, degenerate
 *      bounds and unknown materials never throw; duplicate ids fail loud
 *
 * Run: node test/occreverb-test.mjs  (prints OCCREVERB ALL PASS, exits 0)
 */
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

const {
  OccReverb, computeDescriptor, blendDescriptors, sabineRt60,
  MATERIAL_ABSORPTION, FALLBACK_ABSORPTION,
  SABINE_CONSTANT, SPEED_OF_SOUND_MPS,
  TRANSITION_TAU_SEC, TAU_TOLERANCE, MIN_RT60_SEC, MAX_RT60_SEC,
  boundsVolume, boundsSurfaceArea, boundsContain, boundsValid,
} = await import('../src/audio/occreverb.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** Axis-aligned cube room of side s at origin-ish coordinates. */
const cube = (id, s, material = 'tile', ox = 0) => ({
  id,
  bounds: { min: [ox, 0, 0], max: [ox + s, s, s] },
  material,
});

// ---------------------------------------------------------------------------
console.log('1. RT60 monotonicity in volume (fixed material)');
{
  const mats = ['tile', 'concrete', 'carpet', 'ceilingTile', 'wetSurface'];
  for (const mat of mats) {
    let prev = -1;
    let mono = true;
    for (const s of [1, 2, 3, 5, 8, 13]) {
      const d = computeDescriptor(cube('r' + s, s, mat));
      if (!(d.rt60Sec > prev)) mono = false;
      prev = d.rt60Sec;
    }
    ok(mono, `rt60 strictly increases with uniform volume scale (${mat})`);
  }
  // Single-axis growth at fixed cross-section also raises RT60.
  const small = computeDescriptor({ id: 'a', bounds: { min: [0, 0, 0], max: [2, 3, 3] }, material: 'tile' });
  const long = computeDescriptor({ id: 'b', bounds: { min: [0, 0, 0], max: [20, 3, 3] }, material: 'tile' });
  ok(long.rt60Sec > small.rt60Sec, 'single-axis stretch raises rt60');
  // Sabine spot-check on an exact cube.
  const c = cube('c', 4);
  const d = computeDescriptor(c);
  const expect = Math.min(MAX_RT60_SEC, SABINE_CONSTANT * 64 / (boundsSurfaceArea(c.bounds) * MATERIAL_ABSORPTION.tile));
  ok(near(d.rt60Sec, expect, 1e-12), `rt60 matches Sabine 0.161*V/A (${d.rt60Sec.toFixed(4)})`);
  // Clamp band.
  ok(d.rt60Sec >= MIN_RT60_SEC && d.rt60Sec <= MAX_RT60_SEC, 'rt60 inside clamp band');
  const zeroAbs = sabineRt60(10, 0);
  const nanIn = sabineRt60(NaN, 5);
  const huge = sabineRt60(1e9, 1);
  ok(zeroAbs === MIN_RT60_SEC && nanIn === MIN_RT60_SEC && huge > MAX_RT60_SEC,
    'sabineRt60 floors junk ratios, leaves ceiling to descriptors');
  const giant = computeDescriptor({ id: 'g', bounds: { min: [0, 0, 0], max: [1e4, 1e4, 1e4] }, material: 'concrete' });
  ok(giant.rt60Sec === MAX_RT60_SEC, 'computeDescriptor clamps pathological halls to MAX_RT60_SEC');
}

// ---------------------------------------------------------------------------
console.log('2. Material table honored');
{
  const entries = Object.entries(MATERIAL_ABSORPTION)
    .sort(([, a], [, b]) => b - a); // most absorptive first
  let prev = -Infinity;
  let strict = true;
  for (const [mat] of entries) {
    const d = computeDescriptor(cube('m-' + mat, 6, mat));
    if (d.rt60Sec <= prev) strict = false;
    prev = d.rt60Sec;
  }
  ok(strict && entries.length >= 4, `more absorptive materials ring shorter (${entries.map(([m]) => m).join(' > ')})`);
  const b = { min: [0, 0, 0], max: [6, 6, 6] };
  const area = boundsSurfaceArea(b);
  let tableExact = true;
  for (const [mat, alpha] of Object.entries(MATERIAL_ABSORPTION)) {
    const d = computeDescriptor({ id: 'x', bounds: b, material: mat });
    // V = side³, A = area × coefficient (single material on all faces).
    const expect = Math.min(MAX_RT60_SEC, SABINE_CONSTANT * 216 / (area * alpha));
    if (!near(d.rt60Sec, expect, 1e-9)) tableExact = false;
  }
  ok(tableExact, 'every material honored via its exact table coefficient');
}

// ---------------------------------------------------------------------------
console.log('3. Convolver-ready descriptors');
{
  const d = computeDescriptor({ id: 'hall', bounds: { min: [-10, 0, -3], max: [10, 4, 3] }, material: 'concrete' });
  const dx = 20, dy = 4, dz = 6;
  const expectDelays = [2 * dy / SPEED_OF_SOUND_MPS, 2 * dz / SPEED_OF_SOUND_MPS, 2 * dx / SPEED_OF_SOUND_MPS].sort((a, b) => a - b);
  ok(
    d.earlyDelaysSec.length === 3 &&
    d.earlyDelaysSec.every((v, i) => near(v, expectDelays[i], 1e-12)),
    'early delays are the three first-order 2d/c pairs, ascending',
  );
  ok(
    d.wetGain >= 0 && d.wetGain <= 1 && near(d.wetGain, Math.min(1, d.rt60Sec / 2), 1e-12),
    'wetGain in 0..1 scaled from rt60',
  );
  const short = computeDescriptor(cube('s', 2, 'carpet'));
  const longR = computeDescriptor(cube('l', 14, 'concrete'));
  ok(longR.wetGain > short.wetGain, 'longer rooms suggest wetter mixes');
  const bl = blendDescriptors(short, longR, 0.5);
  ok(
    bl.roomId === '' &&
    near(bl.rt60Sec, (short.rt60Sec + longR.rt60Sec) / 2, 1e-12) &&
    near(bl.wetGain, (short.wetGain + longR.wetGain) / 2, 1e-12),
    'blendDescriptors lerps endpoints linearly at t=0.5',
  );
  ok(
    near(blendDescriptors(short, longR, -3).rt60Sec, short.rt60Sec, 1e-12) &&
    near(blendDescriptors(short, longR, 7).rt60Sec, longR.rt60Sec, 1e-12),
    'blend t clamps to endpoints',
  );
}

// ---------------------------------------------------------------------------
console.log('4. Reverb-zone transition (exactly one blended fade within tau±10%)');
{
  const rooms = [cube('A', 4, 'carpet'), { ...cube('B', 16, 'concrete'), bounds: { min: [4, 0, 0], max: [20, 16, 16] } }];
  const rev = new OccReverb(rooms);
  const dt = 1 / 120;
  const out0 = rev.update([2, 2, 2], 0);
  ok(out0.roomId === 'A' && out0.transition === null && !out0.transitionCompleted, 'initial pose resolves without transition');
  let bursts = 0;
  let completions = 0;
  let completeAt = -1;
  let sawBlend = false;
  let blendMonotone = true;
  let prevRt = null;
  let prevFade = null;
  let t = 0;
  while (t < 2.0) {
    t += dt;
    // Step across the shared wall at x=4 halfway through the window.
    const x = t < 1 ? 2 : 5;
    const o = rev.update([x, 2, 2], t);
    if (o.transition !== null) {
      // Count distinct fade objects, not updates that still see one.
      if (o.transition !== prevFade) { bursts++; prevFade = o.transition; }
      const r = o.descriptor.rt60Sec;
      if (prevRt !== null && r < prevRt - 1e-12) blendMonotone = false;
      prevRt = r;
      if (r > o.transition.from.rt60Sec) sawBlend = true;
    } else {
      prevFade = null;
    }
    if (o.transitionCompleted) { completions++; completeAt = t; }
  }
  ok(bursts === 1, `exactly one transition object across the crossing (${bursts})`);
  ok(completions === 1, `transition completes exactly once (${completions})`);
  const dur = completeAt - 1; // crossing happened at t=1
  ok(
    dur >= TRANSITION_TAU_SEC * (1 - TAU_TOLERANCE) && dur <= TRANSITION_TAU_SEC * (1 + TAU_TOLERANCE),
    `completion within tau±10% (took ${dur.toFixed(3)}s vs tau ${TRANSITION_TAU_SEC})`,
  );
  ok(blendMonotone && sawBlend, 'blended rt60 moves monotonically toward the incoming room');
  const after = rev.update([5, 2, 2], 2.01);
  ok(
    after.roomId === 'B' && after.transition === null &&
    near(after.descriptor.rt60Sec, rev.descriptorFor('B').rt60Sec, 1e-12),
    'post-fade output is purely the new room descriptor',
  );
  // Mid-fade retarget: A -> B -> C must not open a second fade.
  const rooms3 = [
    cube('A', 4, 'carpet'),
    { id: 'B', bounds: { min: [4, 0, 0], max: [8, 4, 4] }, material: 'tile' },
    { id: 'C', bounds: { min: [8, 0, 0], max: [12, 4, 4] }, material: 'concrete' },
  ];
  const rev3 = new OccReverb(rooms3);
  rev3.update([2, 2, 2], 0);
  const t1 = rev3.update([5, 2, 2], 0.1);
  const t2 = rev3.update([9, 2, 2], 0.2);
  ok(t1.transition !== null, 'first crossing opens a fade');
  ok(
    t2.transition !== null && t2.transition === t1.transition &&
    t2.transition.to === rev3.descriptorFor('C') &&
    near(t2.transition.startSec, 0.1, 1e-12),
    'second crossing retargets the SAME fade (no stack)',
  );
  ok(rev3.activeTransition() !== null, 'activeTransition() exposes the live fade');
}

// ---------------------------------------------------------------------------
console.log('5. Determinism');
{
  const mk = () => [cube('a', 3, 'carpet'), cube('b', 9, 'concrete', 3)];
  const r1 = new OccReverb(mk());
  const r2 = new OccReverb(mk());
  const seq = [];
  let t = 0;
  for (let i = 0; i < 240; i++) {
    t += 1 / 60;
    const x = 1.5 + (i % 120) * 0.05;
    const o1 = r1.update([x, 1, 1], t);
    const o2 = r2.update([x, 1, 1], t);
    seq.push(
      JSON.stringify(o1.descriptor) === JSON.stringify(o2.descriptor) &&
      JSON.stringify(o1.transition) === JSON.stringify(o2.transition) &&
      o1.transitionCompleted === o2.transitionCompleted,
    );
  }
  ok(seq.every(Boolean), 'two identically-injected models replay byte-identical streams');
}

// ---------------------------------------------------------------------------
console.log('6. Junk inputs safe');
{
  const rev = new OccReverb([cube('ok', 4, 'tile'), { id: 'bad', bounds: { min: [0, 0, 0], max: [NaN, 1, 1] }, material: 'tile' }]);
  ok(!rev.roomIds.includes('bad'), 'degenerate-bounds room dropped at injection');
  try {
    new OccReverb([cube('dup', 1), cube('dup', 2)]);
    ok(false, 'duplicate ids fail loud');
  } catch { ok(true, 'duplicate ids fail loud'); }
  const oNaN = rev.update([NaN, 0, 0], 0);
  ok(oNaN.roomId === null && oNaN.descriptor === null, 'NaN position resolves nowhere safely');
  const oOut = rev.update([999, 999, 999], 0);
  ok(oOut.roomId === null && oOut.descriptor === null && oOut.transition === null, 'outside-every-room pose yields nulls');
  const backIn = rev.update([2, 2, 2], 1);
  ok(backIn.roomId === 'ok', 'returning indoors re-resolves cleanly');
  const unknownMat = computeDescriptor({ id: 'u', bounds: { min: [0, 0, 0], max: [2, 2, 2] }, material: 'unobtainium' });
  const fallbackMat = computeDescriptor({ id: 'f', bounds: { min: [0, 0, 0], max: [2, 2, 2] }, material: 'tile' });
  ok(near(unknownMat.rt60Sec, fallbackMat.rt60Sec, 1e-12), 'unknown material falls back to tile absorption');
  ok(boundsContain({ min: [0, 0, 0], max: [1, 1, 1] }, [Infinity, 0, 0]) === false, 'infinite coordinates are never contained');
  ok(boundsValid({ min: [0, 0, 0], max: [1, 1, Infinity] }) === false, 'non-finite extents rejected by boundsValid');
  ok(boundsVolume({ min: [0, 0, 0], max: [2, 2, 2] }) === 8 && boundsSurfaceArea({ min: [0, 0, 0], max: [2, 2, 2] }) === 24, 'geometry helpers exact on unit case');
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? `OCCREVERB ALL PASS (${check} checks)` : `OCCREVERB FAILURES: ${failures}/${check}`);
process.exit(failures === 0 ? 0 : 1);
