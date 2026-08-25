/**
 * Controller feel tests: head bob, landing impact, crouch smoothing,
 * sprint FOV ease, footstep hooks.
 *
 * Runs with plain node (node test/controller-feel.mjs): TypeScript sources
 * are transpiled in-memory with the repo's own typescript dep and driven
 * through stub input/camera objects - no browser needed.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// ---- tiny CJS-in-memory loader for the controller and its deps ----
const registry = new Map(); // specifier -> exports

function loadModule(specifier, filePath) {
  if (registry.has(specifier)) return registry.get(specifier);
  const cjs = ts.transpileModule(SRC(filePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  registry.set(specifier, module.exports);
  const requireShim = (spec) => resolveDep(spec, filePath);
  new Function('require', 'module', 'exports', cjs)(requireShim, module, module.exports);
  return module.exports;
}

const STUBS = new Map([
  ['@babylonjs/core/Maths/math.vector', { Vector3: class Vector3 {} }],
  ['../core/input', { Input: class Input {} }],
  ['../world/collision', {
    // pass-through collision: body just moves as requested
    moveCircle: (body, dx, dz) => { body.x += dx; body.z += dz; },
  }],
  ['../world/architect', {}],
]);

function resolveDep(spec, fromFile) {
  if (STUBS.has(spec)) return STUBS.get(spec);
  if (spec === '../core/events') return loadModule('events', 'src/core/events.ts');
  // stamina.ts is a pure state machine with no imports; load the real module
  // so the controller runs against the actual F9 drain/regen surface.
  if (spec === './stamina') return loadModule('stamina', 'src/player/stamina.ts');
  // leanpeek.ts is likewise a pure state machine; load the real module.
  if (spec === './leanpeek') return loadModule('leanpeek', 'src/player/leanpeek.ts');
  throw new Error('unexpected import: ' + spec + ' from ' + fromFile);
}

const { PlayerController } = loadModule('controller', 'src/player/controller.ts');
const { EYE_STAND, EYE_CROUCH } = registry.get('controller');

// ---- test scaffolding ----
function makeRig(keys = new Set()) {
  const camera = { fov: 1.25 };
  camera.position = { set(x, y, z) { camera.px = x; camera.py = y; camera.pz = z; } };
  camera.rotation = { set(x, y, z) { camera.rx = x; camera.ry = y; camera.rz = z; } };
  // padLook: gamepad-mount merge surface (zero here = keyboard-only rig)
  const input = { consumeMouse: () => ({ dx: 0, dy: 0 }), down: (c) => keys.has(c), padLook: { x: 0, y: 0 } };
  const player = new PlayerController(camera, input, {});
  player.enabled = true;
  player.teleport(0, 6, Math.PI);
  return { player, camera, keys };
}

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const DT = 1 / 60;
function run(rig, seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) rig.player.update(DT, []);
}

// ---- 1: head bob ---------------------------------------------------------------
{
  const rig = makeRig(new Set(['KeyW']));
  const ys = [];
  for (let i = 0; i < 180; i++) {
    rig.player.update(DT, []);
    ys.push(rig.camera.py);
  }
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  check('walking bobs the camera around eye height', lo < EYE_STAND && hi > EYE_STAND,
    'lo=' + lo.toFixed(4) + ' hi=' + hi.toFixed(4));
  check('bob amplitude stays subtle (< 3 cm)', hi - lo > 0 && hi - lo < 0.03,
    String(hi - lo));
  check('bob carries the body forward', rig.camera.pz !== 6, String(rig.camera.pz));
}

// ---- 2: footstep hooks -----------------------------------------------------------
{
  const rig = makeRig(new Set(['KeyW']));
  let steps = 0;
  let lastRunning = null;
  rig.player.onFootstep = (running) => { steps++; lastRunning = running; };
  run(rig, 3);
  check('footsteps fire at bob peaks while walking', steps >= 5 && steps <= 12,
    String(steps));
  check('walking strides are not sprint-flagged', lastRunning === false,
    String(lastRunning));
}
{
  const rig = makeRig();
  let steps = 0;
  rig.player.onFootstep = () => steps++;
  run(rig, 2);
  check('standing still is silent', steps === 0, String(steps));
}
{
  const rig = makeRig(new Set(['KeyW', 'ShiftLeft']));
  let sawRunning = false;
  rig.player.onFootstep = (running) => { if (running) sawRunning = true; };
  run(rig, 2);
  check('sprint strides flag running', sawRunning);
}

// ---- 3: landing impact ------------------------------------------------------------
{
  // A ground clamp every frame is NOT a fall: no dip while idling.
  const idle = makeRig();
  let idleMin = Infinity;
  for (let i = 0; i < 120; i++) {
    idle.player.update(DT, []);
    idleMin = Math.min(idleMin, idle.camera.py);
  }
  check('ground clamp alone never triggers the dip', idleMin >= EYE_STAND - 0.005,
    String(idleMin));

  const rig = makeRig();
  rig.player.body.y = 3; // drop from three metres
  let minY = Infinity;
  for (let i = 0; i < 90; i++) {
    rig.player.update(DT, []);
    minY = Math.min(minY, rig.camera.py);
  }
  check('hard landing dips the camera a full LAND_DIP_DEPTH',
    Math.abs(minY - (EYE_STAND - 0.05)) < 0.005, String(minY));
  check('camera recovers to eye height after the dip',
    Math.abs(rig.camera.py - EYE_STAND) < 1e-6, String(rig.camera.py));
}

// ---- 4: crouch smoothing -----------------------------------------------------------
{
  const rig = makeRig(new Set(['KeyC']));
  run(rig, 1);
  check('crouch settles at EYE_CROUCH after the lerp',
    Math.abs(rig.camera.py - EYE_CROUCH) < 0.005, String(rig.camera.py));
  check('crouching flag is set', rig.player.crouching === true);
  rig.keys.delete('KeyC');
  run(rig, 0.5);
  check('standing back up restores EYE_STAND',
    Math.abs(rig.camera.py - EYE_STAND) < 0.005, String(rig.camera.py));
}

// ---- 5: sprint FOV ease --------------------------------------------------------------
{
  const rig = makeRig(new Set(['KeyW', 'ShiftLeft']));
  run(rig, 1);
  check('sprint eases the FOV wider than stock',
    rig.camera.fov > 1.29 && rig.camera.fov < 1.31, String(rig.camera.fov));
  rig.keys.delete('ShiftLeft');
  rig.keys.delete('KeyW');
  run(rig, 0.5);
  // Since F9 the FOV carries an exertion pulse (FOV_PULSE_MAX * fovPulseAmp *
  // sin(pulsePhase)) that keeps oscillating while drained stamina regenerates,
  // so stock FOV is reached only after recovery, not within the 0.22 s kick ease.
  check('FOV kick eases out once sprinting ends', rig.camera.fov < 1.26,
    String(rig.camera.fov));
  run(rig, 3); // STAMINA_REGEN_RATE refills a 1 s sprint drain (~0.11) in ~1.5 s
  check('FOV settles at stock once stamina fully recovers',
    Math.abs(rig.camera.fov - 1.25) < 0.001, String(rig.camera.fov));
}
{
  const rig = makeRig(new Set(['ShiftLeft']));
  run(rig, 1);
  check('shift without movement leaves the FOV stock',
    rig.camera.fov === 1.25, String(rig.camera.fov));
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
