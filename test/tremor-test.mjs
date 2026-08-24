/**
 * Low-battery hand tremor tests (F72) - pure Node, no rendering.
 * Verifies the F72 acceptance proof: wobble amplitude ramps monotonically
 * from the 0.20 threshold down to full strength at 0.05 and stays bounded
 * there; output is exactly zero at or above the threshold on both axes;
 * offsets stay inside their bounds over 5000 ticks fed junk dt values;
 * offsets are a pure function of (tick, seed, battery) so any dt stream
 * reaching the same ticks replays byte-identically; reset() restores the
 * birth state exactly.
 * Run: node test/tremor-test.mjs  (prints ALL PASS, exits 0)
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
  HandTremor, tremorAt, tremorStrength, tremorNoiseAt,
  TREMOR_THRESHOLD, FULL_TREMOR_BATTERY, MAX_YAW_RAD, MAX_PITCH_RAD,
} = await import('../src/player/tremor.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const EPS = 1e-12;

/** Sweep of charge levels from full down past dead, including junk reads. */
const BATTERY_SWEEP = [];
for (let i = 20; i >= -5; i--) BATTERY_SWEEP.push(i / 100);

// --- 1. exact zero at or above the threshold ----------------------------------
console.log('[steady above threshold]');
{
  ok(tremorStrength(TREMOR_THRESHOLD) === 0 &&
     tremorStrength(0.5) === 0 &&
     tremorStrength(1) === 0,
     `strength is exactly 0 for battery >= ${TREMOR_THRESHOLD}`);

  let allZero = true;
  const t = new HandTremor(99);
  for (let i = 0; i < 2000; i++) {
    const o = t.update(1 / 60, i % 3 === 0 ? TREMOR_THRESHOLD : 0.87);
    if (o.yawRad !== 0 || o.pitchRad !== 0) { allZero = false; break; }
  }
  ok(allZero, '2000 ticks at healthy/threshold charge -> both axes exactly 0');

  ok(tremorAt(0.25, 12345, 7).yawRad === 0 && tremorAt(0.25, 12345, 7).pitchRad === 0,
     'pure sample also zero above threshold');
}

// --- 2. monotone ramp across the sweep ----------------------------------------
console.log('[monotone ramp]');
{
  let prev = -Infinity;
  let monotone = true;
  const trace = [];
  for (const b of [...BATTERY_SWEEP].sort((x, y) => y - x)) {
    const s = tremorStrength(b);
    trace.push(`${b}:${s.toFixed(3)}`);
    if (s < prev - EPS) monotone = false;
    prev = s;
  }
  ok(monotone,
    `strength non-decreasing as charge falls across ${BATTERY_SWEEP.length}-point sweep ` +
    `(first ${trace[0]}, last ${trace[trace.length - 1]})`);

  ok(tremorStrength(FULL_TREMOR_BATTERY) === 1 &&
     tremorStrength(0) === 1 &&
     tremorStrength(-0.01) === 1,
     `full amplitude reached at ${FULL_TREMOR_BATTERY} and held bounded below it`);
  const mid = (TREMOR_THRESHOLD + FULL_TREMOR_BATTERY) / 2;
  ok(Math.abs(tremorStrength(mid) - 0.5) < EPS,
    'ramp is linear: midpoint charge gives strength 0.5');
}

// --- 3. bounds over 5000 ticks incl. junk dt -----------------------------------
console.log('[bounds]');
{
  const JUNK_DT = [1 / 60, NaN, -4.2, 1e15, Infinity, 0, 0.033];
  let inBounds = true;
  let worstYaw = 0, worstPitch = 0;
  const t = new HandTremor(2024);
  for (let i = 0; i < 5000; i++) {
    // cycle dead -> full and every junk dt in between
    const b = (i % 130) / 130 * 1.1 - 0.05;
    const o = t.update(JUNK_DT[i % JUNK_DT.length], b);
    worstYaw = Math.max(worstYaw, Math.abs(o.yawRad));
    worstPitch = Math.max(worstPitch, Math.abs(o.pitchRad));
    if (!(Math.abs(o.yawRad) <= MAX_YAW_RAD + EPS) ||
        !(Math.abs(o.pitchRad) <= MAX_PITCH_RAD + EPS) ||
        Number.isNaN(o.yawRad) || Number.isNaN(o.pitchRad)) { inBounds = false; break; }
  }
  ok(inBounds,
    `5000 junk-dt ticks stay within yaw +/-${MAX_YAW_RAD} pitch +/-${MAX_PITCH_RAD} rad ` +
    `(worst ${worstYaw.toFixed(5)} / ${worstPitch.toFixed(5)})`);
  ok(worstYaw > MAX_YAW_RAD * 0.9 || worstPitch > MAX_PITCH_RAD * 0.9,
    'the bound is actually exercised near its ceiling during the run');

  // pure samples are bounded too, across seeds and negative/odd ticks
  let pureOk = true;
  for (let seed = 0; seed < 8; seed++) {
    for (let tick = -50; tick < 500; tick += 7) {
      const o = tremorAt(0, tick, seed * 7919);
      if (Math.abs(o.yawRad) > MAX_YAW_RAD + EPS ||
          Math.abs(o.pitchRad) > MAX_PITCH_RAD + EPS) { pureOk = false; break; }
    }
  }
  ok(pureOk, 'pure tremorAt samples bounded across 8 seeds incl. negative ticks');
  ok(Math.abs(tremorNoiseAt(5, 11).yawRad) <= 1 &&
     Math.abs(tremorNoiseAt(5, 11).pitchRad) <= 1,
     'unit noise draws lie in [-1, 1] per axis');
}

// --- 4. tick-key determinism ----------------------------------------------------
console.log('[determinism]');
{
  const streamA = [], streamB = [], streamC = [];
  const a = new HandTremor(777), b = new HandTremor(777), c = new HandTremor(778);
  for (let i = 0; i < 600; i++) {
    const bat = ((i * 37) % 100) / 100;
    streamA.push(JSON.stringify(a.update(i % 2 ? 1 / 120 : 1 / 30, bat)));
    streamB.push(JSON.stringify(b.update(NaN, bat)));          // different dt stream
    streamC.push(JSON.stringify(c.update(1 / 60, bat)));
  }
  ok(streamA.join() === streamB.join(),
    'same seed + same batteries + different dt streams -> byte-identical offsets');
  ok(streamA.join() !== streamC.join(),
    'different seeds decorrelate the noise while sharing the ramp');

  // direct function-level proof: offset depends only on (tick, seed, battery)
  const p1 = JSON.stringify(tremorAt(0.12, 4096, 42));
  const p2 = JSON.stringify(tremorAt(0.12, 4096, 42));
  ok(p1 === p2 && p1 === JSON.stringify({ ...tremorNoiseAt(4096, 42),
    yawRad: tremorNoiseAt(4096, 42).yawRad * MAX_YAW_RAD * tremorStrength(0.12),
    pitchRad: tremorNoiseAt(4096, 42).pitchRad * MAX_PITCH_RAD * tremorStrength(0.12) }),
    'tremorAt == strength-scaled pure noise at the same tick/seed');

  // reset() restores birth state exactly
  const r = new HandTremor(314);
  const first = [];
  for (let i = 0; i < 300; i++) first.push(JSON.stringify(r.update(1 / 60, 0.08)));
  const after = [];
  r.reset();
  ok(r.tick === 0, 'reset() zeroes the tick counter');
  for (let i = 0; i < 300; i++) after.push(JSON.stringify(r.update(1 / 60, 0.08)));
  ok(first.join() === after.join(), 'post-reset replay byte-identical');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
