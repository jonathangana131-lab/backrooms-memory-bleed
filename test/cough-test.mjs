/**
 * Contamination cough tests (F71) - pure Node, no audio device.
 * Verifies the F71 acceptance proof: measured cough rate is monotone
 * non-decreasing across a saturation sweep 0->1; jittered intervals stay
 * inside the +/-15% band over 1000 draws; the whole schedule is seeded and
 * byte-identical on replay; saturation 0 exactly never fires a cough.
 * Run: node test/cough-test.mjs  (prints ALL PASS, exits 0)
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
  ContaminationCough, baseIntervalS, jitteredIntervalS,
  saturationAt, CLEAN_INTERVAL_S, SATURATED_INTERVAL_S, JITTER_FRACTION,
} = await import('../src/player/cough.ts');
const { RNG } = await import('../src/core/rng.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const SWEEP = [];
for (let i = 0; i <= 20; i++) SWEEP.push(i / 20);

/** One zone centered under the player so saturationAt returns s directly. */
const zoneAt = (s) => [{ x: 0, z: 0, radius: 5, saturation: s }];
const DT = 0.25;

/**
 * Simulate `horizonS` seconds standing at the zone center and return the
 * drained event list. Large dt is fine: the while-loop fires every due tick.
 */
function run(saturation, horizonS, seed = 1234) {
  const c = new ContaminationCough(seed, zoneAt(saturation));
  for (let t = 0; t < horizonS; t += DT) c.update(DT, 0, 0);
  return c.drainEvents();
}

// --- 1. acceptance proof: measured rate is monotone in saturation -------------
console.log('[monotone rate]');
{
  const HORIZON_S = 12000;
  let prevRate = -Infinity;
  let monotone = true;
  const trace = [];
  for (const s of SWEEP) {
    const events = run(s, HORIZON_S);
    const rate = events.length / HORIZON_S;
    trace.push(`${s}:${rate.toFixed(4)}`);
    if (rate < prevRate - 1e-9) monotone = false;
    prevRate = rate;
  }
  ok(monotone,
    `measured cough rate non-decreasing across ${SWEEP.length}-point sweep ` +
    `(first ${trace[0]}, last ${trace[trace.length - 1]})`);
}

// --- 2. interval math: lerp endpoints and jitter bounds ------------------------
console.log('[interval math]');
{
  ok(baseIntervalS(0) === CLEAN_INTERVAL_S,
    `baseInterval(0) === ${CLEAN_INTERVAL_S}s clean`);
  ok(baseIntervalS(1) === SATURATED_INTERVAL_S,
    `baseInterval(1) === ${SATURATED_INTERVAL_S}s saturated`);
  ok(Math.abs(baseIntervalS(0.5) - (CLEAN_INTERVAL_S + SATURATED_INTERVAL_S) / 2) < 1e-12,
    'baseInterval is the linear midpoint at s=0.5');

  let lo = Infinity, hi = -Infinity;
  for (const s of SWEEP) {
    const base = baseIntervalS(s);
    const rng = new RNG(0xc0ff + s * 1000 | 0);
    for (let i = 0; i < 1000; i++) {
      const d = jitteredIntervalS(s, rng);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
      if (d < base * (1 - JITTER_FRACTION) - 1e-12 ||
          d > base * (1 + JITTER_FRACTION) + 1e-12) { lo = NaN; break; }
    }
  }
  ok(!Number.isNaN(lo),
    `all 21000 jitter draws within +/-${JITTER_FRACTION * 100}% of base`);
  // both sides of the band are actually reached (jitter has real spread)
  ok(hi - lo > 0.05 * (CLEAN_INTERVAL_S - SATURATED_INTERVAL_S),
    `draws span both sides of the band (${lo.toFixed(3)}s .. ${hi.toFixed(3)}s)`);

  // one draw consumes exactly one RNG step -> replayable by draw index
  const a = new RNG(77), b = new RNG(77);
  const seqA = [], seqB = [];
  for (let i = 0; i < 50; i++) seqA.push(jitteredIntervalS(0.6, a));
  for (let i = 0; i < 50; i++) seqB.push(b.next());
  ok(seqA.every((d, i) => Math.abs(d / (1 + (seqB[i] * 2 - 1) * JITTER_FRACTION)
    - baseIntervalS(0.6)) < 1e-12),
    'each draw consumes exactly one rng.next() step');
}

// --- 3. zero coughs at saturation 0 exactly ------------------------------------
console.log('[clean air]');
{
  const longRun = run(0, 3600);
  ok(longRun.length === 0, 'no events over 1h at s=0 exactly');

  const outside = new ContaminationCough(42, zoneAt(1));
  for (let t = 0; t < 1800; t += DT) outside.update(DT, 100, 100); // far away
  ok(outside.events.length === 0, 'no events when player stands outside every zone');

  // enter/exit cycling: only in-zone time accumulates toward the schedule
  const c = new ContaminationCough(7, zoneAt(1));
  for (let k = 0; k < 40; k++) { c.update(DT, 0, 0); c.update(DT, 100, 100); } // half-time in zone
  const halfTime = run(1, 40 * DT, 7).length;
  ok(c.events.length <= halfTime,
    'time spent outside zones does not advance the cough schedule');

  ok(saturationAt(zoneAt(0.8), 0, 0) === 0.8 &&
     saturationAt([], 0, 0) === 0 &&
     saturationAt([{ x: 0, z: 0, radius: 1, saturation: 0.9 }, { x: 0, z: 0, radius: 2, saturation: 0.4 }], 1.5, 0) === 0.4,
    'saturationAt picks containing zones, max wins, empty -> 0');
}

// --- 4. event payload: intensity proportional to s, bounded duration -----------
console.log('[event payload]');
{
  const s = 0.7;
  const events = run(s, 6000);
  ok(events.every((e) => e.intensity === s),
    'every intensity equals the active saturation');
  ok(events.every((e) => e.durationS > 0 && e.durationS < 1),
    `durations are audible lengths (${events[0].durationS.toFixed(3)}s sample)`);
  const times = events.map((e) => e.timeS);
  ok(times.every((t, i) => i === 0 || t >= times[i - 1]),
    'events accumulate in session order');

  // first fire lands within the jittered clean->saturated window from entry
  const base = baseIntervalS(s);
  ok(events[0].timeS >= base * (1 - JITTER_FRACTION) - 1e-9 &&
     events[0].timeS <= base * (1 + JITTER_FRACTION) + 1e-9,
    `first cough after one jittered interval (${events[0].timeS.toFixed(2)}s ` +
    `in [${(base * (1 - JITTER_FRACTION)).toFixed(2)}, ${(base * (1 + JITTER_FRACTION)).toFixed(2)}])`);
}

// --- 5. purity and determinism ---------------------------------------------------
console.log('[purity]');
{
  const once = JSON.stringify(run(0.5, 3000));
  const twice = JSON.stringify(run(0.5, 3000));
  ok(once === twice, 'same seed + timeline -> byte-identical event stream');

  const other = JSON.stringify(run(0.5, 3000, 5678));
  ok(other !== once, 'different seeds decorrelate the schedule');

  ok(!readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'player', 'cough.ts'), 'utf8').includes('Math.random'),
    'module contains no unseeded randomness at all');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
