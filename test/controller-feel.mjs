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
  throw new Error('unexpected import: ' + spec + ' from ' + fromFile);
}

const { PlayerController } = loadModule('controller', 'src/player/controller.ts');

// ---- test scaffolding ----
function makeRig(keys = new Set()) {
  const camera = { fov: 1.25 };
  camera.position = { set(x, y, z) { camera.px = x; camera.py = y; camera.pz = z; } };
  camera.rotation = { set(x, y, z) { camera.rx = x; camera.ry = y; camera.rz = z; } };
  const input = { consumeMouse: () => ({ dx: 0, dy: 0 }), down: (c) => keys.has(c) };
  const player = new PlayerController(camera, input, {});
  player.enabled = true;
  player.teleport(0, 6, Math.PI);
  return { player, camera, keys };

(Showing lines 1-60 of 219. Use offset=61 to continue.)

