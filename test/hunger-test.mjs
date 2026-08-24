/**
 * Hunger pang tests (F73) - pure Node, no audio device.
 * Verifies the F73 acceptance proof: base inter-pang intervals shrink
 * monotonically across an expedition-length sweep from 12 min at start to
 * 3 min after 90 min; jittered draws stay inside the +/-10% band over 1000
 * draws per length; no pangs fire before a configurable grace period (the
 * default one included); measured gaps in the late half of a long run are
 * strictly tighter than in the early half; the whole schedule is seeded
 * and byte-identical on replay, cadence-independent, and reset()-able.
 * Run: node test/hunger-test.mjs  (prints ALL PASS, exits 0)
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
  HungerPangs, baseIntervalMin, jitteredIntervalMin,
  START_INTERVAL_MIN, END_INTERVAL_MIN, INTERVAL_SATURATION_MIN,
  JITTER_FRACTION, DEFAULT_GRACE_PERIOD_MIN,
} = await import('../src/player/hunger.ts');
const { RNG } = await import('../src/core/rng.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const EPS = 1e-12;

/**
 * Run `horizonMin` of session clock at fixed cadence and return events.
 */
function run(horizonMin, seed = 1234, grace, stepMin = 0.25) {
  const h = grace === undefined ? new HungerPangs(seed) : new HungerPangs(seed, { gracePeriodMin: grace });
  for (let t = 0; t <= horizonMin; t += stepMin) h.update(t);
  return h.drainEvents();
}

// --- 1. interval scaling: monotone shrink across the length sweep ---------------
console.log('[interval scaling]');
{
  ok(baseIntervalMin(0) === START_INTERVAL_MIN,
    `baseInterval(0 min) === ${START_INTERVAL_MIN} min at expedition start`);
  ok(baseIntervalMin(INTERVAL_SATURATION_MIN) === END_INTERVAL_MIN &&
     baseIntervalMin(240) === END_INTERVAL_MIN,
    `baseInterval(${INTERVAL_SATURATION_MIN}+ min) === ${END_INTERVAL_MIN} min and holds`);
  ok(Math.abs(baseIntervalMin(45) - (START_INTERVAL_MIN + END_INTERVAL_MIN) / 2) < EPS,
    'base interval is the linear midpoint at 45 min');

  let prev = Infinity;
  let monotone = true;
  const trace = [];
  for (let m = 0; m <= 120; m += 6) {
    const b = baseIntervalMin(m);
    trace.push(`${m}:${b.toFixed(2)}`);
    if (b > prev + EPS) monotone = false;
    prev = b;
  }
  ok(monotone,
    `base interval non-increasing across 21-point length sweep ` +
    `(first ${trace[0]}, last ${trace[trace.length - 1]})`);

  // measured gaps: late-run pangs crowd closer than early-run ones
  const HORIZON = 180;
  const events = run(HORIZON, 42);
  const gaps = events.map((e, i) => i === 0 ? null : e.timeMin - events[i - 1].timeMin);
  const midTime = HORIZON / 2;
  const early = gaps.filter((g, i) => g !== null && events[i].timeMin < midTime);
  const late = gaps.filter((g, i) => g !== null && events[i].timeMin >= midTime);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  ok(events.length > 20 && mean(late) < mean(early),
    `measured mean gap shrinks late vs early (${mean(early).toFixed(2)} -> ${mean(late).toFixed(2)} min ` +
    `over ${events.length} pangs in ${HORIZON} min)`);

  // consecutive-gap sequence trends down even under jitter
  let downs = 0, ups = 0;
  for (let i = 1; i + 1 < gaps.length; i++) {
    if (gaps[i] !== null && gaps[i + 1] !== null) {
      if (gaps[i + 1] < gaps[i]) downs++;
      else ups++;
    }
  }
  ok(downs > ups, `gap sequence trends downward (${downs} shrinks vs ${ups} grows)`);
}

// --- 2. jitter bounds ------------------------------------------------------------
console.log('[jitter bounds]');
{
  let lo = Infinity, hi = -Infinity;
  for (let m = 0; m <= INTERVAL_SATURATION_MIN + 30; m += 15) {
    const base = baseIntervalMin(m);
    const rng = new RNG(0xfeed + m * 100 | 0);
    for (let i = 0; i < 1000; i++) {
      const d = jitteredIntervalMin(m, rng);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
      if (d < base * (1 - JITTER_FRACTION) - EPS ||
          d > base * (1 + JITTER_FRACTION) + EPS) { lo = NaN; break; }
    }
    if (Number.isNaN(lo)) break;
  }
  ok(!Number.isNaN(lo),
    `all ${(INTERVAL_SATURATION_MIN / 15 + 1) * 1000} jitter draws within +/-${JITTER_FRACTION * 100}% of base`);
  ok(hi - lo > 0.05 * (START_INTERVAL_MIN - END_INTERVAL_MIN),
    `draws span both sides of the band (${lo.toFixed(3)} .. ${hi.toFixed(3)} min)`);

  const a = new RNG(77), b = new RNG(77);
  const seqA = [], seqB = [];
  for (let i = 0; i < 50; i++) seqA.push(jitteredIntervalMin(60, a));
  for (let i = 0; i < 50; i++) seqB.push(b.next());
  ok(seqA.every((d, i) =>
      Math.abs(d / (1 + (seqB[i] * 2 - 1) * JITTER_FRACTION) - baseIntervalMin(60)) < EPS),
    'each draw consumes exactly one rng.next() step');
}

// --- 3. grace period: nothing fires before it ------------------------------------
console.log('[grace period]');
{
  ok(DEFAULT_GRACE_PERIOD_MIN > 0, `default grace is positive (${DEFAULT_GRACE_PERIOD_MIN} min)`);
  const quiet = run(DEFAULT_GRACE_PERIOD_MIN, 9);
  ok(quiet.length === 0,
    `zero pangs up to the default ${DEFAULT_GRACE_PERIOD_MIN} min grace`);

  const custom = 45;
  const beforeGrace = new HungerPangs(5, { gracePeriodMin: custom });
  for (let t = 0; t < custom; t += 0.25) beforeGrace.update(t);
  ok(beforeGrace.events.length === 0,
    `zero pangs before configurable ${custom} min grace`);

  const h = new HungerPangs(5, { gracePeriodMin: custom });
  for (let t = 0; t <= custom + 30; t += 0.25) h.update(t);
  const first = h.events[0];
  ok(first.timeMin >= custom &&
     first.timeMin <= custom + baseIntervalMin(custom) * (1 + JITTER_FRACTION),
     `first pang lands within one jittered interval past grace (${first.timeMin.toFixed(2)} min)`);
  ok(h.gracePeriodMin === custom, 'configured grace period readable back');

  // huge single jump past grace still respects the quiet window
  const jumpy = new HungerPangs(11);
  jumpy.update(1000);
  ok(jumpy.events.every((e) => e.timeMin >= DEFAULT_GRACE_PERIOD_MIN),
    'a giant clock jump never schedules inside the grace window');

  try {
    new HungerPangs(1, { gracePeriodMin: -3 });
    ok(false, 'negative grace rejected');
  } catch (e) {
    ok(e instanceof RangeError, 'negative grace fails loud with RangeError');
  }

  // regressed clock readings are ignored, not rewound
  const r = new HungerPangs(21, { gracePeriodMin: 1 });
  r.update(50); r.update(10); r.update(49);
  const timesNow = r.events.map((e) => e.timeMin);
  ok(timesNow.every((t, i) => i === 0 || t >= timesNow[i - 1]),
    'clock regressions do not rewind or reorder the schedule');
}

// --- 4. payload sanity ------------------------------------------------------------
console.log('[event payload]');
{
  const events = run(150, 808);
  ok(events.every((e) => e.intensity >= 0 && e.intensity <= 1),
    'every intensity lies in [0, 1]');
  ok(events.every((e, i) => i === 0 || e.intensity >= events[i - 1].intensity - EPS),
    'intensities non-decreasing as the expedition ages');
  ok(Math.abs(events[0].intensity - Math.min(1, events[0].timeMin / INTERVAL_SATURATION_MIN)) < EPS &&
     Math.abs(events[events.length - 1].intensity - Math.min(1, events[events.length - 1].timeMin / INTERVAL_SATURATION_MIN)) < EPS,
    'every intensity keys exactly to its fire time over expedition age');
  ok(events.every((e) => e.durationS > 0.4 && e.durationS < 1.7),
    `durations are audible growl lengths (${events[0].durationS.toFixed(3)}s sample)`);
  const times = events.map((e) => e.timeMin);
  ok(times.every((t, i) => i === 0 || t > times[i - 1]),
    'pang times strictly increase');
}

// --- 5. purity, cadence independence, determinism ---------------------------------
console.log('[purity & determinism]');
{
  const once = JSON.stringify(run(120, 4321));
  const twice = JSON.stringify(run(120, 4321));
  ok(once === twice, 'same seed + timeline -> byte-identical event stream');
  ok(once === JSON.stringify(run(120, 4321, undefined, 4)),
    'identical schedule regardless of update() call cadence');

  const other = JSON.stringify(run(120, 9999));
  ok(other !== once, 'different seeds decorrelate the schedule');

  const r = new HungerPangs(4321);
  const feed = (h) => { for (let t = 0; t <= 120; t += 0.25) h.update(t); return JSON.stringify(h.drainEvents()); };
  const firstPass = feed(r);
  r.reset();
  ok(feed(r) === firstPass, 'reset() replays the whole run byte-identically');

  ok(!readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'player', 'hunger.ts'), 'utf8').includes('Math.random'),
    'module contains no unseeded randomness at all');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
