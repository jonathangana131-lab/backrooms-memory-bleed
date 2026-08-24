/**
 * Cold-storage shiver tests (F76) - pure Node, no rendering.
 * Verifies the F76 acceptance proof: AC zone gating (chatter only under
 * injected cold temperature classes), entry/exit ramp shapes sampled,
 * chatter frequency measured within tolerance over 10 s, exact fixed
 * view-shiver coupling ratio, seeded determinism, and junk-dt safety.
 * Run: node test/shiver-test.mjs  (prints ALL PASS, exits 0)
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
  ColdShiver, temperatureAt, jitteredPeriodS, BASE_CHATTER_HZ,
  CHATTER_JITTER_FRACTION, VIEW_SHIVER_RATIO, RAMP_IN_S, RAMP_OUT_S,
} = await import('../src/player/shiver.ts');
const { RNG } = await import('../src/core/rng.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
};

const DT = 1 / 480;

/** Cold zone centered under the player at the origin. */
const coldAtOrigin = [{ x: 0, z: 0, radius: 5, temperature: 'cold' }];

/**
 * Drive a fresh shiver with a per-tick temperature class chosen by
 * `temp(t)` and return every computed sample with its tick time.
 */
function run(temp, horizonS, seed = 1234, dt = DT) {
  const s = new ColdShiver(seed);
  const out = [];
  let t = 0;
  while (t < horizonS - dt / 2) {
    s.updateTemp(dt, temp(t));
    out.push({ t: t + dt, ...s.sample });
    t += dt;
  }
  return out;
}

// --- 1. AC zone gating -----------------------------------------------------------
console.log('[zone gating]');
{
  const temperate = run(() => 'temperate', 60);
  ok(temperate.every((s) => s.chatter === 0 && s.viewShiverAmp === 0),
    'zero exactly outside cold zones over 60 s of temperate class');

  const cold = run(() => 'cold', 30);
  const peakIn = Math.max(...cold.map((s) => s.chatter));
  ok(peakIn > 0.99, `full-drive chatter reached inside cold class (peak ${peakIn.toFixed(4)})`);

  // position-based gating against injected zones
  const shiver = new ColdShiver(7, coldAtOrigin);
  for (let i = 0; i < 960; i++) shiver.update(DT, 0, 0); // 2 s inside
  const insidePeak = shiver.sample.chatter;
  for (let i = 0; i < Math.ceil(RAMP_OUT_S / DT); i++) shiver.update(DT, 100, 100);
  ok(insidePeak > 0 && shiver.sample.chatter === 0,
    'position leaves every zone -> drive decays to exactly zero');

  ok(temperatureAt(coldAtOrigin, 4.9, 0) === 'cold'
    && temperatureAt(coldAtOrigin, 5.1, 0) === 'temperate'
    && temperatureAt([{ x: 0, z: 0, radius: 5, temperature: 'temperate' }], 0, 0) === 'temperate'
    && temperatureAt([], 0, 0) === 'temperate',
    'temperatureAt: containment inside cold wins; edge/outside/temperate/empty -> temperate');

  // cycling in/out never leaks: bounded envelope under repeated entries/exits
  const cycle = run((t) => (Math.floor(t / 2) % 2 === 0 ? 'cold' : 'temperate'), 40);
  ok(cycle.every((s) => s.chatter >= 0 && s.chatter <= 1),
    'cycled gating keeps the envelope inside [0, 1]');
}

// --- 2. entry/exit ramp shapes sampled --------------------------------------------
console.log('[ramp shapes]');
{
  // Entry: running peak tracks the linear drive ramp t/RAMP_IN_S. The peak
  // lands within one jittered cycle (~0.18 s) of the analytic line, so the
  // lower tolerance absorbs that sampling lag; a short hold past RAMP_IN_S
  // lets one full cycle complete at full drive.
  const CYCLE_LAG = 0.11;
  const HOLD_S = 0.25;
  const inRun = run(() => 'cold', RAMP_IN_S + HOLD_S);
  let peak = 0;
  let shapeOK = true;
  for (const s of inRun) {
    if (s.chatter > peak) peak = s.chatter;
    if (s.t > RAMP_IN_S) continue;
    const expected = Math.min(1, s.t / RAMP_IN_S);
    if (peak > expected + 1e-6 || peak < expected - CYCLE_LAG - 1e-6) shapeOK = false;
  }
  ok(shapeOK,
    `entry ramp sampled linear across the ${RAMP_IN_S}s climb`);
  ok(peak >= 1 - 1e-3,
    `full drive reached once a cycle completes at saturation (peak ${peak.toFixed(4)})`);

  // Exit: after saturation the envelope may never exceed the linear decay
  // 1 - elapsed/RAMP_OUT_S, decays through mid-band, and lands exactly zero.
  const total = RAMP_IN_S + RAMP_OUT_S + 0.5;
  const exitRun = run((t) => (t < RAMP_IN_S ? 'cold' : 'temperate'), total);
  let boundedOK = true;
  let localMidPeak = 0;
  for (const s of exitRun) {
    if (s.t <= RAMP_IN_S) continue;
    const elapsed = s.t - RAMP_IN_S;
    const expected = Math.max(0, 1 - elapsed / RAMP_OUT_S);
    if (s.chatter > expected + 1e-9) boundedOK = false;
    if (elapsed > 1.25 && elapsed < 1.75 && s.chatter > localMidPeak) localMidPeak = s.chatter;
  }
  const tail = exitRun[exitRun.length - 1];
  ok(boundedOK, 'every post-exit sample sits under the linear decay curve');
  ok(localMidPeak > 0.4 && localMidPeak < 0.58,
    `decay passes through the mid-band around 50% drive (local peak ${localMidPeak.toFixed(3)})`);
  ok(tail.chatter === 0 && tail.viewShiverAmp === 0,
    `output is exactly zero once the ${RAMP_OUT_S}s exit ramp has decayed`);
}

// --- 3. chatter frequency measured over 10 s ---------------------------------------
console.log('[chatter frequency]');
{
  const MEASURE_S = 10;
  const TOL_HZ = BASE_CHATTER_HZ * CHATTER_JITTER_FRACTION + 0.15;
  const trace = [];
  let allWithin = true;
  for (const seed of [1234, 42, 90210, 777]) {
    const samples = run(() => 'cold', RAMP_IN_S + MEASURE_S, seed)
      .filter((s) => s.t > RAMP_IN_S);
    let cycles = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1].chatter < 0.5 && samples[i].chatter >= 0.5) cycles++;
    }
    const hz = cycles / MEASURE_S;
    trace.push(`seed${seed}:${hz.toFixed(2)}Hz`);
    if (Math.abs(hz - BASE_CHATTER_HZ) > TOL_HZ) allWithin = false;
  }
  ok(allWithin,
    `measured chatter rate within ${BASE_CHATTER_HZ}+/-${TOL_HZ.toFixed(2)}Hz across seeds `
    + `(${trace.join(', ')})`);

  // seeded period draws respect the +/- jitter band and consume one rng.next()
  let lo = Infinity, hi = -Infinity;
  const rng = new RNG(0x5417e2);
  for (let i = 0; i < 2000; i++) {
    const p = jitteredPeriodS(rng);
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  const base = 1 / BASE_CHATTER_HZ;
  ok(lo >= base * (1 - CHATTER_JITTER_FRACTION) - 1e-12
    && hi <= base * (1 + CHATTER_JITTER_FRACTION) + 1e-12
    && lo < base && hi > base,
    `2000 period draws span both sides of the +/-${CHATTER_JITTER_FRACTION * 100}% band `
    + `(${lo.toFixed(4)}..${hi.toFixed(4)}s around ${base.toFixed(4)}s)`);
  const a = new RNG(77), b = new RNG(77);
  const pa = jitteredPeriodS(a), pb = b.next();
  ok(Math.abs(pa - base * (1 + (pb * 2 - 1) * CHATTER_JITTER_FRACTION)) < 1e-12,
    'each period draw consumes exactly one rng.next() step');
}

// --- 4. coupling ratio exact --------------------------------------------------------
console.log('[coupling ratio]');
{
  const mixed = run((t) => (Math.floor(t / 3) % 2 === 0 ? 'cold' : 'temperate'), 30);
  ok(mixed.every((s) => s.viewShiverAmp === s.chatter * VIEW_SHIVER_RATIO),
    `viewShiverAmp === chatter * ${VIEW_SHIVER_RATIO} on every sample of a mixed 30 s run`);
  const cold = run(() => 'cold', 10);
  ok(cold.some((s) => s.chatter > 0 && s.viewShiverAmp > 0),
    'nonzero chatter carries nonzero view shiver');
}

// --- 5. determinism ------------------------------------------------------------------
console.log('[determinism]');
{
  const temp = (t) => (Math.floor(t / 7) % 2 === 0 ? 'cold' : 'temperate');
  const a = JSON.stringify(run(temp, 45, 31415));
  const b = JSON.stringify(run(temp, 45, 31415));
  ok(a === b && a.length > 1000, 'same seed + timeline -> byte-identical sample stream');
  const c = JSON.stringify(run(temp, 45, 27182));
  ok(a !== c, 'different seeds decorrelate the chatter phase stream');
}

// --- 6. junk-dt safety -----------------------------------------------------------------
console.log('[junk dt]');
{
  const clean = new ColdShiver(555);
  const junky = new ColdShiver(555);
  for (const bad of [NaN, Infinity, -Infinity, -DT, 0]) junky.updateTemp(bad, 'cold');
  ok(JSON.stringify(junky.sample) === JSON.stringify(clean.sample),
    'NaN/infinite/negative/zero dt leave the state untouched');
  // A junk frame must be a pure no-op: interleaving extra junk between the
  // same valid ticks equals the clean timeline.
  const steadyA = new ColdShiver(556);
  const steadyB = new ColdShiver(556);
  for (let i = 0; i < 1200; i++) {
    if (i % 2 === 1) steadyB.updateTemp(NaN, 'cold'); // extra junk frame
    steadyA.updateTemp(DT, 'cold');
    steadyB.updateTemp(DT, 'cold');
  }
  ok(JSON.stringify(steadyA.sample) === JSON.stringify(steadyB.sample),
    'interleaved junk frames behave exactly as skipped frames (no corruption, no drift)');
}

// --- 7. purity --------------------------------------------------------------------------
console.log('[purity]');
{
  const src = readFileSync(path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'player', 'shiver.ts'), 'utf8');
  ok(!src.includes('Math.random'), 'module contains no unseeded randomness at all');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
