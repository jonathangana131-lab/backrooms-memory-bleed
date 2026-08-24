/**
 * Unit test for the Exit that isn't (src/story/exitvoid.ts, F50).
 * Standalone (no browser): transpiles the module (+ deps) into a temp dir
 * and drives the pure gate/descriptor model.
 *
 * Acceptance:
 *   1. probability calibration — across 100k simulated door events
 *      (one per EXITVOID_CHECK_INTERVAL_SEC slot) the measured spawn rate
 *      converts to ≈0.125 spawns/hour (= 12.5%/h) within ±20%; derived
 *      E[spawns] over exactly 28800 s of exploration ≈ 1
 *   2. never twice in one session — after the first manifest, further
 *      events never fire again (latch), for any timeline length/seed
 *   3. determinism per seed — identical event timelines replay identically;
 *      manifest slots vary across seeds (seeded placement)
 *   4. epilogue descriptor validity — every cell white-flagged, exits empty,
 *      exitless true, leaveMode 'wake-to-title'; deterministic per seed,
 *      distinct rooms across seeds
 *   5. entry via injected teleport hook fires exactly once at room center;
 *      leaving is wake-to-title only (documented constant)
 *
 * Run: node test/exitvoid-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-exitvoid-'));
fs.mkdirSync(path.join(tmp, 'story'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/story/exitvoid.ts', 'story/exitvoid.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'story', 'exitvoid.mjs')).href);
const {
  ExitVoidTracker,
  exitVoidGateRoll,
  buildEpilogueRoom,
  enterEpilogue,
  EXITVOID_CHECK_INTERVAL_SEC,
  EXITVOID_EXPECTED_INTERVAL_SEC,
  EXITVOID_PER_CHECK_P,
  WAKE_EXIT,
} = mod;

// ---- 1. probability calibration -------------------------------------------------
(() => {
  check('derived p = interval / 28800 (E[spawns]=1 per 8h)',
    Math.abs(EXITVOID_PER_CHECK_P - EXITVOID_CHECK_INTERVAL_SEC / 28800) < 1e-15 &&
      Math.abs(EXITVOID_PER_CHECK_P - 1 / 480) < 1e-12,
    'p=' + EXITVOID_PER_CHECK_P);
  check('expected spawns over one 8h session ≈ 1',
    Math.abs((28800 / EXITVOID_CHECK_INTERVAL_SEC) * EXITVOID_PER_CHECK_P - 1) < 1e-9);

  // AC flow: 100k simulated door events, each an independent gate
  // opportunity (fresh gate state per event — measures the gate's
  // probability density, before any single session's once-only latch).
  const EVENTS = 100_000;
  let spawns = 0;
  for (let e = 0; e < EVENTS; e++) {
    const tr = new ExitVoidTracker((e * 2654435761) >>> 0);
    if (tr.onDoorCandidate(e * EXITVOID_CHECK_INTERVAL_SEC)) spawns++;
  }
  const hours = (EVENTS * EXITVOID_CHECK_INTERVAL_SEC) / 3600;
  const perHour = spawns / hours;
  // AC: ≈12.5/h ⇒ here expressed as fraction-of-an-exit-per-hour 0.125 ±20%.
  check('measured spawn rate ≈ 0.125/h (12.5% per hour) ±20%',
    Math.abs(perHour - 0.125) <= 0.125 * 0.2,
    `spawns=${spawns} hours=${hours.toFixed(1)} rate=${perHour.toFixed(4)}/h`);
  const expectedSpawns = hours / 8;
  check('aggregate count matches analytic expectation ±20%',
    Math.abs(spawns - expectedSpawns) <= expectedSpawns * 0.2,
    `spawns=${spawns} expected=${expectedSpawns.toFixed(1)}`);

  // Session-truncation invariant: a full latched 8h session manifests with
  // P ≈ 1-(1-p)^480 ≈ 63%, and never more than once — the "≤1 expected"
  // bound is a ceiling, not a promise of exactly one.
  const SESSIONS = 4000;
  let manifested = 0;
  for (let s = 0; s < SESSIONS; s++) {
    const tr = new ExitVoidTracker(s * 40503 + 11);
    for (let slot = 0; slot < 480; slot++) {
      if (tr.onDoorCandidate(slot * EXITVOID_CHECK_INTERVAL_SEC)) break;
    }
    if (tr.spawned) manifested++;
  }
  const p8h = manifested / SESSIONS;
  check('latched 8h session manifest prob ≈ 1-(1-1/480)^480 ≈ 0.632, capped at one',
    Math.abs(p8h - (1 - Math.pow(1 - EXITVOID_PER_CHECK_P, 480))) < 0.04 && p8h <= 1,
    'p8h=' + p8h.toFixed(3));
})();

// ---- 2. never twice in one session ----------------------------------------------
(() => {
  let violations = 0;
  let latchedSeeds = 0;
  for (let seed = 0; seed < 200; seed++) {
    const tr = new ExitVoidTracker(seed * 40503 + 7);
    let sawSpawn = false;
    for (let e = 0; e < 3000; e++) {
      if (tr.onDoorCandidate(e * 37)) {
        if (sawSpawn) violations++;
        sawSpawn = true;
      }
    }
    if (tr.spawned && sawSpawn && tr.spawnedAtSec >= 0) latchedSeeds++;
    if (sawSpawn !== tr.spawned) violations++;
    // Even hammering past the manifest slot cannot refire.
    if (tr.spawned) {
      for (let e2 = 0; e2 < 500; e2++) {
        if (tr.onDoorCandidate(tr.spawnedAtSec + 1 + e2 * EXITVOID_CHECK_INTERVAL_SEC)) violations++;
      }
    }
  }
  check('no seed ever manifests the exit twice', violations === 0, 'violations=' + violations);
  check('latched sessions report spawned=true + stamp', latchedSeeds > 0,
    'latched=' + latchedSeeds);

  // Same-slot door events collapse to one roll (time-based expectation).
  const tr = new ExitVoidTracker(42);
  const firstSlotFires = [
    tr.onDoorCandidate(0), tr.onDoorCandidate(10), tr.onDoorCandidate(59.9),
  ].filter(Boolean).length;
  check('multiple door events in one interval slot roll once',
    firstSlotFires <= 1);
})();

// ---- 3. determinism per seed ------------------------------------------------------
(() => {
  function manifestSlot(seed) {
    const tr = new ExitVoidTracker(seed);
    for (let e = 0; e < 5000; e++) {
      if (tr.onDoorCandidate(e * EXITVOID_CHECK_INTERVAL_SEC)) return e;
    }
    return -1;
  }
  let replayOk = true;
  let distinctSlots = new Set();
  for (let s = 0; s < 30; s++) {
    const seed = s * 2246822519;
    if (manifestSlot(seed) !== manifestSlot(seed)) replayOk = false;
    distinctSlots.add(manifestSlot(seed));
  }
  check('identical seed ⇒ identical manifest slot', replayOk);
  check('manifest placement varies across seeds', distinctSlots.size > 1,
    'distinct=' + distinctSlots.size);

  // Pure roll agrees with the tracker's decision at every slot boundary.
  let pureAgrees = true;
  const tr = new ExitVoidTracker(777);
  let trackerMatchesPure = true;
  for (let slot = 0; slot < 2000; slot++) {
    const wasSpawned = tr.spawned;
    const fired = tr.onDoorCandidate(slot * EXITVOID_CHECK_INTERVAL_SEC);
    if (fired !== (exitVoidGateRoll(777, slot) && !wasSpawned)) trackerMatchesPure = false;
    // Same-slot repeats are no-ops, matching the pure roll exactly once.
    if (tr.onDoorCandidate(slot * EXITVOID_CHECK_INTERVAL_SEC + 1)) trackerMatchesPure = false;
  }
  check("tracker decisions match pure seeded rolls", trackerMatchesPure);
})();

// ---- 4. epilogue descriptor validity -----------------------------------------------
(() => {
  const r = 3;
  const room = buildEpilogueRoom(0xfeed);
  check('grid covers (2r+1)^2 cells', room.cells.length === (2 * r + 1) ** 2,
    'len=' + room.cells.length);
  check('every cell white-flagged', room.cells.every((c) => c.whiteFlagged === true));
  check('exits empty + exitless true', Array.isArray(room.exits) &&
    room.exits.length === 0 && room.exitless === true);
  check("leaveMode is wake-to-title", room.leaveMode === WAKE_EXIT &&
    WAKE_EXIT === 'wake-to-title');
  check('descriptor kind tagged', room.kind === 'exit-void');
  check('descriptor frozen (mount cannot mutate the void)',
    Object.isFrozen(room));

  const again = buildEpilogueRoom(0xfeed);
  check('same seed ⇒ deep-equal room', JSON.stringify(room) === JSON.stringify(again));
  const other = buildEpilogueRoom(0xfeed + 1);
  check('different seed ⇒ different arrival point',
    other.centerWorld.x !== room.centerWorld.x || other.centerWorld.z !== room.centerWorld.z);
  const tiny = buildEpilogueRoom(5, 1);
  check('radius parameter respected (min 1)', tiny.cells.length === 9);
})();

// ---- 5. teleport entry + wake-only exit ---------------------------------------------
(() => {
  const room = buildEpilogueRoom(991);
  let calls = [];
  enterEpilogue(room, (x, z) => calls.push([x, z]));
  check('teleport hook fired exactly once at room center',
    calls.length === 1 && calls[0][0] === room.centerWorld.x && calls[0][1] === room.centerWorld.z);
  check('wake-to-title is the sole leave mode (documented constant)',
    room.leaveMode === 'wake-to-title' && room.exits.length === 0 && room.exitless);
})();

console.log(failures === 0 ? 'EXITVOID_PASS' : `EXITVOID_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
