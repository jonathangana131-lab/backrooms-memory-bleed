/**
 * Vault/mantle tests (F13): trigger conditions, the C1-continuous dip curve
 * (starts/ends at 0, single minimum, bounded depth), total duration <= 0.6 s,
 * and no collider clip during traversal against a box fixture.
 *
 * Runs with plain node (node test/vault-test.mjs): the TypeScript source is
 * transpiled in-memory with the repo's own typescript dep - no browser needed.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// ---- tiny CJS-in-memory loader (vault.ts has no imports) ----
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
  VaultController,
  VAULT_DURATION, VAULT_DIP_DEPTH, VAULT_CLEARANCE,
  VAULT_DISTANCE, VAULT_MIN_TOP, VAULT_MAX_TOP, VAULT_COOLDOWN,
} = loadModule('src/player/vault.ts');

const DT = 1 / 240; // fine step so per-frame geometry checks can't skip a clip
let n = 0;
const test = (name, fn) => { n++; fn(); console.log('ok  ' + name); };

// yaw = -PI/2 => forward = (-sin(-PI/2), -cos(-PI/2)) = (+1, 0): vaulting +x
const POSE = { forward: true, jumpPressed: true, yaw: -Math.PI / 2, x: 0, z: 0 };

// crate: waist-high box ahead of the player along +x (0.6 m deep)
const CRATE = { minX: 0.45, maxX: 1.05, minZ: -0.4, maxZ: 0.4, top: 0.75 };

/** Height-query fixture over axis-aligned boxes. */
function makeWorld(boxes) {
  return {
    obstacleTop(x, z) {
      let top = 0;
      for (const b of boxes) {
        if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && b.top > top) top = b.top;
      }
      return top;
    },
  };
}

/** Drives a full vault against `boxes`, recording every frame. */
function runVault(boxes, dt = DT) {
  const world = makeWorld(boxes);
  const vc = new VaultController();
  const frames = [];
  // trigger frame
  let f = vc.update(dt, { ...POSE }, world);
  assert.ok(vc.active, 'vault must start against a vaultable crate');
  frames.push({ ...f });
  let guard = 0;
  while (vc.active && guard++ < 4000) {
    f = vc.update(dt, { ...POSE, forward: false, jumpPressed: false }, world);
    frames.push({ ...f });
  }
  return { frames, steps: guard };
}

// ---- trigger conditions -----------------------------------------------------

test('forward + jump against a waist-high crate starts a vault', () => {
  runVault([CRATE]); // asserts active inside
});

test('no vault without jump press', () => {
  const vc = new VaultController();
  vc.update(DT, { ...POSE, jumpPressed: false }, makeWorld([CRATE]));
  assert.equal(vc.active, false);
});

test('no vault without forward input', () => {
  const vc = new VaultController();
  vc.update(DT, { ...POSE, forward: false }, makeWorld([CRATE]));
  assert.equal(vc.active, false);
});

test('too-tall wall cannot be vaulted', () => {
  const wall = { ...CRATE, top: VAULT_MAX_TOP + 0.4 };
  const vc = new VaultController();
  vc.update(DT, { ...POSE }, makeWorld([wall]));
  assert.equal(vc.active, false);
});

test('knee-high step is below the vault threshold', () => {
  const step = { ...CRATE, top: VAULT_MIN_TOP - 0.1 };
  const vc = new VaultController();
  vc.update(DT, { ...POSE }, makeWorld([step]));
  assert.equal(vc.active, false);
});

test('blocked landing spot cancels the vault', () => {
  const far = { minX: VAULT_DISTANCE - 0.2, maxX: VAULT_DISTANCE + 0.5, minZ: -0.4, maxZ: 0.4, top: 0.9 };
  const vc = new VaultController();
  vc.update(DT, { ...POSE }, makeWorld([CRATE, far]));
  assert.equal(vc.active, false);
});

// ---- dip curve AC -----------------------------------------------------------

test('AC dip curve: zero endpoints, single minimum, depth within bounds', () => {
  const { frames } = runVault([CRATE]);
  const dips = frames.map((f) => f.camDip);
  assert.ok(Math.abs(dips[0]) < 1e-9, 'starts at 0');
  assert.ok(Math.abs(dips[dips.length - 1]) < 1e-9 || Math.abs(dips[dips.length - 2]) < 1e-9,
    'ends at 0: tail=' + JSON.stringify(dips.slice(-3)));
  for (const d of dips) {
    assert.ok(d <= 0 && d >= -VAULT_DIP_DEPTH - 1e-9, `dip ${d} outside [-${VAULT_DIP_DEPTH}, 0]`);
  }
  // single minimum: first differences flip sign exactly once
  let signChanges = 0;
  for (let i = 1; i < dips.length; i++) {
    const d = dips[i] - dips[i - 1];
    if (i > 1 && Math.sign(d) !== 0 && Math.sign(d) !== Math.sign(dips[i - 1] - dips[i - 2])) signChanges++;
  }
  assert.equal(signChanges, 1, 'exactly one down->up transition');
  const maxDepth = Math.min(...dips);
  assert.ok(Math.abs(maxDepth + VAULT_DIP_DEPTH) < 1e-6,
    `peak=${maxDepth} should reach -${VAULT_DIP_DEPTH}`);
});

test('AC C1 continuity: dip derivative is continuous with zero end slopes', () => {
  const { frames } = runVault([CRATE]);
  const t = frames.map((_, i) => i * DT);
  const d = frames.map((f) => f.camDip);
  const slope = (i) => (d[Math.min(i + 1, d.length - 1)] - d[Math.max(i - 1, 0)]) / (t[Math.min(i + 1, t.length - 1)] - t[Math.max(i - 1, 0)]);
  // analytic slopes are 0 at both ends; at a finite sample step the endpoint
  // difference quotient stays within a small fraction of the peak slope
  const PEAK_SLOPE = VAULT_DIP_DEPTH * Math.PI / VAULT_DURATION; // ~1.03 /s
  assert.ok(Math.abs(slope(0)) < 0.05 * PEAK_SLOPE, 'start slope=' + slope(0));
  assert.ok(Math.abs(slope(d.length - 2)) < 0.05 * PEAK_SLOPE, 'end slope=' + slope(d.length - 2));
  // consecutive central-difference slopes never jump discontinuously
  let maxJump = 0;
  for (let i = 1; i < d.length - 1; i++) {
    maxJump = Math.max(maxJump, Math.abs(slope(i) - slope(i - 1)));
  }
  assert.ok(maxJump < 0.5, 'derivative jumps by ' + maxJump + ' between samples');
});

test('AC total traversal duration is at most 0.6 s', () => {
  const { frames } = runVault([CRATE]);
  const dur = frames.length * DT;
  assert.ok(dur <= 0.6 + 1e-9, `duration=${dur.toFixed(3)}s`);
  assert.ok(Math.abs(dur - VAULT_DURATION) < DT * 2, 'matches VAULT_DURATION');
});

// ---- no-clip traversal ------------------------------------------------------

test('AC circle never intersects crate interior during traversal', () => {
  const R = 0.34;
  const { frames } = runVault([CRATE]);
  let x = 0, z = 0, overlaps = 0;
  for (const f of frames) {
    x += f.dx; z += f.dz;
    // planar circle-vs-box footprint overlap?
    const cx = Math.max(CRATE.minX, Math.min(x, CRATE.maxX));
    const cz = Math.max(CRATE.minZ, Math.min(z, CRATE.maxZ));
    const planarOverlap = (x - cx) ** 2 + (z - cz) ** 2 < R * R;
    if (planarOverlap) {
      overlaps++;
      assert.ok(f.eyeLift >= CRATE.top - 1e-9,
        `clip at x=${x.toFixed(3)}: lift=${f.eyeLift.toFixed(3)} top=${CRATE.top}`);
    }
  }
  assert.ok(overlaps > 10, 'traversal must actually cross the crate footprint');
});

test('traversal ends past the crate and back on the floor', () => {
  const { frames } = runVault([CRATE]);
  const last = frames[frames.length - 1];
  const x = frames.reduce((ax, f) => ax + f.dx, 0);
  const z = frames.reduce((az, f) => az + f.dz, 0);
  assert.ok(x >= 1.39 + 1e-3, `landing x=${x.toFixed(3)} clears crate front face + radius`);
  assert.ok(Math.abs(z) < 1e-9, 'path stays straight');
  assert.ok(last.eyeLift < 1e-9, 'eye back on floor: ' + last.eyeLift);
  assert.ok(Math.abs(last.camDip) < 1e-9, 'dip settled: ' + last.camDip);
  assert.equal(last.active, false);
});

test('lift clears obstacle top plus VAULT_CLEARANCE on the plateau', () => {
  const { frames } = runVault([CRATE]);
  const peakLift = Math.max(...frames.map((f) => f.eyeLift));
  assert.ok(Math.abs(peakLift - (CRATE.top + VAULT_CLEARANCE)) < 1e-6,
    `peak lift ${peakLift} != top+clearance`);
});

test('cooldown blocks immediate re-vault after landing', () => {
  const world = makeWorld([CRATE]);
  const vc = new VaultController();
  let guard = 0;
  vc.update(DT, { ...POSE }, world);
  while (vc.active && guard++ < 4000) {
    vc.update(DT, { ...POSE, forward: false, jumpPressed: false }, world);
  }
  vc.update(0.01, { ...POSE }, world); // still inside cooldown
  assert.equal(vc.active, false, 'cooldown must block re-trigger');
  vc.update(VAULT_COOLDOWN, { ...POSE }, world);
  assert.equal(vc.active, true, 'after cooldown a new vault may start');
});

console.log('ok  ' + n + ' vault tests passed');
process.exit(0);
