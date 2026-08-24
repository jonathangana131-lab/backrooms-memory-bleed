/**
 * Gravity-ambivalence tests (F22).
 *
 * Proves the AC: |roll| stays within ±5° for adversarial inputs; roll sign
 * follows the veer direction only after the hysteresis thresholds (noise
 * near the boundary cannot chatter it); saturation collapse returns roll to
 * zero along a continuous curve with no per-frame jumps; and identical
 * seeds plus identical input sequences replay identically.
 *
 * Run: node test/gravitytilt-test.mjs  (transpiles TS in-memory like fallstagger-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-gtilt-'));
fsMod.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}

emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/core/gravitytilt.ts', 'src/core/gravitytilt.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const { GravityTilt, TILT_MAX_DEG } =
  await import(path.join(tmp, 'src/core/gravitytilt.mjs'));

const SEED = 0x6b1a77;
const DT = 1 / 60;

// ---- AC: bounded |roll| <= 5 deg under adversarial inputs ----------------------

test('roll never exceeds ±5 deg for hostile inputs', () => {
  const adversarial = [
    { s: 1, v: 1e9, dt: 10 },
    { s: -50, v: -1e9, dt: 1e-6 },
    { s: NaN, v: NaN, dt: NaN },
    { s: Infinity, v: Infinity, dt: -Infinity },
    { s: 1e308, v: 0 / 0, dt: 12345 },
    { s: 1, v: Number.MAX_VALUE, dt: Number.MIN_VALUE },
  ];
  for (let seed = 0; seed < 4; seed++) {
    const g = new GravityTilt(seed);
    for (let i = 0; i < 5000; i++) {
      const a = adversarial[i % adversarial.length];
      const r = g.update(a.s, a.v, a.dt);
      assert.ok(Math.abs(r) <= TILT_MAX_DEG + 1e-12, `seed ${seed}: roll ${r} exceeded bound`);
      assert.equal(Number.isFinite(g.rollDeg), true, 'roll went non-finite');
    }
    assert.ok(Math.abs(g.rollDeg) <= TILT_MAX_DEG);
  }
});

test('full-strength sustained veer converges near but not beyond the bound', () => {
  const g = new GravityTilt(SEED);
  let peak = 0;
  for (let i = 0; i < 60 * 30; i++) {
    peak = Math.max(peak, Math.abs(g.update(1, 3, DT)));
  }
  assert.ok(peak > TILT_MAX_DEG * 0.9, 'strong veer at full saturation should approach the bound');
  assert.ok(peak <= TILT_MAX_DEG + 1e-12);
});

// ---- AC: sign follows veer after hysteresis threshold --------------------------

test('sign adopts only past enter threshold and holds through noise', () => {
  const g = new GravityTilt(SEED);
  // Sub-threshold drift must NOT adopt a sign:
  for (let i = 0; i < 240; i++) g.update(1, 0.8, DT);
  assert.equal(g.veerSign, 0, 'sub-enter drift adopted a veer sign');
  assert.equal(g.rollDeg, 0);
  // Sustained super-threshold veer adopts:
  for (let i = 0; i < 240; i++) g.update(1, 3, DT);
  assert.equal(g.veerSign, 1);
  assert.ok(g.rollDeg > 0, 'positive veer must tilt positive');
  // Noise around the exit threshold must NOT release or flip:
  let flipped = false;
  for (let i = 0; i < 600; i++) {
    g.update(1, i % 2 === 0 ? -0.7 : 2.0, DT); // mean stays above exit
    if (g.veerSign !== 1) flipped = true;
  }
  assert.equal(flipped, false, 'hysteresis released during boundary noise');
});

test('releasing below exit threshold returns level before any opposite adoption', () => {
  const g = new GravityTilt(SEED);
  for (let i = 0; i < 480; i++) g.update(1, 3, DT);
  assert.equal(g.veerSign, 1);
  // Drop lateral velocity toward zero: sign releases, roll decays to ~0.
  for (let i = 0; i < 480; i++) g.update(1, 0, DT);
  assert.equal(g.veerSign, 0);
  assert.ok(Math.abs(g.rollDeg) < 0.01, `residual roll ${g.rollDeg} after release`);
  // Opposite veer then adopts cleanly:
  for (let i = 0; i < 480; i++) g.update(1, -3, DT);
  assert.equal(g.veerSign, -1);
  assert.ok(g.rollDeg < 0);
});

// ---- AC: continuous return-to-zero curve when saturation drops ------------------

test('s -> 0 drives roll to zero continuously, no discontinuous jumps', () => {
  const g = new GravityTilt(SEED);
  for (let i = 0; i < 480; i++) g.update(1, 3, DT);
  const settled = Math.abs(g.rollDeg);
  assert.ok(settled > TILT_MAX_DEG * 0.5, 'precondition: visibly tilted');
  let maxJump = 0;
  for (let i = 0; i < 60 * 20 && Math.abs(g.rollDeg) > 1e-4; i++) {
    const prev = g.rollDeg;
    g.update(0, 3, DT); // saturation gone, veer irrelevant
    maxJump = Math.max(maxJump, Math.abs(g.rollDeg - prev));
  }
  assert.ok(Math.abs(g.rollDeg) < 0.01, `did not settle level: ${g.rollDeg}`);
  assert.ok(maxJump < settled * 0.25 + 0.05, `return path jumped ${maxJump} deg in one frame`);
});

test('mid-saturation zones hold proportionally smaller tilt', () => {
  const weak = new GravityTilt(SEED);
  const strong = new GravityTilt(SEED);
  for (let i = 0; i < 60 * 20; i++) {
    weak.update(0.25, 3, DT);
    strong.update(1.0, 3, DT);
  }
  assert.ok(Math.abs(weak.rollDeg) < Math.abs(strong.rollDeg),
    `weak ${weak.rollDeg} not below strong ${strong.rollDeg}`);
});

// ---- AC: determinism per seed ----------------------------------------------------

test('identical seed + inputs replay identically; different seeds differ', () => {
  const run = (seed) => {
    const g = new GravityTilt(seed);
    const trace = [];
    let v = 0;
    for (let i = 0; i < 1200; i++) {
      v = i < 400 ? 0 : i < 800 ? 2.5 : -2.5;
      trace.push(g.update((i % 300) / 300, v, DT).toFixed(6));
    }
    return trace.join(',');
  };
  assert.equal(run(SEED), run(SEED), 'same-seed traces diverged');
  assert.notEqual(run(SEED), run(SEED ^ 0xffff), 'different seeds produced identical traces');
});
