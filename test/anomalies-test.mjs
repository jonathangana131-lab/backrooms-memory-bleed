/**
 * Spatial anomaly system tests -- pure Node against a fake AnomalyHost.
 *
 * src/director/anomalies.ts, src/world/chunkDeltas.ts and their deps are
 * transpiled on the fly into a temp dir (same trick as checkpoints-test).
 * Covers: trigger gating math, session caps + cooldowns, seeded doorway
 * selection, corridor stretch/snapback, mirror-step echoes, and
 * ChunkDeltas reversibility (drift is deterministic and revertible).
 * Run: node test/anomalies-test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-anomalies-'));
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
emit('src/director/persona.ts', 'src/director/persona.mjs');
emit('src/director/director.ts', 'src/director/director.mjs');
emit('src/world/chunkDeltas.ts', 'src/world/chunkDeltas.mjs');
emit('src/director/anomalies.ts', 'src/director/anomalies.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const { hash2i, rand2 } = await import(path.join(tmp, 'src/core/rng.mjs'));
const { Emitter } = await import(path.join(tmp, 'src/core/events.mjs'));
const { EdgeCode } = await import(path.join(tmp, 'src/world/constants.mjs'));
const { HorrorDirector } = await import(path.join(tmp, 'src/director/director.mjs'));
const {
  AnomalySystem, checkGate, isHauntedDoorway, facingDeviation,
  MIN_SPAWN_DIST, CAPS, COOLDOWNS, LOOK_AWAY_SNAP_SEC, MIRROR_ECHO_DELAY_SEC,
} = await import(path.join(tmp, 'src/director/anomalies.mjs'));
const { ChunkDeltas, applyDecorDrift } = await import(path.join(tmp, 'src/world/chunkDeltas.mjs'));

// ---- fake host -------------------------------------------------------------

const SEED = 0xa11ce;
/** Player starts at the origin; spawn is recorded there by the constructor. */
function makeHost() {
  const host = {
    x: 0, z: 0, yaw: 0, t: 100, blackout: false,
    teleports: [], bumps: [], echoes: [], says: [], ghost: [],
    edgeFn: () => EdgeCode.OPEN,
    playerPosition() { return { x: host.x, z: host.z }; },
    playerYaw() { return host.yaw; },
    elapsed() { return host.t; },
    blackoutActive() { return host.blackout; },
    edgeCodeBetweenCell(fx, fz, tx, tz) { return host.edgeFn(fx, fz, tx, tz); },
    teleportPlayer(x, z) { host.teleports.push([x, z]); host.x = x; host.z = z; },
    bumpChunkDrift(cx, cz) { host.bumps.push([cx, cz]); },
    nearestAliveFixture() { return null; },
    setGhostLight(x, z, i) { host.ghost.push([x, z, i]); },
    echoFootstep(pan, vol) { host.echoes.push({ pan, vol }); },
    say(text) { host.says.push(text); },
  };
  return host;
}

/** Anomaly system with the player far enough from spawn to be triggerable. */
function makeSystem(host, bus) {
  const sys = new AnomalySystem(host, SEED, bus);
  host.x = MIN_SPAWN_DIST + 60; // walk out of the spawn exclusion zone
  return sys;
}

function openWindow(bus, phase = 'peak') {
  bus.emit('directorEvent', { kind: 'window-open', phase });
}

function closeWindow(bus, phase = 'peak') {
  bus.emit('directorEvent', { kind: 'window-close', phase });
}

/** Deterministically find haunted doorway edges for SEED. */
function findHauntedDoors(count) {
  const doors = [];
  for (let fx = 100; fx < 200 && doors.length < count; fx++) {
    for (let fz = 100; fz < 200 && doors.length < count; fz++) {
      if (isHauntedDoorway(fx, fz, fx + 1, fz, SEED)) doors.push([fx, fz, fx + 1, fz]);
    }
  }
  assert.ok(doors.length >= count, 'seeded haunted doorways should exist');
  return doors;
}

// ---- gating math ----

test('checkGate refuses everything outside an open director window', () => {
  const base = { kind: 'mirror-steps', now: 500, distFromSpawn: 500, blackout: false, armed: false, lastFiredAt: -1, usesSoFar: 0 };
  assert.equal(checkGate(base).allowed, false);
  assert.equal(checkGate(base).reason, 'window-closed');
});

test('checkGate refuses anomalies during a blackout', () => {
  const v = checkGate({ kind: 'mirror-steps', now: 500, distFromSpawn: 500, blackout: true, armed: true, lastFiredAt: -1, usesSoFar: 0 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'blackout');
});

test('checkGate keeps anomalies away from the spawn point', () => {
  const v = checkGate({ kind: 'mirror-steps', now: 500, distFromSpawn: MIN_SPAWN_DIST - 0.01, blackout: false, armed: true, lastFiredAt: -1, usesSoFar: 0 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'too-close-to-spawn');
  // exactly at the threshold distance is allowed
  const ok = checkGate({ kind: 'mirror-steps', now: 500, distFromSpawn: MIN_SPAWN_DIST, blackout: false, armed: true, lastFiredAt: -1, usesSoFar: 0 });
  assert.equal(ok.allowed, true);
});

test('checkGate enforces hard per-session caps', () => {
  for (const kind of ['doorway-deja-vu', 'corridor-stretch', 'migrating-lights', 'mirror-steps']) {
    const v = checkGate({ kind, now: 99999, distFromSpawn: 1000, blackout: false, armed: true, lastFiredAt: -1, usesSoFar: CAPS[kind] });
    assert.equal(v.allowed, false, kind);
    assert.equal(v.reason, 'cap-reached', kind);
  }
});

test('checkGate enforces cooldowns but allows refiring after them', () => {
  const v = checkGate({ kind: 'doorway-deja-vu', now: COOLDOWNS['doorway-deja-vu'] - 0.5, distFromSpawn: 1000, blackout: false, armed: true, lastFiredAt: 0, usesSoFar: 1 });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'cooldown');
  const ok = checkGate({ kind: 'doorway-deja-vu', now: COOLDOWNS['doorway-deja-vu'], distFromSpawn: 1000, blackout: false, armed: true, lastFiredAt: 0, usesSoFar: 1 });
  assert.equal(ok.allowed, true);
});

// ---- seeded doorway selection ----

test('haunted doorway selection is deterministic per edge and seed-sensitive', () => {
  for (let i = 0; i < 50; i++) {
    const fx = 10 + i, fz = 20 + i;
    assert.equal(isHauntedDoorway(fx, fz, fx + 1, fz, SEED), isHauntedDoorway(fx, fz, fx + 1, fz, SEED));
  }
  // the mirrored edge id must not collide: (fx,fz)->(fx+1,fz) vs (fx+1,fz)->(fx,fz)
  const fwd = [];
  const rev = [];
  for (let fz = 0; fz < 400; fz++) {
    if (isHauntedDoorway(50, fz, 51, fz, SEED)) fwd.push(fz);
    if (isHauntedDoorway(51, fz, 50, fz, SEED)) rev.push(fz);
  }
  assert.notDeepStrictEqual(fwd, rev);
});

// ---- doorway deja-vu through the system ----

test('haunted doorway crossing throws the player back and drifts both chunks', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = makeSystem(host, bus);
  openWindow(bus);
  const [fx, fz, tx, tz] = findHauntedDoors(1)[0];
  host.x = 91; // just inside a chunk so the back-off lands across the border
  host.edgeFn = (a, b, c, d) => (a === fx && b === fz && c === tx && d === tz ? EdgeCode.DOORWAY : EdgeCode.OPEN);
  const before = { x: host.x, z: host.z };
  sys.noteCellCrossing(fx, fz, tx, tz);
  assert.equal(host.teleports.length, 1, 'player displaced once');
  const [nx, nz] = host.teleports[0];
  // thrown back opposite to the crossing direction (+x here)
  assert.ok(nx < before.x - CELL_BACK_MIN(), 'moved back along the crossing axis');
  assert.equal(nz, before.z, 'no lateral displacement');
  // exactly one drift step on the chunk on each side of the door
  assert.equal(host.bumps.length, 2);
  assert.deepEqual([...new Set(host.bumps.map((b) => b.join(',')))].length, 2, 'two distinct chunks drifted');
  assert.ok(host.says.length >= 1, 'the room says something is wrong');
  sys.dispose();
});

function CELL_BACK_MIN() { return 2.5 * 3.5 - 0.001; } // CELL * DEJA_BACK_MIN

test('deja-vu respects cooldown then hard session cap', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = makeSystem(host, bus);
  openWindow(bus);
  const doors = findHauntedDoors(CAPS['doorway-deja-vu'] + 2);
  host.edgeFn = (a, b, c, d) =>
    doors.some(([fx, fz, tx, tz]) => a === fx && b === fz && c === tx && d === tz) ? EdgeCode.DOORWAY : EdgeCode.OPEN;
  let fired = 0;
  for (let i = 0; i < doors.length; i++) {
    const [fx, fz, tx, tz] = doors[i];
    const before = host.teleports.length;
    host.t += COOLDOWNS['doorway-deja-vu'] + 1; // age past any cooldown
    sys.noteCellCrossing(fx, fz, tx, tz);
    if (host.teleports.length > before) fired++;
  }
  assert.equal(fired, CAPS['doorway-deja-vu'], 'stops at exactly the session cap');
  assert.equal(sys.usage()['doorway-deja-vu'], CAPS['doorway-deja-vu']);
  sys.dispose();
});

// ---- corridor stretch ----

test('straight hallways stretch while walked and snap back when unobserved', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = makeSystem(host, bus);
  openWindow(bus);
  // all edges OPEN along +x from cell (10,10): a straight hallway
  host.edgeFn = () => EdgeCode.OPEN;
  host.yaw = -Math.PI / 2; // facing +x (facing vector is (-sin yaw, -cos yaw))
  sys.noteCellCrossing(10, 10, 11, 10); // run = 1, not yet straight enough
  assert.equal(host.teleports.length, 0);
  sys.noteCellCrossing(11, 10, 12, 10); // activates and steals the first step
  assert.equal(sys.usage()['corridor-stretch'], 1, 'stretch counted once on activation');
  assert.ok(host.x < MIN_SPAWN_DIST + 60, 'player pulled back along the hallway');
  const xWhileStretched = host.x;
  host.t += 0.6; // walk long enough to cross the next cell for real
  sys.noteCellCrossing(12, 10, 13, 10);
  assert.ok(host.x < xWhileStretched, 'hallway keeps stealing ground per crossing');
  // observed: looking down the hallway never snaps back
  host.t += 1; sys.update(1); host.t += 1; sys.update(1);
  assert.ok(host.says.length === 0, 'no snapback while the player watches');
  // look away for LOOK_AWAY_SNAP_SEC and the hallway collapses forward
  host.yaw = 0; // facing -z: fully off-axis
  host.t += LOOK_AWAY_SNAP_SEC / 2; sys.update(LOOK_AWAY_SNAP_SEC / 2);
  host.t += LOOK_AWAY_SNAP_SEC; sys.update(LOOK_AWAY_SNAP_SEC);
  assert.equal(host.teleports.length, 3, 'snapback hands the ground back in one jump');
  const [sx] = host.teleports[2];
  assert.ok(sx > xWhileStretched, 'snapback lands ahead of the stretched position');
  assert.ok(host.says.length >= 1, 'the collapse announces itself quietly');
  sys.dispose();
});

test('corridor stretch obeys its session cap across separate episodes', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = makeSystem(host, bus);
  openWindow(bus);
  host.edgeFn = () => EdgeCode.OPEN;
  host.yaw = -Math.PI / 2;
  let activations = 0;
  for (let base = 100; base < 140; base++) {
    host.t += 200; // age past any cooldown between candidate hallways
    const before = sys.usage()['corridor-stretch'];
    sys.noteCellCrossing(base, 7, base + 1, 7);
    sys.noteCellCrossing(base + 1, 7, base + 2, 7);
    if (sys.usage()['corridor-stretch'] > before) activations++;
    // end every episode by looking away so the next hallway can arm fresh
    host.yaw = 0;
    host.t += LOOK_AWAY_SNAP_SEC + 1; sys.update(LOOK_AWAY_SNAP_SEC + 1);
    host.yaw = -Math.PI / 2;
  }
  assert.equal(activations, CAPS['corridor-stretch']);
  sys.dispose();
});

// ---- mirror steps ----

test('mirror steps duplicate footsteps 400 ms behind during a burst', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = makeSystem(host, bus);
  openWindow(bus);
  sys.noteFootstep(false); // opens the burst and duplicates this step
  assert.equal(sys.usage()['mirror-steps'], 1);
  sys.update(0.1); // too early: nothing due
  host.t += MIRROR_ECHO_DELAY_SEC - 0.05;
  sys.update(0.2);
  assert.equal(host.echoes.length, 0, 'echo is not early');
  host.t += 0.1; // now past the delay
  sys.update(0.2);
  assert.equal(host.echoes.length, 1, 'one duplicated step');
  assert.ok(Math.abs(Math.abs(host.echoes[0].pan) - 0.3) < 1e-9, 'panned just off centre');
  // a second step inside the burst window is also duplicated
  host.t += 1;
  sys.noteFootstep(true);
  host.t += MIRROR_ECHO_DELAY_SEC + 0.01;
  sys.update(0.5);
  assert.equal(host.echoes.length, 2);
  assert.notEqual(host.echoes[0].pan, host.echoes[1].pan, 'alternating feet');
  assert.ok(host.echoes[1].vol > host.echoes[0].vol, 'running steps echo louder');
  sys.dispose();
});

test('mirror-step bursts are blocked by blackout and cooldown', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = makeSystem(host, bus);
  openWindow(bus);
  sys.noteFootstep(false);
  assert.equal(sys.usage()['mirror-steps'], 1);
  // burst ends; blackout suppresses the next burst entirely
  host.t += 10;
  host.blackout = true;
  sys.noteFootstep(false);
  assert.equal(sys.usage()['mirror-steps'], 1, 'no burst during blackout');
  host.blackout = false;
  // still inside the mirror-steps cooldown since the first burst
  sys.noteFootstep(false);
  assert.equal(sys.usage()['mirror-steps'], 1, 'no burst inside cooldown');
  host.t += COOLDOWNS['mirror-steps'] + 1;
  sys.noteFootstep(false);
  assert.equal(sys.usage()['mirror-steps'], 2, 'burst re-arms after cooldown');
  sys.dispose();
});

test('anomalies never fire with the director window closed', () => {
  const host = makeHost();
  const bus = new Emitter();
  const sys = makeSystem(host, bus);
  openWindow(bus);
  closeWindow(bus);
  sys.noteFootstep(false);
  host.t += 1000;
  sys.noteFootstep(false);
  assert.equal(sys.usage()['mirror-steps'], 0);
  const doors = findHauntedDoors(1);
  host.edgeFn = () => EdgeCode.DOORWAY;
  sys.noteCellCrossing(doors[0][0], doors[0][1], doors[0][2], doors[0][3]);
  assert.equal(host.teleports.length, 0, 'no deja-vu outside a window');
  sys.dispose();
});

// ---- director bus wiring ----

test('HorrorDirector publishes anomaly windows on phase transitions', () => {
  const events = [];
  const stubHost = {
    lightingStress() {}, killNearbyLight: () => false, blackoutPulse() {}, whisperSurge() {},
    distantThreat() {}, nonEuclideanNudge() {}, armDoorwayLoop() {}, requestEntitySpawn() {},
    playerPosition: () => ({ x: 0, z: 0 }), elapsed: () => 42,
  };
  const director = new HorrorDirector(stubHost, SEED);
  const off = director.events.on('directorEvent', (e) => events.push(e));
  for (let i = 0; i < 400 && !events.some((e) => e.kind === 'window-open'); i++) {
    director.update(5); // long enough that some phase must eventually turn over
  }
  off();
  const open = events.find((e) => e.kind === 'window-open');
  assert.ok(open, 'a window opened');
  assert.ok(open.phase === 'build' || open.phase === 'peak');
});

// ---- ChunkDeltas reversibility ----

function prop(kind, x, z, rot, variant) { return { kind, x, z, rot, variant }; }
function layoutProps() {
  return [
    prop('desk', 1.2, 3.4, 0, 1),
    prop('chair', 2.2, 3.1, 2, 0),
    prop('crate', -4.0, 8.8, 1, 3),
    prop('battery', 5.5, -1.2, 0, 2), // pickups are never drifted
  ];
}
const clone = (props) => props.map((p) => ({ ...p }));

test('applyDecorDrift is a deterministic pure function of (props, cx, cz, seed, step)', () => {
  const a = layoutProps();
  const b = layoutProps();
  applyDecorDrift(a, 3, -7, SEED, 2);
  applyDecorDrift(b, 3, -7, SEED, 2);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  // the same chunk at a different drift step looks different
  const c = layoutProps();
  applyDecorDrift(c, 3, -7, SEED, 3);
  assert.notDeepStrictEqual(a, c);
  // a different chunk drifts differently under the same step
  const d = layoutProps();
  applyDecorDrift(d, 4, -7, SEED, 2);
  assert.notDeepStrictEqual(a, d);
  // batteries stay put (consumable keys are coordinate-stable)
  assert.equal(a[3].x, 5.5);
  assert.equal(a[3].variant, 2);
});

test('drift step zero is a no-op and revertAll restores the canonical world', () => {
  const original = layoutProps();
  const untouched = layoutProps();
  assert.equal(applyDecorDrift(untouched, 1, 1, SEED, 0), 0);
  assert.deepStrictEqual(untouched, original);

  const deltas = new ChunkDeltas();
  const manager = {
    builds: [],
    rebuild(cx, cz) {
      const props = layoutProps();
      applyDecorDrift(props, cx, cz, SEED, deltas.step(cx, cz));
      this.builds.push({ cx, cz, props });
    },
  };
  manager.rebuild(9, 9);
  const canonical = manager.builds[0].props;
  assert.deepStrictEqual(canonical, original, 'undrifted rebuild is canonical');

  deltas.bump(9, 9);
  deltas.bump(9, 9);
  manager.rebuild(9, 9);
  const drifted = manager.builds[1].props;
  assert.notDeepStrictEqual(drifted, canonical, 'drifted rebuild differs');
  manager.rebuild(9, 9);
  assert.deepStrictEqual(manager.builds[2].props, drifted, 'rebuilds agree with each other');

  assert.equal(deltas.revertAll(), 1);
  manager.rebuild(9, 9);
  assert.deepStrictEqual(manager.builds[3].props, canonical, 'reverted world regenerates canonically');
});
