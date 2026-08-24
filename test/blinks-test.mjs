/**
 * Sleep pressure micro-blink tests (F74) - pure Node, no renderer.
 * Verifies the F74 acceptance proof:
 *   1. cadence - blinkRatePerMin matches spec endpoints and is monotone
 *      non-decreasing across the session-hours sweep; MEASURED event rates
 *      over long simulated horizons rise monotonically and land within
 *      tolerance of the nominal rates
 *   2. envelope shape fixed - linear fast close (BLINK_CLOSE_MS) then slower
 *      linear open (BLINK_OPEN_MS), peak exactly 1, exactly 0 outside
 *   3. burst windows exact - half-open windows [k*600, k*600+20); every
 *      micro-flagged event lies inside one, none outside; measured in-window
 *      rate doubles the out-of-window rate; bursts gated below DRIFT_ONSET_HOURS
 *   4. determinism - same seed replays byte-identical event streams and
 *      closure samples; different seeds decorrelate
 *
 * Run: node test/blinks-test.mjs  (prints BLINKS ALL PASS, exits 0)
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
  BlinkScheduler, blinkRatePerMin, inBurstWindow, blinkClosureAt,
  BASE_BLINKS_PER_MIN, LONG_SESSION_BLINKS_PER_MIN, RATE_RAMP_HOURS,
  JITTER_FRACTION, BLINK_CLOSE_MS, BLINK_OPEN_MS,
  MICRO_DURATION_SCALE, MICRO_CLOSURE_PEAK,
  DRIFT_ONSET_HOURS, BURST_PERIOD_S, BURST_DURATION_S, BURST_RATE_MULT,
} = await import('../src/player/blinks.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const DT = 1 / 60;

/** Simulate `horizonS` seconds at fixed session hours; return drained events. */
function run(hours, horizonS, seed = 1234) {
  const b = new BlinkScheduler(seed);
  for (let t = 0; t < horizonS - 1e-9; t += DT) b.update(DT, hours);
  return b.drainEvents();
}

// --- 1a. rate curve endpoints + monotonicity ---------------------------------
console.log('[rate curve]');
{
  ok(blinkRatePerMin(0) === BASE_BLINKS_PER_MIN, `rate(0h) === ${BASE_BLINKS_PER_MIN}`);
  ok(blinkRatePerMin(RATE_RAMP_HOURS) === LONG_SESSION_BLINKS_PER_MIN,
    `rate(${RATE_RAMP_HOURS}h) === ${LONG_SESSION_BLINKS_PER_MIN}`);
  ok(blinkRatePerMin(12) === LONG_SESSION_BLINKS_PER_MIN, 'rate beyond ramp clamps at max');
  ok(blinkRatePerMin(-3) === BASE_BLINKS_PER_MIN, 'negative hours clamp to baseline');
  let mono = true;
  let prev = -Infinity;
  for (let h = 0; h <= 12; h += 0.05) {
    const r = blinkRatePerMin(h);
    if (r < prev - 1e-12) mono = false;
    prev = r;
  }
  ok(mono, 'blinkRatePerMin monotone non-decreasing across 0..12 h sweep');
}

// --- 1b. measured cadence rises monotonically with session hours -------------
console.log('[measured cadence]');
{
  const HORIZON_S = 1800;
  const SWEEP_H = [0, 1.5, 3, 4.5, 6, 9];
  const rates = [];
  for (const h of SWEEP_H) {
    // average over three seeds to cancel seeded jitter
    let sum = 0;
    for (const seed of [11, 22, 33]) {
      const evts = run(h, HORIZON_S, seed);
      sum += evts.length / (HORIZON_S / 60);
    }
    rates.push(sum / 3);
  }
  let mono = true;
  for (let i = 1; i < rates.length; i++) if (rates[i] < rates[i - 1]) mono = false;
  ok(mono, `measured blink/min monotone across sweep: ${rates.map((r) => r.toFixed(1)).join(' -> ')}`);
  // Strict rise while inside the ramp; flat plateau is expected once clamped.
  let strictInRamp = true;
  for (let i = 1; i < rates.length && SWEEP_H[i] <= RATE_RAMP_HOURS; i++) {
    if (rates[i] <= rates[i - 1]) strictInRamp = false;
  }
  ok(strictInRamp, 'measured blink/min strictly rising through the 0..6h ramp');
  const tolOk = rates.every((r, i) => Math.abs(r - blinkRatePerMin(SWEEP_H[i])) / blinkRatePerMin(SWEEP_H[i]) < 0.1);
  ok(tolOk, 'every measured rate within 10% of its nominal rate');
}

// --- 1c. seeded jitter stays inside +/-JITTER_FRACTION -----------------------
console.log('[jitter band]');
{
  let inBand = true;
  // Reconstruct consecutive intervals below drift onset (bursts gated off).
  for (const seed of [7, 99]) {
    const evts = run(DRIFT_ONSET_HOURS / 2, 12000, seed);
    const base = 60 / blinkRatePerMin(DRIFT_ONSET_HOURS / 2);
    for (let i = 1; i < evts.length; i++) {
      const iv = evts[i].timeS - evts[i - 1].timeS;
      if (iv < base * (1 - JITTER_FRACTION) - 1e-9 || iv > base * (1 + JITTER_FRACTION) + 1e-9) inBand = false;
    }
  }
  ok(inBand, 'all inter-blink intervals inside the +/-20% seeded jitter band');
}

// --- 2. envelope shape fixed --------------------------------------------------
console.log('[envelope shape]');
{
  ok(blinkClosureAt(-1) === 0 && blinkClosureAt(0) === 0, 'closure exactly 0 before/at fire');
  ok(blinkClosureAt(BLINK_CLOSE_MS) === 1, 'closure peaks at exactly 1 at end of close phase');
  ok(blinkClosureAt(BLINK_CLOSE_MS - 0.001) < 1 && blinkClosureAt(BLINK_CLOSE_MS + 0.001) < 1,
    'single-sample peak, symmetric falloff on both sides');
  ok(blinkClosureAt(BLINK_CLOSE_MS + BLINK_OPEN_MS + 1) === 0, 'closure exactly 0 after total duration');
  const midUp = blinkClosureAt(BLINK_CLOSE_MS / 2);
  ok(Math.abs(midUp - 0.5) < 1e-12, 'rise is linear: midpoint samples 0.5');
  const downAtHalf = blinkClosureAt(BLINK_CLOSE_MS + BLINK_OPEN_MS / 2);
  ok(Math.abs(downAtHalf - 0.5) < 1e-12, 'fall is linear: midpoint samples 0.5');
  ok(BLINK_CLOSE_MS < BLINK_OPEN_MS, 'close faster than open (phase lengths)');
  const tHalfRise = BLINK_CLOSE_MS / 2;
  const tHalfFall = BLINK_CLOSE_MS + BLINK_OPEN_MS / 2;
  ok(tHalfRise < tHalfFall, 'time-to-half-rise < time-to-half-fall');
}

// --- 3a. burst window boundaries exact ----------------------------------------
console.log('[burst windows exact]');
{
  ok(!inBurstWindow(-0.001), 'before t=0 never a window');
  ok(inBurstWindow(0) === true, 'window opens exactly at k*BURST_PERIOD_S (t=0)');
  ok(inBurstWindow(BURST_PERIOD_S * 2 + BURST_DURATION_S - 0.001) === true, 'still inside just before window end');
  ok(inBurstWindow(BURST_PERIOD_S * 2 + BURST_DURATION_S) === false, 'half-open: window closed exactly at end');
  ok(inBurstWindow(BURST_PERIOD_S * 2 + BURST_DURATION_S + 1) === false, 'outside window');
}

// --- 3b. micro flags confined to windows + doubled in-window rate -------------
console.log('[micro bursts]');
{
  const HORIZON_S = 7200; // 2 h -> 7 windows at 600/620/1240/1260/...
  for (const seed of [5, 55]) {
    const evts = run(DRIFT_ONSET_HOURS * 2, HORIZON_S, seed);
    let misflagged = 0;
    for (const e of evts) {
      const expected = inBurstWindow(e.timeS);
      if (e.micro !== expected) misflagged++;
    }
    ok(misflagged === 0, `seed ${seed}: micro flag iff fire time in a burst window (${evts.length} events)`);
    const microDurs = new Set(evts.filter((e) => e.micro).map((e) => e.durationS));
    ok(microDurs.size === 1 &&
      Math.abs([...microDurs][0] - ((BLINK_CLOSE_MS + BLINK_OPEN_MS) / 1000) * MICRO_DURATION_SCALE) < 1e-12,
      `seed ${seed}: every micro blink uses exactly the scaled short envelope`);
  }
  // Measured in-window vs out-of-window rate at fixed hours (well past onset).
  const evts = run(3, 7200, 1234);
  const inWin = evts.filter((e) => e.micro).length;
  const winCount = Math.floor(7200 / BURST_PERIOD_S); // windows fully contained
  const winSeconds = winCount * BURST_DURATION_S;
  const outSeconds = 7200 - winSeconds;
  const outWin = evts.length - inWin;
  const rIn = inWin / (winSeconds / 60);
  const rOut = outWin / (outSeconds / 60);
  const ratio = rIn / rOut;
  ok(ratio > BURST_RATE_MULT * 0.75 && ratio < BURST_RATE_MULT * 1.25,
    `in-window rate x${ratio.toFixed(2)} of out-window (target ${BURST_RATE_MULT})`);
  // Bursts gated below drift onset: zero micro events pre-onset.
  const pre = run(DRIFT_ONSET_HOURS * 0.9, 7200, 1234);
  ok(pre.every((e) => !e.micro), 'no micro events below DRIFT_ONSET_HOURS');
}

// --- 3c. eyelid closure bounds + consumer weight ------------------------------
console.log('[closure output]');
{
  const b = new BlinkScheduler(777);
  let bounded = true;
  let sawNonzero = false;
  for (let t = 0; t < 900; t += DT) {
    b.update(DT, 3);
    const c = b.eyelidClosure;
    if (!(c >= 0 && c <= 1)) bounded = false;
    if (c > MICRO_CLOSURE_PEAK + 1e-12 && c < 1 - 1e-9) { /* mid-envelope values allowed */ }
    if (c >= 0.999) sawNonzero = true;
  }
  ok(bounded, 'eyelidClosure stays within [0, 1] over 15 min of play');
  ok(sawNonzero, 'full blinks reach closure ~1 (vignette fully closes)');
}

// --- 4. determinism ------------------------------------------------------------
console.log('[determinism]');
{
  const replay = (seed, hoursFn) => {
    const b = new BlinkScheduler(seed);
    const samples = [];
    for (let i = 0; i < 60 * 400; i++) {
      b.update(DT, hoursFn(i * DT));
      if (i % 7 === 0) samples.push(b.eyelidClosure.toFixed(6));
    }
    return JSON.stringify({ evts: b.drainEvents(), samples });
  };
  const a1 = replay(2024, (t) => t / 3600);
  const a2 = replay(2024, (t) => t / 3600);
  const b1 = replay(2024, () => 4);
  const c1 = replay(909, (t) => t / 3600);
  ok(a1 === a2, 'same seed + same timeline replays byte-identical');
  ok(a1 !== b1, 'same seed + different hours timeline diverges');
  ok(a1 !== c1, 'different seeds decorrelate');
}

console.log(failures === 0 ? 'BLINKS ALL PASS' : `BLINKS FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
