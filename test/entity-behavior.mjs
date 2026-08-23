/**
 * Entity behavior tests for BACKROOMS: MEMORY BLEED.
 *
 * Spawns one of every reconstructed-human type against a Babylon NullEngine
 * scene, steps HumanManager.update() through simulated frames, and verifies:
 *   1. watchers idle-scan their heads (±30°) instead of standing rigid
 *   2. wanderers stop near interesting props (batteries/signs) and face them
 *   3. believers crouch periodically (-0.1 y dip over 0.5s down, 0.5s up)
 *   4. doubles mirror the player's CURRENT movement direction
 *   5. incompletes twitch (head jerk decaying over ~200ms) every 5-12s
 *   6. manager.update exposes per-figure proximity entries for audio layers
 *
 * The TypeScript sources are transpiled on the fly with the project's own
 * typescript install into a throwaway ESM build dir (removed on exit).
 * src/world/constants.ts uses cross-file const enums that per-file
 * transpilation cannot inline, so a tiny JS shim stands in for it here.
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.behavior-build');
const DT = 0.05;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

function transpile(relSrc, outRel) {
  const src = readFileSync(join(ROOT, relSrc), 'utf8');
  let out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
    },
    isolatedModules: true,
  }).outputText;
  // Node ESM needs explicit extensions on relative and @babylonjs subpath imports
  // (@babylonjs/core ships no exports map, so specifiers must resolve as real files).
  out = out.replace(/(from\s+')([^']+)(')/g, (_m, a, spec, b) => {
    const needsExt = (spec.startsWith('.') || spec.startsWith('@babylonjs/')) && !spec.endsWith('.js');
    return a + spec + (needsExt ? '.js' : '') + b;
  });
  const outPath = join(BUILD, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
}

/** JS stand-in for src/world/constants.ts (its const enums don't survive isolated transpile). */
function writeConstantsShim() {
  const js = `
export const CELL = 2.5;
export const CHUNK_CELLS = 12;
export const CHUNK_SIZE = CELL * CHUNK_CELLS;
export const WALL_H = 3.05;
export const WALL_T = 0.16;
export const EdgeCode = Object.freeze({ OPEN: 0, SOLID: 1, DOORWAY: 2 });
export const District = Object.freeze({ MAZE: 0, OPEN_OFFICE: 1, HONEYCOMB: 2, CORRIDOR_GRID: 3, STORAGE: 4 });
export const DISTRICT_NAMES = ['MAZE', 'OPEN_OFFICE', 'HONEYCOMB', 'CORRIDOR_GRID', 'STORAGE'];
export const SALTS = Object.freeze({ district: 0x11, density: 0x22, edgeH: 0x33, edgeV: 0x44, door: 0x55, pillar: 0x66, light: 0x77, blackout: 0x88, prop: 0x99, flicker: 0xaa, room: 0xbb });
export function worldToCell(w) { return Math.floor(w / CELL); }
export function cellToWorld(c) { return (c + 0.5) * CELL; }
export function worldToChunk(w) { return Math.floor(w / CHUNK_SIZE); }
`;
  const p = join(BUILD, 'src/world/constants.js');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, js);
}

async function main() {
  rmSync(BUILD, { recursive: true, force: true });
  transpile('src/core/rng.ts', 'src/core/rng.js');
  transpile('src/world/collision.ts', 'src/world/collision.js');
  transpile('src/entities/humans.ts', 'src/entities/humans.js');
  transpile('src/entities/manager.ts', 'src/entities/manager.js');
  writeConstantsShim();

  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
  const { Scene } = await import('@babylonjs/core/scene.js');
  const { HumanManager } = await import(pathToFileURL(join(BUILD, 'src/entities/manager.js')).href);

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const mgr = new HumanManager(scene);

  // Wanderers stop near these; manager must hand them to spawned figures.
  mgr.interestPoints = [{ x: 0, z: 4 }];

  // Spawn one of every type, well clear of the player so nothing despawns.
  const types = ['watcher', 'wanderer', 'helper', 'incomplete', 'believer', 'double'];
  const spots = {
    watcher: [8, 0],
    wanderer: [0, 0],
    helper: [-8, -8],
    incomplete: [10, 3],
    believer: [-9, 6],
    double: [0, -7],
  };
  const figs = {};
  for (const t of types) figs[t] = mgr.spawn(t, spots[t][0], spots[t][1], 1234 + t.length * 7919);
  check('spawn: all six types spawn', types.every((t) => figs[t] instanceof Object));
  check('interest points plumbed to figures', figs.wanderer.pointsOfInterest === mgr.interestPoints);

  // Player state driven across the sim.
  const P = { x: 0, z: 0 };

  // ---- shared sim loop ----------------------------------------------------
  let proxCallbackCount = 0;
  let proxLastLen = -1;
  mgr.onProximity = (entries) => {
    proxCallbackCount++;
    proxLastLen = entries.length;
  };

  // ===== 1. watcher idle scanning ==========================================
  {
    let maxDev = 0;
    for (let i = 0; i < Math.round(20 / DT); i++) {
      mgr.update(DT, P.x, P.z, 0, [], { on: false });
      const f = figs.watcher;
      const trackingTarget = Math.atan2(P.x - f.body.x, P.z - f.body.z) + Math.PI;
      let dev = f.head.rotation.y - trackingTarget;
      while (dev > Math.PI) dev -= Math.PI * 2;
      while (dev < -Math.PI) dev += Math.PI * 2;
      maxDev = Math.max(maxDev, Math.abs(dev));
    }
    check('watcher: head sweeps well past the tracking pose (idle scan)', maxDev > 0.3, 'max deviation ' + maxDev.toFixed(3) + ' rad');
    check('watcher: did not vanish mid-test', mgr.figures.includes(figs.watcher));

    // beam freeze still works (backward-compat path)
    let froze = false;
    mgr.onBeamFreeze = () => { froze = true; };
    figs.watcher.beamFreezeUntil = 0;
    mgr.update(DT, P.x, P.z, 0, [], { on: false });
    // force-lit update via direct call (manager gating needs exact angle)
    figs.watcher.update(DT, P.x, P.z, [], Math.atan2(P.x - figs.watcher.body.x, P.z - figs.watcher.body.z), true);
    check('watcher: beam freeze callback still fires', froze || figs.watcher.isBeamFrozen());
  }



