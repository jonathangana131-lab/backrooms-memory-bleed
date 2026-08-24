/**
 * Adrenaline dump tests (F75) - pure Node, no audio device.
 * Verifies the F75 acceptance proof:
 *   1. dual-effect envelope shapes - attack linear 0->1 across ATTACK_S,
 *      decay linear 1->0 across DECAY_S, exactly 0 outside; both outputs
 *      (handShakeAmp, hearingGainMul) track the same envelope
 *   2. monotone in severity - peak shake and peak hearing gain strictly
 *      increase with event severity
 *   3. stacking saturates - overlapping dumps sum with saturation; shake
 *      caps at SHAKE_AMP_CAP and hearing at HEARING_GAIN_MUL_MAX (+6 dB proxy)
 *   4. refractory honored - sub-threshold repeats within REFRACTORY_S are
 *      ignored; strong dumps land mid-refractory and restart the window;
 *      a sub-threshold repeat after REFRACTORY_S is accepted
 *   5. determinism - same input timeline replays identical output samples
 *
 * Run: node test/adrenaline-test.mjs  (prints ADRENALINE ALL PASS, exits 0)
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
  AdrenalineSystem, dumpEnvelope,
  ATTACK_S, DECAY_S, REFRACTORY_S, SUB_THRESHOLD_SEVERITY,
  SHAKE_AMP_PER_DUMP, SHAKE_AMP_CAP, HEARING_GAIN_MUL_MAX,
} = await import('../src/player/adrenaline.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const DT = 1 / 120;
/** Advance `s` seconds of sim time on one system instance. */
function advance(sys, s) {
  for (let t = 0; t < s - 1e-9; t += DT) sys.update(DT);
}

// --- 1a. envelope shape sampled ------------------------------------------------
console.log('[envelope shape]');
{
  ok(dumpEnvelope(-1) === 0 && dumpEnvelope(0) === 0, 'exactly 0 before/at fire');
  ok(Math.abs(dumpEnvelope(ATTACK_S / 2) - 0.5) < 1e-12, 'attack linear: midpoint samples 0.5');
  ok(Math.abs(dumpEnvelope(ATTACK_S) - 1) < 1e-12, 'peaks at exactly 1 at end of attack');
  ok(dumpEnvelope(ATTACK_S + 1e-9) <= 1 + 1e-12, 'no overshoot past the peak');
  ok(Math.abs(dumpEnvelope(ATTACK_S + DECAY_S / 2) - 0.5) < 1e-12, 'decay linear: midpoint samples 0.5');
  ok(Math.abs(dumpEnvelope(ATTACK_S + DECAY_S) - 0) < 1e-12 && dumpEnvelope(ATTACK_S + DECAY_S + 1) === 0,
    'exactly 0 at/after attack+decay');
  const riseSlope = 1 / ATTACK_S;
  const fallSlope = 1 / DECAY_S;
  ok(riseSlope > fallSlope * 10, 'attack ~0.3s is far steeper than the ~4s decay');
}

// --- 1b. dual outputs ride the same envelope -----------------------------------
console.log('[dual-effect coupling]');
{
  const sys = new AdrenalineSystem();
  sys.pushNearMiss({ severity: 1 });
  let coupled = true;
  let sawPeak = false;
  for (let t = 0; t < ATTACK_S + DECAY_S + 0.5; t += DT) {
    sys.update(DT);
    const env = dumpEnvelope(sys.now);
    const shake = sys.handShakeAmp;
    const gain = sys.hearingGainMul;
    // Both outputs are affine in the same envelope value.
    const wantShake = Math.min(SHAKE_AMP_CAP, SHAKE_AMP_PER_DUMP * env);
    const wantGain = 1 + (HEARING_GAIN_MUL_MAX - 1) * Math.min(1, env);
    if (Math.abs(shake - wantShake) > 1e-9 || Math.abs(gain - wantGain) > 1e-9) coupled = false;
    if (shake >= SHAKE_AMP_PER_DUMP - 1e-9 && gain >= HEARING_GAIN_MUL_MAX - 1e-9) sawPeak = true;
  }
  ok(coupled, 'handShakeAmp and hearingGainMul sample the identical envelope every frame');
  ok(sawPeak, 'both outputs reach their full-dump values simultaneously');
  ok(sys.activeDumps.length === 0, 'dump expires cleanly after attack+decay');
}

// --- 2. monotone in severity -----------------------------------------------------
console.log('[monotone in severity]');
{
  let shakeMono = true;
  let gainMono = true;
  let prevShake = -Infinity;
  let prevGain = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const sev = i / 20;
    const sys = new AdrenalineSystem();
    sys.pushNearMiss({ severity: sev });
    advance(sys, ATTACK_S); // sample at the envelope peak
    const sh = sys.handShakeAmp;
    const gn = sys.hearingGainMul;
    if (sh < prevShake - 1e-12) shakeMono = false;
    if (gn < prevGain - 1e-12) gainMono = false;
    prevShake = sh;
    prevGain = gn;
  }
  ok(shakeMono, `handShakeAmp monotone non-decreasing in severity (peak ${prevShake})`);
  ok(gainMono, `hearingGainMul monotone non-decreasing in severity (peak ${prevGain.toFixed(3)})`);
  const zero = new AdrenalineSystem();
  zero.pushNearMiss({ severity: 0 });
  advance(zero, ATTACK_S);
  ok(zero.handShakeAmp === 0 && zero.hearingGainMul === 1, 'severity 0 moves nothing');
}

// --- 3. stacked dumps saturate at the caps --------------------------------------
console.log('[stacking saturation]');
{
  const sys = new AdrenalineSystem();
  // Ten overlapping full-severity dumps inside one attack window.
  sys.pushNearMiss({ severity: 1 });
  advance(sys, 0.05);
  for (let i = 0; i < 9; i++) {
    sys.pushNearMiss({ severity: 1 });
    advance(sys, 0.01);
  }
  advance(sys, ATTACK_S);
  ok(sys.handShakeAmp === SHAKE_AMP_CAP, `shake saturates exactly at cap ${SHAKE_AMP_CAP}`);
  ok(sys.hearingGainMul === HEARING_GAIN_MUL_MAX, 'hearing saturates exactly at +6 dB proxy (2x)');
  ok(sys.rawEnergy > 1, `raw stack energy unbounded (${sys.rawEnergy.toFixed(2)}) while outputs clamp`);
  // Partial stacks sum linearly below saturation.
  const two = new AdrenalineSystem();
  two.pushNearMiss({ severity: 0.4 });
  advance(two, 0.02);
  two.pushNearMiss({ severity: 0.3 });
  advance(two, ATTACK_S);
  const [d1, d2] = two.activeDumps;
  const wantEnergy = d1.severity * dumpEnvelope(two.now - d1.startS)
    + d2.severity * dumpEnvelope(two.now - d2.startS);
  ok(Math.abs(two.rawEnergy - wantEnergy) < 1e-12,
    'two partial dumps sum (first still decaying while second peaks)');
}

// --- 4. refractory period --------------------------------------------------------
console.log('[refractory]');
{
  const sys = new AdrenalineSystem();
  sys.pushNearMiss({ severity: 1 }); // accepted, starts the 8 s window
  advance(sys, 1);
  ok(sys.pushNearMiss({ severity: 0.1 }) === false, 'sub-threshold repeat at +1s ignored');
  advance(sys, 2);
  ok(sys.pushNearMiss({ severity: SUB_THRESHOLD_SEVERITY - 1e-9 }) === false, 'sub-threshold at +3s ignored');
  advance(sys, 4.9); // now 7.9s since acceptance
  ok(sys.pushNearMiss({ severity: 0.2 }) === false, 'sub-threshold just inside REFRACTORY_S ignored');
  advance(sys, 0.2); // now 8.1s
  ok(sys.pushNearMiss({ severity: 0.2 }) === true, 'same-strength repeat after REFRACTORY_S accepted');
  advance(sys, 0.5);
  ok(sys.pushNearMiss({ severity: 1 }) === true, 'strong dump lands mid-refractory');
  advance(sys, 1);
  ok(sys.pushNearMiss({ severity: 0.1 }) === false, 'strong dump restarts the sub-threshold window');
  ok(sys.activeDumps.length === 2,
    'exactly the last two dumps remain live (first expired past attack+decay)');
}

// --- 5. determinism ----------------------------------------------------------------
console.log('[determinism]');
{
  const replay = () => {
    const sys = new AdrenalineSystem();
    const script = [[0, 0.9], [2.5, 0.15], [3, 0.6], [11.9, 0.2], [12.2, 0.8], [20, 1]];
    let next = 0;
    const samples = [];
    for (let i = 0; i < 26 * 120; i++) {
      const t = i * DT;
      if (next < script.length && t >= script[next][0]) { sys.pushNearMiss({ severity: script[next][1] }); next++; }
      sys.update(DT);
      if (i % 13 === 0) samples.push(`${t.toFixed(4)}:${sys.handShakeAmp.toFixed(7)}:${sys.hearingGainMul.toFixed(7)}`);
    }
    return JSON.stringify(samples);
  };
  ok(replay() === replay(), 'identical near-miss timeline replays byte-identical output stream');
}

console.log(failures === 0 ? 'ADRENALINE ALL PASS' : `ADRENALINE FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
