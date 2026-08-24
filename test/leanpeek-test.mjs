/**
 * Lean/peek tests (F10): Q/E lean envelope, camera roll + lateral parallax,
 * ease-in/out over ~0.18 s, toggle vs hold semantics, and the blocked-lean
 * safety clamp against a wall fixture.
 *
 * Runs with plain node (node test/leanpeek-test.mjs): the TypeScript source is
 * transpiled in-memory with the repo's own typescript dep - no browser needed.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// ---- tiny CJS-in-memory loader ----
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
  LeanPeek, LeanPeekMode,
  LEAN_ROLL_MAX, LEAN_OFFSET_MAX, LEAN_EASE_TIME, LEAN_HEAD_RADIUS, LEAN_MARGIN,
} = loadModule('src/player/leanpeek.ts');

const DT = 1 / 60;
const TOL = 1e-3;
let n = 0;
const test = (name, fn) => { n++; fn(); console.log('ok  ' + name); };

// ---- fixtures -------------------------------------------------------------

/** Circle-vs-AABB overlap with the documented margin; boxes are {minX,maxX,minZ,maxZ}. */
function makeWorld(boxes) {
  return {
    headBlocked(x, z) {
      const r = LEAN_HEAD_RADIUS + LEAN_MARGIN;
      for (const b of boxes) {
        const cx = Math.max(b.minX, Math.min(x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
        if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
      }
      return false;
    },
  };
}
const EMPTY_WORLD = makeWorld([]);

/**
 * Harness around one LeanPeek in Hold mode by default.
 * yaw = 0 puts view-right on +x (Babylon: right = (cos yaw, -sin yaw)).
 */
function harness(mode) {
  const lp = new LeanPeek(mode ?? LeanPeekMode.Hold);
  const pose = { yaw: 0, bodyX: 0, bodyZ: 0 };
  let last = null;
  const stepOnce = (leanLeft = false, leanRight = false, world = EMPTY_WORLD) => {
    last = lp.update(DT, { leanLeft, leanRight, ...pose }, world);
    return last;
  };
  const hold = (seconds, side, world) => {
    let out;
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) out = stepOnce(side === 'left', side === 'right', world);
    return out;
  };
  return { lp, pose, stepOnce, hold, last: () => last };
}

// ---- envelope basics --------------------------------------------------------

test('no input: upright, zero offsets and roll', () => {
  const h = harness();
  const s = h.hold(0.4);
  const zeroish = (v) => Math.abs(v) < 1e-12;
  assert.ok(zeroish(s.amount), 'amount=' + s.amount);
  assert.ok(zeroish(s.roll), 'roll=' + s.roll);
  assert.ok(zeroish(s.offsetX), 'offsetX=' + s.offsetX);
  assert.ok(zeroish(s.offsetZ), 'offsetZ=' + s.offsetZ);
  assert.equal(h.lp.leaning, false);
});

test('AC full lean toward an open corridor reaches max parallax and roll ceiling', () => {
  const h = harness();
  const s = h.hold(0.6, 'right');
  assert.ok(Math.abs(s.amount - 1) < TOL, 'amount=' + s.amount);
  assert.ok(Math.abs(s.offsetX - LEAN_OFFSET_MAX) < 1e-6,
    `offsetX=${s.offsetX} max=${LEAN_OFFSET_MAX}`);
  assert.ok(Math.abs(s.roll - LEAN_ROLL_MAX) < 1e-6, 'roll=' + s.roll);
  // left lean mirrors
  const hl = harness();
  const sl = hl.hold(0.6, 'left');
  assert.ok(Math.abs(sl.amount + 1) < TOL, 'amount=' + sl.amount);
  assert.ok(Math.abs(sl.roll + LEAN_ROLL_MAX) < 1e-6, 'roll=' + sl.roll);
});

test('ease-in/out: ~LEAN_EASE_TIME to full lean and back to zero', () => {
  const h = harness();
  const half = h.hold(LEAN_EASE_TIME / 2, 'right');
  assert.ok(half.amount > 0 && half.amount < 0.9,
    'halfway through the ease should be partial: ' + half.amount);
  const full = h.hold(LEAN_EASE_TIME / 2 + DT, 'right');
  assert.ok(Math.abs(full.amount - 1) < TOL, 'full after ~0.18s: ' + full.amount);
  const back = h.hold(LEAN_EASE_TIME + DT);
  assert.equal(back.amount, 0);
  assert.equal(h.lp.leaning, false);
});

test('outputs never exceed their documented clamp bounds during the sweep', () => {
  const h = harness();
  for (let i = 0; i < Math.ceil(1.5 / DT); i++) {
    const side = i < 40 ? '' : (i < 90 ? 'right' : (i < 130 ? 'left' : ''));
    const s = h.stepOnce(side === 'left', side === 'right');
    assert.ok(Math.abs(s.roll) <= LEAN_ROLL_MAX + 1e-9, 'roll=' + s.roll);
    assert.ok(Math.abs(s.offsetX) <= LEAN_OFFSET_MAX + 1e-9, 'offsetX=' + s.offsetX);
    assert.ok(Math.hypot(s.offsetX, s.offsetZ) <= LEAN_OFFSET_MAX + 1e-9, 'offset magnitude');
    assert.ok(Math.abs(s.amount) <= 1 + 1e-9, 'amount=' + s.amount);
  }
});

test('both keys at once resolves to no lean', () => {
  const h = harness();
  const s = h.hold(0.4, undefined);
  void s;
  let out;
  for (let i = 0; i < Math.round(0.3 / DT); i++) out = h.stepOnce(true, true);
  assert.equal(out.amount, 0);
});

// ---- toggle semantics -------------------------------------------------------

test('toggle mode: press once leans (held or not), press again releases', () => {
  const h = harness(LeanPeekMode.Toggle);
  h.stepOnce(false, true); // rising edge -> engage right
  const engaged = h.hold(0.4, undefined);
  void engaged;
  // key released: lean persists (toggle latched)
  let held = null;
  for (let i = 0; i < Math.round(0.2 / DT); i++) held = h.stepOnce(false, false);
  assert.ok(Math.abs(held.amount - 1) < TOL, 'latched after release: ' + held.amount);
  // press again -> release
  h.stepOnce(false, true);
  let out = null;
  for (let i = 0; i < Math.round(0.3 / DT); i++) out = h.stepOnce(false, false);
  assert.equal(out.amount, 0);
});

// ---- blocked-lean safety ----------------------------------------------------

test('AC leaning toward a wall clamps short of head-circle penetration', () => {
  // wall face at x = 0.55; a full lean would push the head centre to x = 0.45,
  // whose circle (+margin) penetrates the face (0.45 + 0.26 + 0.04 > 0.55)
  const wall = [{ minX: 0.55, maxX: 2.5, minZ: -2, maxZ: 2 }];
  const world = makeWorld(wall);
  const h = harness();
  const s = h.hold(0.8, 'right', world);

  assert.ok(s.amount < 1, 'clamp must stop short of full lean: ' + s.amount);
  assert.ok(s.amount > 0.2, 'clamp must still allow a useful peek: ' + s.amount);
  // direct geometric proof: the final head centre does not penetrate the wall
  const hx = h.pose.bodyX + s.offsetX;
  const hz = h.pose.bodyZ + s.offsetZ;
  assert.equal(world.headBlocked(hx, hz), false, 'head circle must stay clear of the wall');
  const gap = 0.55 - hx;
  assert.ok(gap >= LEAN_HEAD_RADIUS + LEAN_MARGIN - 1e-6,
    `gap=${gap} must cover radius+margin`);
});

test('blocked lean eases smoothly and recovers when stepping back from the wall', () => {
  const wall = [{ minX: 0.35, maxX: 2.5, minZ: -2, maxZ: 2 }];
  const world = makeWorld(wall);
  const h = harness();
  const s = h.hold(0.8, 'right', world);
  assert.ok(s.amount > 0, 'some peek remains even against a near wall');
  assert.equal(world.headBlocked(h.pose.bodyX + s.offsetX, h.pose.bodyZ + s.offsetZ), false);
  // walk the body back away from the wall: the clamp must open up to full
  for (let i = 0; i < Math.round(1.2 / DT); i++) {
    h.pose.bodyX -= 1.2 * DT;
    h.stepOnce(false, true, world);
  }
  const free = h.last();
  assert.ok(Math.abs(free.amount - 1) < TOL, 'clears to full once clear of the wall: ' + free.amount);
});

console.log('ok  ' + n + ' leanpeek tests passed');
process.exit(0);
