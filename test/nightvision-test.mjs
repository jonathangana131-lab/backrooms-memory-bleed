/**
 * Night-vision camcorder tests (F42).
 *
 * Proves the AC: ramp envelope is monotone in each direction (~0.3 s);
 * gain noise is deterministic per (seed, tick) and bounded [0,1]; the
 * injected drain multiplier is exactly NV_DRAIN_MULTIPLIER while engaged
 * vs the torch-on baseline when off; auto-cutoff at the injected battery
 * threshold fires exactly once and only a manual toggle re-enables; the
 * audio-artifact level tracks gain noise within tight tolerance.
 *
 * Run: node test/nightvision-test.mjs  (transpiles TS in-memory like aging-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-nightvision-'));
fsMod.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fsMod.mkdirSync(path.join(tmp, 'src/gfx'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}

emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/gfx/nightvision.ts', 'src/gfx/nightvision.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const nv = await import(path.join(tmp, 'src/gfx/nightvision.mjs'));

const DT = 1 / 60;
const SEED = 424242;

function sinkRecorder() {
  return { calls: [], setDrainMultiplier(m) { this.calls.push(m); }, get last() { return this.calls[this.calls.length - 1]; } };
}

function make(seed = SEED, config = {}) {
  const sink = sinkRecorder();
  const cam = new nv.NightVision(sink, { seed, ...config });
  return { sink, cam };
}

// ---- AC: ramp shape monotone -------------------------------------------------

test('ramp-in rises monotonically over ~0.3 s; ramp-out falls monotonically', () => {
  const { cam } = make();
  assert.equal(cam.state, 'off');
  assert.equal(cam.toggle(), true);
  let prev = -1;
  let riseFrames = 0;
  while (cam.state === 'ramp-in') {
    cam.update(DT);
    assert.ok(cam.envelope >= prev, `envelope decreased during ramp-in: ${prev} -> ${cam.envelope}`);
    prev = cam.envelope;
    riseFrames++;
  }
  assert.equal(cam.state, 'on');
  assert.equal(cam.envelope, 1);
  const riseTime = riseFrames * DT;
  assert.ok(Math.abs(riseTime - nv.NV_RAMP_TIME) <= DT + 1e-9, `ramp-in took ${riseTime.toFixed(3)} s`);

  assert.equal(cam.toggle(), false);
  prev = Infinity;
  let fallFrames = 0;
  while (cam.state === 'ramp-out') {
    cam.update(DT);
    assert.ok(cam.envelope <= prev, `envelope increased during ramp-out: ${prev} -> ${cam.envelope}`);
    prev = cam.envelope;
    fallFrames++;
  }
  assert.equal(cam.state, 'off');
  assert.equal(cam.envelope, 0);
  const fallTime = fallFrames * DT;
  assert.ok(Math.abs(fallTime - nv.NV_RAMP_TIME) <= DT + 1e-9, `ramp-out took ${fallTime.toFixed(3)} s`);
});

// ---- AC: gain noise deterministic per tick seed and bounded ------------------

test('gain noise is bounded [0,1], replayable per seed, and distinct across seeds', () => {
  const a1 = make(SEED);
  const a2 = make(SEED);
  const b = make(SEED + 1);
  for (const inst of [a1, a2, b]) {
    inst.cam.toggle();
    // run well past the ramp so noise streams are compared at identical ticks
    for (let i = 0; i < 600; i++) inst.cam.update(DT);
  }
  let differs = false;
  for (let i = 0; i < 600; i++) {
    const n1 = a1.cam.gainNoise;
    assert.equal(n1, a2.cam.gainNoise, `same-seed noise diverged at tick ${a1.cam.tick}`);
    assert.ok(n1 >= 0 && n1 <= 1, `noise out of bounds: ${n1}`);
    if (n1 !== b.cam.gainNoise) differs = true;
    a1.cam.update(DT); a2.cam.update(DT); b.cam.update(DT);
  }
  assert.ok(differs, 'different seeds produced identical noise streams');
});

test('noise is keyed by frame tick, not wall time: dt stream cannot change a tick value', () => {
  const steady = make(SEED);
  const janky = make(SEED);
  steady.cam.toggle(); janky.cam.toggle();
  for (let i = 0; i < 120; i++) {
    steady.cam.update(DT);
    janky.cam.update(i % 3 === 0 ? NaN : i % 5 === 0 ? 3 * DT : DT / 7);
    assert.equal(steady.cam.gainNoise, janky.cam.gainNoise,
      `tick ${steady.cam.tick}: same tick must give same noise under junk dt`);
  }
});

// ---- AC: drain multiplier exact during ON vs OFF ------------------------------

test('drain sink sees exactly NV_DRAIN_MULTIPLIER while engaged and baseline when off', () => {
  const { sink, cam } = make();
  assert.ok(nv.NV_DRAIN_MULTIPLIER > nv.NV_BASELINE_DRAIN_MULTIPLIER, 'NV must drain faster than torch-on baseline');

  // constructor reports baseline before anything happens
  assert.equal(sink.last, nv.NV_BASELINE_DRAIN_MULTIPLIER);

  cam.toggle();
  const startIdx = sink.calls.length; // everything pushed from here on is NV drain
  while (cam.state !== 'on') cam.update(DT);
  cam.update(DT); // one fully-on frame
  assert.ok(sink.calls.slice(startIdx).every((m) => m === nv.NV_DRAIN_MULTIPLIER),
    'every pushed multiplier while engaged must be the NV multiplier');

  cam.toggle();
  while (cam.state !== 'off') cam.update(DT);
  cam.update(DT);
  cam.update(NaN); // junk frame must not flip the drain back on
  assert.equal(sink.last, nv.NV_BASELINE_DRAIN_MULTIPLIER, 'fully-off camera must report baseline drain');
});

// ---- AC: auto-cutoff fires once, manual re-enable required --------------------

test('auto-cutoff at the injected threshold fires once, latches, and manual toggle revives', () => {
  let level = 0.01; // below default threshold 0.05
  const { sink, cam } = make(SEED, { batteryLevel: () => level });
  cam.toggle();
  cam.update(DT);
  assert.equal(cam.cutoffCount, 1, 'cutoff must fire on the first active frame below threshold');
  assert.equal(cam.isCutoffLatched, true);
  assert.equal(cam.state, 'off');
  assert.equal(sink.last, nv.NV_BASELINE_DRAIN_MULTIPLIER, 'cutoff restores baseline drain');

  // keep feeding frames at a dead cell: no flap, no second fire
  for (let i = 0; i < 120; i++) cam.update(DT);
  assert.equal(cam.cutoffCount, 1, 'cutoff must not refire while latched');
  assert.equal(cam.isCutoffLatched, true);

  // battery recovers, but the latch holds: the camera stays dark
  level = 1;
  for (let i = 0; i < 120; i++) cam.update(DT);
  assert.equal(cam.state, 'off', 'recovered battery must not self-revive a latched camera');

  // manual re-enable clears the latch and the ramp proceeds
  assert.equal(cam.toggle(), true);
  assert.equal(cam.isCutoffLatched, false);
  while (cam.state !== 'on') cam.update(DT);
  assert.equal(cam.envelope, 1);
  assert.equal(sink.last, nv.NV_DRAIN_MULTIPLIER);
});

test('custom injected cutoff threshold is honored', () => {
  let level = 0.5;
  const { cam } = make(SEED, { batteryLevel: () => level, cutoffThreshold: 0.6 });
  cam.toggle();
  cam.update(DT);
  assert.equal(cam.cutoffCount, 1, 'cutoff must honor the injected threshold');
  level = 0.75;
  assert.equal(cam.toggle(), true); // manual revive above threshold
  while (cam.state !== 'on') cam.update(DT);
  assert.equal(cam.cutoffCount, 1, 'no cutoff while level stays above the threshold');
});

// ---- AC: artifact level correlates with gain noise ---------------------------

test('artifact level equals NV_ARTIFACT_GAIN x gain noise within tolerance', () => {
  const { cam } = make(SEED);
  cam.toggle();
  let maxErr = 0;
  for (let i = 0; i < 300; i++) {
    cam.update(DT);
    const n = cam.gainNoise;
    const want = Math.min(1, n * nv.NV_ARTIFACT_GAIN);
    maxErr = Math.max(maxErr, Math.abs(cam.artifactLevel - want));
    assert.ok(cam.artifactLevel >= 0 && cam.artifactLevel <= 1, `artifact out of bounds: ${cam.artifactLevel}`);
  }
  assert.ok(maxErr < 1e-9, `artifact/noise correlation error ${maxErr}`);
  cam.toggle();
  while (cam.state !== 'off') cam.update(DT);
  assert.equal(cam.artifactLevel, 0, 'artifact must be silent while off');
});

// ---- tint descriptor ----------------------------------------------------------

test('green channel dominates the tint descriptor and scales with the envelope', () => {
  const { cam } = make();
  cam.toggle();
  cam.update(DT);
  const t = cam.tint;
  assert.ok(t.g > t.r && t.g > t.b, 'IR grade must be green-dominant');
  assert.ok(t.g > 0 && t.g < nv.NV_TINT_BASE.g, 'mid-ramp tint must be scaled below base');
  while (cam.state !== 'on') cam.update(DT);
  assert.deepEqual(cam.tint, nv.NV_TINT_BASE, 'full envelope must deliver the exact base tint');
});

// ---- junk inputs ----------------------------------------------------------------

test('junk dt and missing battery source produce finite outputs, no cutoff crash', () => {
  const { cam } = make(SEED, { batteryLevel: () => NaN }); // junk telemetry disables cutoff
  cam.toggle();
  for (const dt of [NaN, Infinity, -Infinity, -DT, 0, 1e9]) cam.update(dt);
  for (const v of [cam.envelope, cam.gainNoise, cam.artifactLevel, cam.tint.r, cam.tint.g, cam.tint.b]) {
    assert.ok(Number.isFinite(v), `output must stay finite under junk dt (got ${v})`);
  }
  assert.equal(cam.cutoffCount, 0, 'non-finite battery telemetry must never trigger cutoff');
});
