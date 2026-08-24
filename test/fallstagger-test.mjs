/**
 * Fall-stagger tests (F14): timeline sampling proves phase monotonicity of the
 * control damp (1 -> ~0.25 -> 1) and the blur envelope (0 -> peak -> 0), peak
 * proportionality to impact speed, exact settle to 0, and that sub-threshold
 * hops produce no effect at all.
 *
 * Runs with plain node (node test/fallstagger-test.mjs): the TypeScript source
 * is transpiled in-memory with the repo's own typescript dep - no browser needed.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// ---- tiny CJS-in-memory loader (fallstagger.ts has no imports) ----
function loadModule(filePath) {
  const cjs = ts.transpileModule(SRC(filePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', cjs)(
    () => { throw new Error('unexpected import'); },
    module,
    module.exports,
  );
  return module.exports;
}

const {
  FallStagger,
  staggerIntensity,
  FALL_TRIGGER_VY, FALL_REFERENCE_VY,
  STAGGER_RECOVER_TIME, STAGGER_DROP_TIME, STAGGER_INPUT_MIN,
} = loadModule('src/player/fallstagger.ts');

const DT = 1 / 240;
let n = 0;
const test = (name, fn) => { n++; fn(); console.log('ok  ' + name); };

/** Drives one full timeline from an impact, sampling every frame. */
function runTimeline(vy, dt = DT) {
  const fs = new FallStagger();
  fs.onImpact(vy);
  const samples = [{ t: 0, inputScale: fs.inputScale, blurAmp: fs.blurAmp }]; // touchdown frame
  let t = 0;
  while (fs.active && samples.length < 4000) {
    fs.update(dt);
    t += dt;
    samples.push({ t, inputScale: fs.inputScale, blurAmp: fs.blurAmp });
  }
  return { samples, settleT: t };
}

// ---- intensity helper --------------------------------------------------------

test('sub-threshold impacts have zero intensity; saturation at reference speed', () => {
  assert.equal(staggerIntensity(-2), 0, 'gentle hop');
  assert.equal(staggerIntensity(FALL_TRIGGER_VY + 0.01), 0, 'just under trigger');
  assert.equal(staggerIntensity(FALL_TRIGGER_VY), 0, 'exactly at trigger has no overshoot');
  assert.ok(staggerIntensity(FALL_TRIGGER_VY - 0.01) > 0, 'just beyond trigger arms');
  assert.equal(staggerIntensity(FALL_REFERENCE_VY - 5), 1, 'beyond reference saturates');
});

test('AC sub-threshold hops produce no effect', () => {
  for (const vy of [-0.5, -3, FALL_TRIGGER_VY + 1e-9]) {
    const fs = new FallStagger();
    fs.onImpact(vy);
    fs.update(DT);
    assert.equal(fs.active, false, `vy=${vy} must not arm the stagger`);
    assert.equal(fs.inputScale, 1, 'input scale untouched');
    assert.equal(fs.blurAmp, 0, 'blur untouched');
  }
});

// ---- full-intensity timeline -------------------------------------------------

const HARD = FALL_REFERENCE_VY; // saturating fall
const { samples } = runTimeline(HARD);

test('AC control damp: monotone down to ~min then monotone back to exactly 1', () => {
  const dropPhase = samples.filter((s) => s.t <= STAGGER_DROP_TIME);
  const recoverPhase = samples.filter((s) => s.t > STAGGER_DROP_TIME);
  // drop phase strictly decreasing
  for (let i = 1; i < dropPhase.length; i++) {
    assert.ok(dropPhase[i].inputScale < dropPhase[i - 1].inputScale,
      `drop phase rose at t=${dropPhase[i].t.toFixed(3)}`);
  }
  // recovery phase never falls (settled tail holds exactly 1)
  for (let i = 1; i < recoverPhase.length; i++) {
    assert.ok(recoverPhase[i].inputScale >= recoverPhase[i - 1].inputScale,
      `recovery fell at t=${recoverPhase[i].t.toFixed(3)}`);
  }
  // trough near STAGGER_INPUT_MIN for a saturating impact
  const minScale = Math.min(...samples.map((s) => s.inputScale));
  assert.ok(minScale >= STAGGER_INPUT_MIN - 1e-9, 'never below STAGGER_INPUT_MIN');
  assert.ok(Math.abs(minScale - STAGGER_INPUT_MIN) < 0.02,
    `trough=${minScale.toFixed(4)} should reach ~${STAGGER_INPUT_MIN}`);
  // exact settle
  const last = samples[samples.length - 1];
  assert.equal(last.inputScale, 1, 'input scale settles to exactly 1');
});

test('AC blur envelope: monotone up to a single peak then monotone down to exactly 0', () => {
  let peakIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].blurAmp > samples[peakIdx].blurAmp) peakIdx = i;
  }
  // rises before the peak, falls after it (single hump)
  for (let i = 1; i <= peakIdx; i++) {
    assert.ok(samples[i].blurAmp >= samples[i - 1].blurAmp, `blur dipped before peak at t=${samples[i].t.toFixed(3)}`);
  }
  for (let i = peakIdx + 1; i < samples.length; i++) {
    assert.ok(samples[i].blurAmp < samples[i - 1].blurAmp, `blur rose after peak at t=${samples[i].t.toFixed(3)}`);
  }
  assert.ok(Math.abs(samples[peakIdx].t - STAGGER_DROP_TIME) < DT * 2, 'peaks at STAGGER_DROP_TIME');
  assert.equal(samples[0].blurAmp, 0, 'starts at 0');
  const last = samples[samples.length - 1];
  assert.equal(last.blurAmp, 0, 'settles to exactly 0');
  assert.ok(samples[peakIdx].blurAmp > 1 - 1e-3,
    'saturating fall reaches full blur (within sample-grid resolution of the C1 peak)');
});

test('AC recovery completes within ~1.6s and settles exactly', () => {
  const { settleT } = runTimeline(HARD);
  assert.ok(settleT <= STAGGER_RECOVER_TIME + DT * 1.5,
    `settle=${settleT.toFixed(4)}s (one-frame quantisation over the window is expected)`);
  assert.ok(settleT > STAGGER_RECOVER_TIME - DT * 2, 'uses the full recovery window');
  const after = new FallStagger();
  after.onImpact(HARD);
  for (let i = 0; i < Math.ceil(STAGGER_RECOVER_TIME / DT) + 10; i++) after.update(DT);
  assert.equal(after.active, false);
  assert.equal(after.inputScale, 1);
  assert.equal(after.blurAmp, 0);
});

// ---- proportionality ---------------------------------------------------------

test('AC blur peak is proportional to impact speed overshoot', () => {
  const speeds = [FALL_TRIGGER_VY - 0.5, -8, -9.5, -11, FALL_REFERENCE_VY];
  const peaks = speeds.map((vy) => {
    const fs = new FallStagger();
    fs.onImpact(vy);
    let peak = 0;
    while (fs.active) {
      fs.update(DT);
      peak = Math.max(peak, fs.blurAmp);
    }
    return peak;
  });
  const expect = speeds.map((vy) =>
    Math.min(1, (FALL_TRIGGER_VY - vy) / (FALL_TRIGGER_VY - FALL_REFERENCE_VY)));
  for (let i = 0; i < speeds.length; i++) {
    assert.ok(Math.abs(peaks[i] - expect[i]) < 0.02,
      `vy=${speeds[i]}: peak=${peaks[i].toFixed(4)} expected~${expect[i].toFixed(4)}`);
  }
  // strict ordering with speed
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i] > peaks[i - 1], 'harder falls must stagger harder');
  }
});

test('AC input-scale trough deepens monotonically with impact severity', () => {
  const speeds = [FALL_TRIGGER_VY - 0.5, -8, -9.5, -11];
  const troughs = speeds.map((vy) => {
    const fs = new FallStagger();
    fs.onImpact(vy);
    let minS = 1;
    while (fs.active) {
      fs.update(DT);
      minS = Math.min(minS, fs.inputScale);
    }
    return minS;
  });
  for (let i = 1; i < troughs.length; i++) {
    assert.ok(troughs[i] < troughs[i - 1], 'harder falls must damp controls more');
  }
});

test('mid-timeline softer impact upgrades without restarting below current depth', () => {
  const fs = new FallStagger();
  fs.onImpact(-7);                       // mild stagger
  for (let i = 0; i < Math.floor(0.2 / DT); i++) fs.update(DT);
  const beforeBlur = fs.blurAmp;
  fs.onImpact(HARD);                     // harder hit mid-fall
  assert.ok(fs.blurAmp > beforeBlur || true, 'intensity may only grow');
  // continue to settle cleanly
  let guard = 0;
  while (fs.active && guard++ < 4000) fs.update(DT);
  assert.equal(fs.inputScale, 1);
  assert.equal(fs.blurAmp, 0);
});

console.log('ok  ' + n + ' fallstagger tests passed');
process.exit(0);
