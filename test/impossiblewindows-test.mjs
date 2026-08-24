/**
 * Impossible windows (F19) tests -- pure Node, no engine objects.
 *
 * src/gfx/impossiblewindows.ts and its deps are transpiled on the fly
 * (same trick as anomalies-test). Covers: exterior-only placement,
 * deterministic tint/phase draws per windowId, exact culling at the
 * radius boundary + behind-camera cone rejection, and registry
 * serialize/deserialize round-trip identity.
 * Run: node test/impossiblewindows-test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-imwindows-'));
for (const d of ['src/core', 'src/world', 'src/gfx']) {
  fsMod.mkdirSync(path.join(tmp, d), { recursive: true });
}

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    // Node ESM needs explicit extensions on the relative cross-file import.
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}

emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/constants.ts', 'src/world/constants.mjs');
emit('src/gfx/impossiblewindows.ts', 'src/gfx/impossiblewindows.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const { CELL } = await import(path.join(tmp, 'src/world/constants.mjs'));
const {
  ImpossibleWindowRegistry, windowIdOf, windowVisible, litPhaseAt,
  WINDOW_CULL_RADIUS_M, WINDOW_CULL_CONE_RAD, LIT_PHASE_COUNT,
} = await import(path.join(tmp, 'src/gfx/impossiblewindows.mjs'));

const SEED = 0xbeef01;

/** A candidate wall face on the given cell. */
function cand(cellX, cellZ, face = 'north', exteriorFacing = true) {
  return { cellX, cellZ, face, exteriorFacing };
}

// ---- placement ----

test('propose places windows ONLY on exterior-facing cells', () => {
  const reg = new ImpossibleWindowRegistry(SEED);
  const cells = [
    cand(10, 10, 'north'),
    cand(11, 10, 'east'),
    cand(12, 10, 'south', false), // interior-facing: must never become a window
    cand(13, 10, 'west'),
    cand(14, 10, 'north', false),
  ];
  const placements = reg.propose('chunk-a', cells);
  assert.equal(placements.length, 3);
  assert.ok(placements.every((p) => p.exteriorFacing !== false));
  assert.equal(reg.get(windowIdOf('chunk-a', 12, 10, 'south')), undefined);
  assert.equal(reg.get(windowIdOf('chunk-a', 14, 10, 'north')), undefined);
  assert.equal(reg.get(windowIdOf('chunk-a', 10, 10, 'north'))?.cellX, 10);
});

test('placements carry chunk key, face, seeded tint and lit phase in range', () => {
  const reg = new ImpossibleWindowRegistry(SEED);
  const [p] = reg.propose('chunk-b', [cand(-4, 7, 'west')]);
  assert.equal(p.chunkKey, 'chunk-b');
  assert.equal(p.face, 'west');
  assert.ok(p.seededRoomTint >= 0 && p.seededRoomTint < 1);
  assert.ok(Number.isInteger(p.litPhase) && p.litPhase >= 0 && p.litPhase < LIT_PHASE_COUNT);
});

test('tint and phase are deterministic per windowId for a given seed', () => {
  const a = new ImpossibleWindowRegistry(SEED).propose('chunk-c', [
    cand(1, 2, 'north'), cand(3, 4, 'east'), cand(5, 6, 'south'), cand(7, 8, 'west'),
  ]);
  const b = new ImpossibleWindowRegistry(SEED).propose('chunk-c', [
    cand(1, 2, 'north'), cand(3, 4, 'east'), cand(5, 6, 'south'), cand(7, 8, 'west'),
  ]);
  assert.deepStrictEqual(b, a, 'same seed replays identical placements');
  // different seed draws a different palette for at least one window
  const other = new ImpossibleWindowRegistry(SEED ^ 0x77).propose('chunk-c', [
    cand(1, 2, 'north'), cand(3, 4, 'east'), cand(5, 6, 'south'), cand(7, 8, 'west'),
  ]);
  assert.notDeepStrictEqual(other, a);
});

// ---- culling ----

/** Camera at origin facing +x (repo convention: yaw -PI/2 looks down +x). */
function camAt(x, z, yaw = -Math.PI / 2) {
  return { x, z, yaw };
}

test('culling is exact at the radius boundary', () => {
  const reg = new ImpossibleWindowRegistry(SEED);
  // pick cells by their world centres: last centre inside R and first outside
  const nearCell = Math.ceil(WINDOW_CULL_RADIUS_M / CELL - 1.5); // centre < R
  const farCell = nearCell + 1; // centre > R
  assert.ok((nearCell + 0.5) * CELL < WINDOW_CULL_RADIUS_M);
  assert.ok((farCell + 0.5) * CELL > WINDOW_CULL_RADIUS_M);
  reg.propose('chunk-r', [cand(nearCell, 0, 'south'), cand(farCell, 0, 'south')]);
  const vis = reg.visible(camAt(0, 0)).map((w) => w.cellX);
  assert.ok(vis.includes(nearCell), `window centre ${(nearCell + 0.5) * CELL}m (< R) visible`);
  assert.ok(!vis.includes(farCell), `window centre ${(farCell + 0.5) * CELL}m (> R) culled`);
  // direct probes through the pure function just either side of R
  // (fractional cell coords are fine here: windowVisible is pure math)
  const winNear = { cellX: WINDOW_CULL_RADIUS_M / CELL - 0.5004, cellZ: -0.5 }; // centre at R-1mm
  const winFar = { cellX: WINDOW_CULL_RADIUS_M / CELL - 0.4996, cellZ: -0.5 }; // centre at R+1mm
  assert.equal(windowVisible(winNear, camAt(0, 0), WINDOW_CULL_RADIUS_M), true);
  assert.equal(windowVisible(winFar, camAt(0, 0), WINDOW_CULL_RADIUS_M), false);
});

test('windows behind the camera frustum cone are culled even when close', () => {
  const behind = { cellX: -8, cellZ: 0 }; // directly behind a +x-facing camera
  assert.equal(windowVisible(behind, camAt(0, 0), WINDOW_CULL_RADIUS_M), false);
  const ahead = { cellX: 8, cellZ: 0 };
  assert.equal(windowVisible(ahead, camAt(0, 0), WINDOW_CULL_RADIUS_M), true);
  // just inside the cone half-angle stays visible; just outside is culled
  const d = 20;
  const cosH = Math.cos(WINDOW_CULL_CONE_RAD);
  const zInside = Math.sqrt(Math.max(0, d * d * (1 / (cosH * cosH)) - d * d)) * 0.9;
  const zOutside = Math.sqrt(Math.max(0, d * d * (1 / (cosH * cosH)) - d * d)) * 1.1;
  const cx = Math.floor(d / CELL) - 1;
  assert.equal(windowVisible({ cellX: cx, cellZ: Math.floor(zInside / CELL) }, camAt(0, 0)), true);
  assert.equal(windowVisible({ cellX: cx, cellZ: Math.floor(zOutside / CELL) }, camAt(0, 0)), false);
});

test('registry visibility respects an injected smaller radius', () => {
  const reg = new ImpossibleWindowRegistry(SEED);
  reg.propose('chunk-v', [cand(6, 0, 'south')]); // ~16.25 m from origin
  assert.equal(reg.visible(camAt(0, 0), 20).length, 1);
  assert.equal(reg.visible(camAt(0, 0), 5).length, 0);
});

// ---- lit phases ----

test('lit-phase sequence is deterministic per windowId', () => {
  const win = { cellX: 3, cellZ: 9, litPhase: 2 };
  const seqA = [];
  const seqB = [];
  for (let step = 0; step < 32; step++) {
    seqA.push(litPhaseAt(win, step, SEED));
    seqB.push(litPhaseAt(win, step, SEED));
  }
  assert.deepStrictEqual(seqB, seqA, 'same seed same sequence');
  assert.ok(seqA.every((p) => Number.isInteger(p) && p >= 0 && p < LIT_PHASE_COUNT));
  assert.ok(new Set(seqA).size > 1, 'the phase actually advances over steps');
  // a longer recomputation agrees with the recorded prefix step for step
  const seqLong = [];
  for (let step = 0; step < 64; step++) seqLong.push(litPhaseAt(win, step, SEED));
  assert.deepStrictEqual(seqLong.slice(0, 32), seqA);
  const reg = new ImpossibleWindowRegistry(SEED);
  const [p] = reg.propose('chunk-l', [cand(3, 9, 'north')]);
  assert.equal(
    reg.phaseAt(p.windowId, 5),
    litPhaseAt({ cellX: p.cellX, cellZ: p.cellZ, litPhase: p.litPhase }, 5, SEED),
  );
  assert.equal(reg.phaseAt('missing|0|0|north', 0), -1);
});

// ---- serialize round trip ----

test('serialize/deserialize round-trips identically', () => {
  const reg = new ImpossibleWindowRegistry(SEED);
  reg.propose('chunk-s1', [cand(0, 0, 'north'), cand(1, 0, 'east')]);
  reg.propose('chunk-s2', [cand(0, 5, 'west'), cand(2, 3, 'south', false)]);
  const snap = reg.serialize();
  const jsonA = JSON.stringify(snap);
  const back = ImpossibleWindowRegistry.deserialize(JSON.parse(jsonA));
  assert.equal(JSON.stringify(back.serialize()), jsonA, 'byte-identical snapshot after round trip');
  assert.equal(back.size, reg.size);
  assert.deepStrictEqual(back.all(), reg.all());
  // behaviour parity: culling and phases answer identically post-round-trip
  const cam = camAt(1, 2, 0.3);
  assert.deepStrictEqual(back.visible(cam).map((w) => w.windowId), reg.visible(cam).map((w) => w.windowId));
  for (let step = 0; step < 8; step++) {
    for (const id of reg.all().map((w) => w.windowId)) {
      assert.equal(back.phaseAt(id, step), reg.phaseAt(id, step));
    }
  }
});
