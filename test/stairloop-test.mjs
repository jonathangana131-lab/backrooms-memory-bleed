/**
 * Unobserved stairwell loop (F20) tests -- pure Node against a fake host.
 *
 * src/director/anomalies.ts and its deps are transpiled on the fly
 * (same trick as anomalies-test). Covers: trigger fires iff gaze-away
 * exceeds LOOK_AWAY_SNAP_SEC (boundary at 1.99/2.01 s), frozen-when-
 * observed invariant, discrete progress with position recomputed from the
 * counter, deterministic progress per seed, disarm on exit + cap/cooldown,
 * and window/blackout gating.
 * Run: node test/stairloop-test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-stairloop-'));
for (const d of ['src/core', 'src/world', 'src/director']) {
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
emit('src/core/events.ts', 'src/core/events.mjs');
emit('src/world/constants.ts', 'src/world/constants.mjs');
emit('src/director/director.ts', 'src/director/director.mjs');
emit('src/director/anomalies.ts', 'src/director/anomalies.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const { Emitter } = await import(path.join(tmp, 'src/core/events.mjs'));
const {
  AnomalySystem, MIN_SPAWN_DIST, CAPS, COOLDOWNS, LOOK_AWAY_SNAP_SEC,
} = await import(path.join(tmp, 'src/director/anomalies.mjs'));

const SEED = 0xb0ca;

/**
 * Fake host: player starts far outside the spawn exclusion zone, standing
 * inside a fixed stairwell block, gaze on the flight. All F20 providers are
 * plain fields so tests can rewire them per scenario.
 */
function makeHost() {
  const BOUNDS = { minX: -5, minZ: -5, maxX: 5, maxZ: 5 };
  return {
    x: MIN_SPAWN_DIST + 60, z: 0, yaw: 0, t: 100, blackout: false,
    gazeAway: 0,
    insideBounds: true,
    placements: [], // every repositionFromProgress call, in order
    stairwellBounds() { return this.insideBounds ? BOUNDS : null; },
    gazeAwaySec() { return this.gazeAway; },
    // deterministic landing map: progress k sits at z = k * 3 metres
    repositionFromProgress(progress) {
      this.placements.push(progress);
      this.z = progress * 3;
    },
    playerPosition() { return { x: this.x, z: this.z }; },
    playerYaw() { return this.yaw; },
    elapsed() { return this.t; },
    blackoutActive() { return this.blackout; },
    edgeCodeBetweenCell() { return 0; },
    teleportPlayer(x, z) { this.x = x; this.z = z; },
    bumpChunkDrift() {},
    nearestAliveFixture() { return null; },
    setGhostLight() {},
    echoFootstep() {},
    say() {},
  };
}

/** System with an open director window by default. */
function makeSystem(host, seed = SEED) {
  const bus = new Emitter();
  const sys = new AnomalySystem(host, seed, bus); // constructor records spawn here
  host.x += MIN_SPAWN_DIST + 10; // walk out of the spawn exclusion zone
  sys.openWindow = () => bus.emit('directorEvent', { kind: 'window-open', phase: 'peak' });
  sys.closeWindow = () => bus.emit('directorEvent', { kind: 'window-close', phase: 'peak' });
  sys.openWindow();
  return sys;
}

// ---- trigger boundary ----

test('trigger fires iff gaze-away exceeds 2 s (boundary 1.99 / 2.01)', () => {
  const host = makeHost();
  const sys = makeSystem(host);
  host.gazeAway = LOOK_AWAY_SNAP_SEC - 0.01; // 1.99 s: not yet wrong enough
  sys.update(0.1); sys.update(0.1);
  assert.equal(sys.usage()['stairwell-loop'], 0, 'no trigger at 1.99 s');
  assert.equal(sys.inStairwellLoop(), false);
  assert.equal(host.placements.length, 0);

  host.gazeAway = LOOK_AWAY_SNAP_SEC + 0.01; // 2.01 s: the loop begins
  sys.update(0.1);
  assert.equal(sys.usage()['stairwell-loop'], 1, 'triggered just past the boundary');
  assert.equal(sys.inStairwellLoop(), true);
  assert.equal(host.placements.length, 1, 'first discrete landing placed');
  assert.ok(Number.isInteger(host.placements[0]) && host.placements[0] >= 1);
  sys.dispose();
});

test('exactly at 2 s the loop has not started', () => {
  const host = makeHost();
  const sys = makeSystem(host);
  host.gazeAway = LOOK_AWAY_SNAP_SEC;
  sys.update(0.1);
  assert.equal(sys.usage()['stairwell-loop'], 0);
  sys.dispose();
});

// ---- frozen-when-observed ----

test('looking back freezes mid-loop; geometry state stays consistent', () => {
  const host = makeHost();
  const sys = makeSystem(host);
  host.gazeAway = LOOK_AWAY_SNAP_SEC + 0.01;
  sys.update(0.1);
  const progressAfterTrigger = host.placements.at(-1);
  assert.equal(sys.inStairwellLoop(), true);

  // the player looks back: seconds of observation change nothing at all
  host.gazeAway = 0;
  for (let i = 0; i < 20; i++) sys.update(0.25); // 5 observed seconds
  assert.deepEqual(host.placements, [progressAfterTrigger], 'no movement while observed');

  // gaze wanders again: a fresh absence needs its own 2 s, then lands once
  host.gazeAway = LOOK_AWAY_SNAP_SEC + 0.4;
  sys.update(0.1);
  assert.equal(host.placements.length, 2, 'one discrete landing for the fresh absence');
  assert.ok(host.placements[1] > host.placements[0], 'progress counter increased');
  assert.equal(host.z, host.placements.at(-1) * 3, 'position recomputed from progress');
  // a longer continuous absence buys one landing per further full interval
  host.gazeAway = LOOK_AWAY_SNAP_SEC * 2 + 0.9;
  sys.update(0.1);
  assert.equal(host.placements.length, 3, 'second full interval past the threshold');
  sys.dispose();
});

// ---- determinism ----

/** Scripted episode: trigger, then a long unobserved stretch, then freeze. */
function scriptedTrace(seed) {
  const host = makeHost();
  const sys = makeSystem(host, seed);
  host.gazeAway = LOOK_AWAY_SNAP_SEC + 0.01;
  sys.update(0.1);
  host.gazeAway = LOOK_AWAY_SNAP_SEC * 9 + 0.5;
  for (let i = 0; i < 10; i++) sys.update(0.1);
  host.dispose = undefined;
  sys.dispose();
  return { placements: [...host.placements], finalZ: host.z };
}

test('progress is deterministic per seed', () => {
  const a = scriptedTrace(SEED);
  const b = scriptedTrace(SEED);
  assert.deepStrictEqual(b, a, 'same seed replays the identical loop');
  assert.ok(a.placements.length >= 3, 'the long absence produced several landings');
  // a different seed walks its own (valid) sequence
  const other = scriptedTrace(SEED ^ 0x9e37);
  assert.ok(other.placements.length >= 1 && other.placements.every(Number.isInteger));
});

// ---- disarm on exit, cap and cooldown ----

test('leaving the stairwell disarms the loop; caps and cooldowns hold', () => {
  const host = makeHost();
  const sys = makeSystem(host);
  host.gazeAway = LOOK_AWAY_SNAP_SEC + 0.01;
  sys.update(0.1);
  assert.equal(sys.inStairwellLoop(), true);

  host.insideBounds = false; // walk out mid-episode
  sys.update(0.1);
  assert.equal(sys.inStairwellLoop(), false, 'disarmed on exit');

  host.t += COOLDOWNS['stairwell-loop'] + 1; // age past the cooldown
  host.insideBounds = true;
  host.gazeAway = LOOK_AWAY_SNAP_SEC + 0.5;
  sys.update(0.1);
  assert.equal(sys.inStairwellLoop(), true, 're-arms fresh inside new bounds');
  host.placements.length = 0;

  host.insideBounds = false; sys.update(0.1);
  host.t += COOLDOWNS['stairwell-loop'] + 1;
  host.insideBounds = true;
  sys.update(0.1);
  assert.equal(sys.inStairwellLoop(), false, 'hard session cap reached');
  assert.equal(sys.usage()['stairwell-loop'], CAPS['stairwell-loop']);
  sys.dispose();
});

test('stairwell loop obeys director windows and blackouts', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = new AnomalySystem(host, SEED, bus); // window closed
  host.x += MIN_SPAWN_DIST + 10;
  host.gazeAway = LOOK_AWAY_SNAP_SEC * 5;
  sys.update(0.1); sys.update(0.1);
  assert.equal(sys.usage()['stairwell-loop'], 0, 'nothing fires outside a window');

  bus.emit('directorEvent', { kind: 'window-open', phase: 'build' });
  host.blackout = true;
  sys.update(0.1);
  assert.equal(sys.usage()['stairwell-loop'], 0, 'nothing fires during a blackout');
  host.blackout = false;
  sys.update(0.1);
  assert.equal(sys.usage()['stairwell-loop'], 1, 'fires once the window is clean');
  sys.dispose();
});
