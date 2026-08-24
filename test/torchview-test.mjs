/**
 * Torch view-model tests (F11).
 *
 * Proves the AC: idle sway stays inside its advertised amplitude bounds
 * and is deterministic per seed; the battery-swap beat starts and ends at
 * the rest pose within 1.2 s; the light anchor is derived from the current
 * pose by the documented Y-X-Z Euler order (so the SpotLight follows the
 * mesh head); no NaN escapes junk dt / junk speed / junk config inputs.
 *
 * Run: node test/torchview-test.mjs  (transpiles TS in-memory like aging-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-torchview-'));
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
emit('src/gfx/torchview.ts', 'src/gfx/torchview.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const tv = await import(path.join(tmp, 'src/gfx/torchview.mjs'));

const DT = 1 / 60;
const SEED_A = 1234;
const SEED_B = 98765;

/** Recorder target capturing every applied pose. */
function recorder() {
  return {
    frames: [],
    setPosition(x, y, z) { this.frames.push({ x, y, z }); },
    setRotation(rx, ry, rz) {
      const f = this.frames[this.frames.length - 1];
      if (f) { f.rx = rx; f.ry = ry; f.rz = rz; }
    },
  };
}

function make(seed, speed = () => 0, cfg = {}) {
  const target = recorder();
  const model = new tv.TorchView(target, speed, {
    seed,
    // zero rest pose so recorded coordinates ARE the motion offsets
    restPosition: { x: 0, y: 0, z: 0 },
    ...cfg,
  });
  return { target, model };
}

function run(inst, seconds, dt = DT) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) inst.model.update(dt);
  return inst;
}

// ---- AC: sway amplitudes bounded --------------------------------------------

test('idle sway stays within advertised bounds around the rest pose', () => {
  const inst = make(SEED_A);
  run(inst, 40);
  let maxYaw = 0, maxPitch = 0, maxRoll = 0, maxLat = 0, maxY = 0, maxZ = 0;
  for (const f of inst.target.frames.slice(1)) {
    maxYaw = Math.max(maxYaw, Math.abs(f.ry));
    maxPitch = Math.max(maxPitch, Math.abs(f.rx));
    maxRoll = Math.max(maxRoll, Math.abs(f.rz));
    maxLat = Math.max(maxLat, Math.abs(f.x));
    maxY = Math.max(maxY, Math.abs(f.y));
    maxZ = Math.max(maxZ, Math.abs(f.z));
  }
  assert.ok(maxYaw <= tv.SWAY_YAW_AMP + 1e-9, `yaw ${maxYaw}`);
  assert.ok(maxPitch <= tv.SWAY_PITCH_AMP + 1e-9, `pitch ${maxPitch}`);
  assert.ok(maxRoll <= tv.SWAY_ROLL_AMP + 1e-9, `roll ${maxRoll}`);
  assert.ok(maxLat <= tv.SWAY_LATERAL_AMP + 1e-9, `lateral ${maxLat}`);
  // rest offsets themselves
  assert.ok(Math.abs(maxY) <= 1e-9 && Math.abs(maxZ) <= 1e-9, 'rest y/z must be untouched at speed 0');
});

// ---- AC: deterministic per seed ---------------------------------------------

test('sway is byte-deterministic per seed and differs across seeds', () => {
  const a1 = make(SEED_A);
  const a2 = make(SEED_A);
  const b = make(SEED_B);
  run(a1, 20); run(a2, 20); run(b, 20);
  const fa = a1.target.frames, fa2 = a2.target.frames, fb = b.target.frames;
  for (let i = 0; i < fa.length; i++) {
    for (const k of ['x', 'y', 'z', 'rx', 'ry', 'rz']) {
      assert.equal(fa[i][k], fa2[i][k], `same-seed divergence frame ${i} key ${k}`);
    }
  }
  let differs = false;
  for (let i = 0; i < fa.length; i++) {
    if (fa[i].ry !== fb[i].ry || fa[i].rx !== fb[i].rx) { differs = true; break; }
  }
  assert.ok(differs, 'different seeds produced identical sway');
});

// ---- AC: walk-bob couples through injected speed ----------------------------

test('walk bob amplitude rises with injected speed and saturates past reference', () => {
  function p2p(speed) {
    const inst = make(SEED_A, () => speed);
    run(inst, 12);
    let lo = Infinity, hi = -Infinity;
    for (const f of inst.target.frames.slice(120)) { lo = Math.min(lo, f.y); hi = Math.max(hi, f.y); }
    return hi - lo;
  }
  const slow = p2p(0.5), full = p2p(tv.BOB_REF_SPEED), over = p2p(9);
  assert.ok(slow < full, `slow ${slow} should bob less than full ${full}`);
  assert.ok(Math.abs(over - full) < 1e-3, `bob must saturate: over ${over} vs full ${full}`);
});

// ---- AC: recoil kick on toggle ----------------------------------------------

test('recoil kicks backward/up on toggle and settles back to rest', () => {
  const inst = make(SEED_A);
  const control = make(SEED_A);
  run(inst, 5);
  run(control, 5);
  assert.deepEqual(inst.model.pose, control.model.pose, 'pre-kick parity');
  inst.model.kick();
  inst.model.update(DT);
  control.model.update(DT);
  const kicked = inst.model.pose;
  assert.ok(kicked.rotation.x > control.model.pose.rotation.x + 0.02, 'recoil must add upward pitch');
  assert.ok(kicked.position.z < control.model.pose.position.z - 0.005, 'recoil must push the hand back');
  run(inst, 1.5);
  run(control, 1.5);
  assert.deepEqual(inst.model.pose, control.model.pose, 'recoil must fully decay to the shared idle pose');
});

// ---- AC: battery-swap timeline sampled --------------------------------------

test('swap beat: starts and ends at the live idle pose, dips in between, <= 1.2 s', () => {
  const swapper = make(SEED_A);
  const control = make(SEED_A);
  run(swapper, 3);
  run(control, 3);

  // start state: identical trajectories -> swap begins at the live pose
  swapper.model.beginSwap();
  swapper.model.update(0); // sample the exact start pose without advancing time
  const startPose = swapper.model.pose;
  const ctlStart = control.model.pose;
  for (const part of ['position', 'rotation']) {
    assert.deepEqual(startPose[part], ctlStart[part], `swap start ${part} must equal live idle pose`);
  }

  // drive the timeline while recording elapsed time
  let elapsed = 0;
  let deepest = Infinity;
  while (swapper.model.isSwapping && elapsed < 5) {
    swapper.model.update(DT);
    control.model.update(DT);
    elapsed += DT;
    deepest = Math.min(deepest, swapper.model.pose.position.y - control.model.pose.position.y);
  }
  assert.equal(swapper.model.isSwapping, false, 'swap must finish on its own');
  assert.ok(elapsed <= tv.SWAP_MAX_DURATION, `swap took ${elapsed.toFixed(3)} s`);
  assert.ok(deepest <= -(tv.SWAP_DIP_METERS - 0.01), `hand never reached the lowered pose (${deepest})`);

  // end state: back on the identical idle trajectory
  swapper.model.update(0);
  const endPose = swapper.model.pose;
  const ctlEnd = control.model.pose;
  for (const part of ['position', 'rotation']) {
    assert.deepEqual(endPose[part], ctlEnd[part], `swap end ${part} must return to idle`);
  }

  // re-entry guard while in flight is unobservable now, so verify the API contract directly
  assert.equal(swapper.model.beginSwap(), true, 'a finished swap must allow a new one');
});

test('beginSwap is rejected while a swap is already playing', () => {
  const inst = make(SEED_A);
  run(inst, 1);
  assert.equal(inst.model.beginSwap(), true);
  assert.equal(inst.model.beginSwap(), false, 'double-swap must be refused');
  run(inst, tv.SWAP_TOTAL_TIME + 0.05);
  assert.equal(inst.model.isSwapping, false);
});

// ---- AC: light-anchor tracks pose exactly -----------------------------------

/** Independent implementation of the documented R = Ry * Rx * Rz local rotation. */
function rotateRef(v, rx, ry, rz) {
  // roll Z
  let x = v.x * Math.cos(rz) - v.y * Math.sin(rz);
  let y = v.x * Math.sin(rz) + v.y * Math.cos(rz);
  const z0 = v.z;
  // pitch X
  const y2 = y * Math.cos(rx) - z0 * Math.sin(rx);
  const z2 = y * Math.sin(rx) + z0 * Math.cos(rx);
  // yaw Y
  return {
    x: x * Math.cos(ry) + z2 * Math.sin(ry),
    y: y2,
    z: -x * Math.sin(ry) + z2 * Math.cos(ry),
  };
}

test('light anchor equals pose position plus rotated lens offset, every frame', () => {
  const anchorLocal = { x: 0.03, y: 0.06, z: 0.15 };
  const inst = make(SEED_B, () => 2.2, { anchorLocal }); // walking: bob + sway active
  for (let i = 0; i < 240; i++) {
    if (i === 100) inst.model.kick();
    if (i === 140) inst.model.beginSwap();
    inst.model.update(DT);
    const p = inst.model.pose;
    const off = rotateRef(anchorLocal, p.rotation.x, p.rotation.y, p.rotation.z);
    const want = { x: p.position.x + off.x, y: p.position.y + off.y, z: p.position.z + off.z };
    const got = inst.model.getLightAnchor();
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Math.abs(got[k] - want[k]) < 1e-12,
        `anchor ${k} diverged at frame ${i}: ${got[k]} vs ${want[k]}`);
    }
  }
});

// ---- AC: no NaN under junk inputs -------------------------------------------

test('junk dt / speed / config produce finite poses and finite anchors', () => {
  const junkSpeeds = [NaN, Infinity, -Infinity, -5, undefined];
  for (const s of junkSpeeds) {
    const inst = make(SEED_A, () => s);
    for (const dt of [NaN, Infinity, -Infinity, -DT, 0, 1e9, DT]) inst.model.update(dt);
    const p = inst.model.pose;
    for (const part of ['position', 'rotation']) {
      for (const k of ['x', 'y', 'z']) {
        assert.ok(Number.isFinite(p[part][k]), `pose.${part}.${k} with speed=${s}`);
      }
    }
    const a = inst.model.getLightAnchor();
    for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(a[k]), `anchor.${k} with speed=${s}`);
  }
  // junk config vectors
  const inst = new tv.TorchView(
    recorder(),
    () => 0,
    { seed: NaN, restPosition: { x: NaN, y: Infinity, z: 'x' }, anchorLocal: null },
  );
  for (let i = 0; i < 10; i++) inst.update(NaN);
  inst.kick(NaN);
  inst.beginSwap();
  for (let i = 0; i < 600; i++) inst.update(DT);
  const p = inst.pose;
  for (const part of ['position', 'rotation']) {
    for (const k of ['x', 'y', 'z']) assert.ok(Number.isFinite(p[part][k]), `junk-config pose.${part}.${k}`);
  }
});
