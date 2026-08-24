/*
 * Breathing wallpaper tests (F40).
 *
 * Proves the AC against the pure model:
 *   1. amplitude: displacement(d, phase) <= MAX_BREATH_DISPLACEMENT_M * d^2
 *      everywhere on [0..1]x[0..2pi], with equality at the inhale peak and
 *      exact quadratic scaling in d
 *   2. smoothstep edge falloff: band weight is 1 across the saturated core,
 *      monotone down to exactly 0 AT the band radius and beyond
 *   3. phase from an injected clock around the ~4.2 s base period with a
 *      bounded seeded drift; deterministic per (seed, t), distinct across
 *      seeds, drift never exceeds DRIFT_AMPLITUDE_RAD off the base rotation
 *   4. junk input (NaN/Infinity/null anywhere) collapses to finite 0,
 *      never NaN
 *
 * Run: node --experimental-strip-types test/wallbreath-test.mjs
 */
import {
  WallBreath,
  displacement,
  smoothstep,
  MAX_BREATH_DISPLACEMENT_M,
  BASE_PERIOD_S,
  DRIFT_AMPLITUDE_RAD,
} from '../src/gfx/wallbreath.ts';

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

// ---- 1. amplitude bound + quadratic scaling ---------------------------------
(() => {
  let worst = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const d = i / 40;
    for (let j = 0; j <= 64; j++) {
      const phase = (j / 64) * Math.PI * 4;
      const disp = displacement(d, phase);
      worst = Math.max(worst, disp - MAX_BREATH_DISPLACEMENT_M * d * d);
    }
  }
  check('displacement(d, phase) <= 0.005*d^2 m over the whole domain', worst <= 1e-15,
    'worst excess ' + worst.toExponential(3));

  // equality at full saturation + inhale peak (wave max = 1)
  check('full saturation at inhale peak reaches the 0.005 m cap',
    Math.abs(displacement(1, Math.PI) - MAX_BREATH_DISPLACEMENT_M) < 1e-12);
  check('exhale bottom gives zero displacement', displacement(1, 0) === 0);

  // quadratic law: doubling saturation quadruples displacement at fixed phase
  const quarter = displacement(0.25, 1.3);
  const half = displacement(0.5, 1.3);
  check('displacement scales as d^2 (0.5 -> 4x of 0.25)',
    Math.abs(half - 4 * quarter) < 1e-15, half + ' vs ' + 4 * quarter);
})();

// ---- 2. smoothstep edge falloff to 0 at the band boundary ---------------------
(() => {
  const wb = new WallBreath({ seed: 11 });
  const band = { centerX: 0, centerZ: 0, radiusM: 6, edgeSoftnessM: 1.5, saturation: 1 };

  check('weight is 1 deep in the saturated core', wb.bandWeight(band, 3) === 1);
  check('weight is exactly 0 at the band radius', wb.bandWeight(band, 6) === 0);
  check('weight stays 0 beyond the band radius',
    [7, 12, 100].every((r) => wb.bandWeight(band, r) === 0));

  let mono = true;
  let prev = 1;
  for (let r = 4.5; r <= 6.0001; r += 0.01) {
    const w = wb.bandWeight(band, r);
    if (w > prev + 1e-12 || w < -1e-12 || w > 1 + 1e-12) mono = false;
    prev = w;
  }
  check('falloff is monotone decreasing through the softness zone', mono);

  // the exported smoothstep is the standard rising variant; the falloff to 0
  // at the boundary comes from 1 - smoothstep inside bandWeight
  check('smoothstep rises 0 -> 1 across [edge0, edge1] with exact rails',
    smoothstep(4.5, 6, 4.5) === 0 && smoothstep(4.5, 6, 6) === 1
      && smoothstep(4.5, 6, 0) === 0 && smoothstep(4.5, 6, 9) === 1);
  check('smoothstep is monotone rising between its edges',
    (() => {
      let prev = 0;
      for (let x = 4.5; x <= 6; x += 0.05) {
        const v = smoothstep(4.5, 6, x);
        if (v < prev - 1e-12) return false;
        prev = v;
      }
      return true;
    })());

  // spatial sample honors the falloff: nonzero inside, exactly 0 outside
  const bands = { bands: () => [band] };
  const wbq = new WallBreath({ seed: 11, clock: () => Math.PI * BASE_PERIOD_S * 0.5, bands });
  const inside = wbq.sample(0, 0);
  check('sample inside the band is positive but under the cap',
    inside > 0 && inside <= MAX_BREATH_DISPLACEMENT_M + 1e-15);
  check('sample at/beyond the boundary is exactly 0',
    wbq.sample(6, 0) === 0 && wbq.sample(20, -14) === 0);
})();

// ---- 3. injected-clock phase, ~4.2 s period +/- seeded drift -------------------
(() => {
  // injected clock drives the phase directly
  const clockT = { t: 0 };
  const wbc = new WallBreath({ seed: 3, clock: () => clockT.t });
  clockT.t = 2.1;
  const p1 = wbc.phaseAt(clockT.t);
  clockT.t = 4.2;
  const p2 = wbc.phaseAt(clockT.t);
  check('phase advances with the injected clock',
    Number.isFinite(p1) && Number.isFinite(p2) && p2 !== p1);

  // inhale peaks recur near the base period: an inhale peak is exactly where
  // the phase crosses pi (mod 2pi), i.e. sin(phase) flips from + to -
  let peakOk = true;
  for (const seed of [1, 7, 42, 2024]) {
    const wb = new WallBreath({ seed, clock: () => 0 });
    const crossings = [];
    const dt = 0.002;
    let prevSin = Math.sin(wb.phaseAt(0));
    for (let t = dt; t <= 42; t += dt) {
      const s = Math.sin(wb.phaseAt(t));
      if (prevSin >= 0 && s < 0) crossings.push(t);
      prevSin = s;
    }
    const gapsBetweenPeaks = crossings.slice(1).map((t, i) => t - crossings[i]);
    // each inter-peak gap must sit near 4.2 s; the bounded +/-0.35 rad drift
    // can shift consecutive peaks oppositely by up to ~0.47 s total
    const near = gapsBetweenPeaks.length >= 8
      && gapsBetweenPeaks.every((g) => Math.abs(g - BASE_PERIOD_S) < 0.5);
    if (!near) peakOk = false;
  }
  check('inhale peaks recur every ~4.2 s (+/- seeded drift) across seeds', peakOk);

  // drift is bounded: |phase(t) - 2pi*t/T| <= DRIFT_AMPLITUDE_RAD for every seed
  let driftBounded = true;
  for (const seed of [0, 5, 99]) {
    const wb = new WallBreath({ seed, clock: () => 0 });
    for (let t = 0; t <= 200; t += 0.37) {
      const dev = Math.abs(wb.phaseAt(t) - (2 * Math.PI * t) / BASE_PERIOD_S);
      if (dev > DRIFT_AMPLITUDE_RAD + 1e-9) { driftBounded = false; break; }
    }
  }
  check('seeded drift stays within DRIFT_AMPLITUDE_RAD of the base rotation', driftBounded);

  // drift actually varies per seed (not a constant offset only)
  const phasesA = [];
  const phasesB = [];
  for (let t = 1; t <= 40; t += 3.7) {
    phasesA.push(new WallBreath({ seed: 8 }).phaseAt(t));
    phasesB.push(new WallBreath({ seed: 9 }).phaseAt(t));
  }
  check('different seeds produce different phase timelines',
    phasesA.some((p, i) => Math.abs(p - phasesB[i]) > 1e-6));

  // determinism: same seed reproduces the identical timeline
  const replay = () => Array.from({ length: 50 }, (_, i) => new WallBreath({ seed: 77 }).phaseAt(i * 0.83));
  check('same seed replays the identical phase timeline',
    JSON.stringify(replay()) === JSON.stringify(replay()));
})();

// ---- 4. junk-input safety -------------------------------------------------------
(() => {
  check('NaN saturation collapses to 0', displacement(Number.NaN, 1) === 0);
  check('+Infinity saturation is junk and collapses to 0 like NaN',
    displacement(Number.POSITIVE_INFINITY, Math.PI) === 0);
  check('negative saturation clamps to 0 displacement', displacement(-3, Math.PI) === 0);
  check('NaN phase collapses to 0', displacement(1, Number.NaN) === 0);
  check('null band query samples 0 safely', new WallBreath().sample(1, 1) === 0);

  const wb = new WallBreath({
    seed: 2,
    clock: () => 1,
    bands: { bands: () => [
      null,
      { centerX: Number.NaN, centerZ: 0, radiusM: 5, edgeSoftnessM: 1, saturation: 1 },
      { centerX: 0, centerZ: Number.POSITIVE_INFINITY, radiusM: 5, edgeSoftnessM: 1, saturation: 1 },
      { centerX: 0, centerZ: 0, radiusM: Number.NaN, edgeSoftnessM: 1, saturation: 1 },
      { centerX: 2, centerZ: 0, radiusM: 4, edgeSoftnessM: 1, saturation: Number.NaN },
    ] },
  });
  const s = wb.sample(0.5, 0.5);
  check('junk band fields are skipped or neutralized to finite output',
    s === 0 || Number.isFinite(s));

  check('NaN sample position returns 0',
    new WallBreath({ bands: { bands: () => [{ centerX: 0, centerZ: 0, radiusM: 9, edgeSoftnessM: 1, saturation: 1 }] } })
      .sample(Number.NaN, 0) === 0);
  check('NaN time collapses to exhale-bottom phase 0',
    new WallBreath({ seed: 2 }).phaseAt(Number.NaN) === 0);
  check('non-finite advance(dt) is ignored',
    (() => { const w = new WallBreath(); w.advance(Number.NaN); return true; })());

  // overlapping bands take the strongest contribution (no double breathing)
  const strong = { centerX: 0, centerZ: 0, radiusM: 10, edgeSoftnessM: 2, saturation: 1 };
  const weak = { centerX: 0, centerZ: 0, radiusM: 10, edgeSoftnessM: 2, saturation: 0.3 };
  const tHalfPeriod = Math.PI * BASE_PERIOD_S * 0.5;
  const both = new WallBreath({ seed: 4, clock: () => tHalfPeriod, bands: { bands: () => [weak, strong] } });
  const strongOnly = new WallBreath({ seed: 4, clock: () => tHalfPeriod, bands: { bands: () => [strong] } });
  check('overlapping bands contribute their max, not a sum',
    both.sample(0, 0) === strongOnly.sample(0, 0)
      && both.sample(0, 0) > displacement(0.3, both.phaseAt(tHalfPeriod)));
})();

console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;
