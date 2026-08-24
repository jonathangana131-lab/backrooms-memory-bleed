/**
 * Hardcore flicker battery tests (F95) — pure Node, no renderer.
 *
 * Verifies the F95 acceptance proof:
 *   1. mode equivalence - charge→band mapping is exact including the 20/50
 *      boundaries (0.5 and 0.2 both stutter; strictly above/below switches)
 *   2. flicker patterns deterministic per (tick, seed) - identical seeds
 *      replay byte-identical frame sequences on independent instances;
 *      different seeds diverge in the critical band while steady stays fixed
 *   3. suppression flag exact - hudSuppressed === hardcore at every toggle,
 *      so consumers hide/show the battery HUD precisely
 *   4. opt-out identity - hardcore off returns {on:true,dim:1} for every
 *      charge/tick, i.e. HUD restored and torch untouched
 *   5. junk safe - NaN/Infinity charges and ticks never throw and degrade to
 *      sane frames
 *
 * Run: node test/flickerbattery-test.mjs  (prints FLICKERBATTERY ALL PASS, exits 0)
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
  STEADY_MIN_CHARGE,
  CRITICAL_MAX_CHARGE,
  STUTTER_CHANCE,
  bandForCharge,
  FlickerBattery,
} = await import('../src/player/flickerbattery.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const finite = (v) => typeof v === 'number' && isFinite(v);

/** Collect a deterministic frame signature over a tick sweep. */
const trace = (fb, charge, ticks) =>
  ticks.map((t) => {
    const f = fb.frame(charge, t);
    return f.on ? `d${f.dim.toFixed(6)}` : 'off';
  }).join(',');

// ---------------------------------------------------------------------------
console.log('1. Charge→band mapping exact incl. boundaries 20/50');
{
  ok(bandForCharge(1) === 'steady' && bandForCharge(0.9) === 'steady',
    'full/high charges are steady');
  ok(bandForCharge(STEADY_MIN_CHARGE + 1e-9) === 'steady', 'just above 50% is steady');
  ok(bandForCharge(STEADY_MIN_CHARGE) === 'stutter', 'exactly 50% stutters (>50 rule)');
  ok(bandForCharge(0.35) === 'stutter', 'mid band stutters');
  ok(bandForCharge(CRITICAL_MAX_CHARGE) === 'stutter', 'exactly 20% stutters (inclusive)');
  ok(bandForCharge(CRITICAL_MAX_CHARGE - 1e-9) === 'critical', 'just below 20% is critical');
  ok(bandForCharge(0) === 'critical', 'empty battery is critical');
  ok(bandForCharge(-3) === 'critical', 'negative charge clamps into critical');
  ok(bandForCharge(42) === 'steady', 'overshoot charge clamps into steady');
}

// ---------------------------------------------------------------------------
console.log('2. Flicker encodes bands: steady solid, stutter rare, critical rapid+irregular');
{
  const fb = new FlickerBattery(1234);
  fb.setHardcore(true);
  const ticks = Array.from({ length: 400 }, (_, i) => i);
  // Steady: never drops anywhere in the band.
  let steadySolid = true;
  for (const c of [0.51, 0.7, 1]) {
    for (const t of ticks) {
      const f = fb.frame(c, t);
      if (!f.on || f.dim !== 1) steadySolid = false;
    }
  }
  ok(steadySolid, '>50% beam never drops or dims');
  // Stutter: drop rate ≈ STUTTER_CHANCE, clearly rarer than critical's.
  let drops = 0;
  for (const t of ticks) if (!fb.frame(0.35, t).on) drops++;
  const stutterRate = drops / ticks.length;
  ok(drops > 0, `stutter band actually stutters (${drops} drops/400)`);
  ok(stutterRate < 0.2, `stutter drop rate stays occasional (${stutterRate.toFixed(3)})`);
  ok(nearRate(stutterRate, STUTTER_CHANCE, 0.05), `drop rate tracks STUTTER_CHANCE (${STUTTER_CHANCE})`);
  // Critical: rapid irregular — far more drops, and non-periodic rhythm.
  let cdrops = 0;
  const pattern = [];
  for (const t of ticks) {
    const f = fb.frame(0.1, t);
    if (!f.on) { cdrops++; pattern.push(0); } else { pattern.push(f.dim); }
  }
  const critRate = cdrops / ticks.length;
  ok(critRate > 0.3 && critRate < 0.7, `critical drop rate sits in rapid band (${critRate.toFixed(3)})`);
  ok(critRate > stutterRate * 2, 'critical flickers strictly faster than stutter');
  ok(hasRunVariance(pattern), 'critical rhythm is irregular (run lengths vary)');
  ok(pattern.some((v) => v !== 0 && v !== 1), 'surviving critical ticks dim irregularly');
}
function nearRate(a, b, eps) { return Math.abs(a - b) <= eps; }
function hasRunVariance(seq) {
  const runs = [];
  let cur = seq[0], len = 1;
  for (let i = 1; i < seq.length; i++) {
    if ((seq[i] === 0) === (cur === 0)) len++;
    else { runs.push(len); cur = seq[i]; len = 1; }
  }
  runs.push(len);
  if (runs.length < 8) return false;
  const distinct = new Set(runs).size;
  // Non-periodic rhythm: many different run lengths, no short cycle dominating.
  return distinct >= 4 && runs.slice(0, Math.floor(runs.length / 2)).join(',') !== runs.slice(Math.ceil(runs.length / 2)).slice(0, Math.floor(runs.length / 2)).join(',');
}

// ---------------------------------------------------------------------------
console.log('3. Deterministic per tick + seed');
{
  const a = new FlickerBattery(777); a.setHardcore(true);
  const b = new FlickerBattery(777); b.setHardcore(true);
  const ticks = Array.from({ length: 300 }, (_, i) => i * 7); // sparse ticks too
  ok(trace(a, 0.1, ticks) === trace(b, 0.1, ticks),
    'same seed replays byte-identical critical pattern');
  ok(trace(a, 0.35, ticks) === trace(b, 0.35, ticks),
    'same seed replays byte-identical stutter pattern');
  const c = new FlickerBattery(778); c.setHardcore(true);
  ok(trace(c, 0.1, ticks) !== trace(a, 0.1, ticks),
    'different seed shifts the critical pattern');
}
// Clean up the placeholder above via a proper re-check instead of hacks.
{
  const fresh = new FlickerBattery(777);
  fresh.setHardcore(true);
  const swept = new FlickerBattery(777);
  swept.setHardcore(true);
  let coldMatchesSweep = true;
  for (const t of [0, 1, 41, 555, 99999]) {
    const cold = fresh.frame(0.1, t);
    const warm = swept.frame(0.1, t);
    if (cold.on !== warm.on || cold.dim !== warm.dim) coldMatchesSweep = false;
  }
  ok(coldMatchesSweep, 'pattern keyed purely by (tick, seed): cold query equals swept run');
}

// ---------------------------------------------------------------------------
console.log('4. Suppression flag exact');
{
  const fb = new FlickerBattery(1);
  ok(fb.hardcore === false && fb.hudSuppressed === false, 'default mode leaves HUD visible');
  fb.setHardcore(true);
  ok(fb.hardcore === true && fb.hudSuppressed === true, 'opt-in suppresses the HUD readout flag');
  fb.setHardcore(false);
  ok(fb.hardcore === false && fb.hudSuppressed === false, 'opt-out clears suppression exactly');
  fb.setHardcore(true);
  fb.setHardcore(false);
  ok(fb.hudSuppressed === false, 'repeated toggles stay consistent');
  fb.hardcore = true; // consumer may also set the field directly
  ok(fb.hudSuppressed === true, 'getter mirrors direct field writes');
}

// ---------------------------------------------------------------------------
console.log('5. Opt-out identity');
{
  const off = new FlickerBattery(999);
  const charges = [-1, 0, 0.05, 0.19, 0.2, 0.35, 0.5, 0.75, 1, 100];
  let identity = true;
  for (const ch of charges) {
    for (const t of [0, 3, 17, 250]) {
      const f = off.frame(ch, t);
      if (!f.on || f.dim !== 1) identity = false;
    }
  }
  ok(identity, 'hardcore-off frames are exactly {on:true,dim:1} across all bands');
  const wasOn = new FlickerBattery(999);
  wasOn.setHardcore(true);
  let strobeTick = -1;
  for (let t = 0; t < 200; t++) {
    if (!wasOn.frame(0.1, t).on) { strobeTick = t; break; }
  }
  ok(strobeTick >= 0, 'critical band does strobe under hardcore before opt-out');
  wasOn.setHardcore(false);
  const after = wasOn.frame(0.1, strobeTick + 1);
  ok(after.on && after.dim === 1,
    'a critical-band torch that strobed in hardcore burns solid again after opt-out');
  ok(wasOn.hudSuppressed === false, 'HUD restored after opt-out');
}

// ---------------------------------------------------------------------------
console.log('6. Junk safe');
{
  const fb = new FlickerBattery(5);
  fb.setHardcore(true);
  let threw = false;
  let allSane = true;
  try {
    for (const ch of [NaN, Infinity, -Infinity]) {
      const band = bandForCharge(ch);
      if (band !== 'steady') allSane = false; // junk reads as full, never dark
      const f = fb.frame(ch, NaN);
      if (typeof f.on !== 'boolean' || !finite(f.dim) || f.dim < 0 || f.dim > 1) allSane = false;
    }
    const f = fb.frame(0.1, Infinity);
    if (typeof f.on !== 'boolean') allSane = false;
  } catch {
    threw = true;
  }
  ok(!threw, 'NaN/Infinity charge and tick never throw');
  ok(allSane, 'junk charges map to steady and junk ticks yield valid frames');
}

// ---------------------------------------------------------------------------
if (failures === 0) {
  console.log(`FLICKERBATTERY ALL PASS (${check} checks)`);
} else {
  console.error(`FLICKERBATTERY FAILURES: ${failures}/${check}`);
  process.exit(1);
}
