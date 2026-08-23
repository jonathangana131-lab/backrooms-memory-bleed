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



  // ===== 2. wanderer curiosity =============================================
  {
    // Fresh wanderer (earlier sims let any starter wanderer drift off-map).
    // Starts at (0,0) facing +z with a battery/sign at (0,4):
    // it should stop inside the 2.6m curiosity radius and hold still >= 2s.
    const w = mgr.spawn('wanderer', 0, 0, 777);
    const poi = mgr.interestPoints[0];
    let stoppedFrames = 0;
    let lastZ = figs.wanderer.body.z;
    let facedOk = false;
    for (let i = 0; i < Math.round(30 / DT); i++) {
      mgr.update(DT, P.x, P.z, 0, [], { on: false });
      const f = w;
      const dz = Math.abs(f.body.z - lastZ);
      lastZ = f.body.z;
      const dToPoi = Math.hypot(f.body.x - poi.x, f.body.z - poi.z);
      if (dToPoi < 2.7 && dz < 1e-7) {
        stoppedFrames++;
        let dyaw = Math.atan2(poi.x - f.body.x, poi.z - f.body.z) - f.root.rotation.y;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        if (Math.abs(dyaw) < 0.25) facedOk = true;
      }
    }
    check('wanderer: stops near the interesting prop', stoppedFrames * DT >= 2, 'held still ' + (stoppedFrames * DT).toFixed(2) + 's near prop');
    check('wanderer: faces the prop while curious', facedOk);
  }

  // ===== 3. believer work animation ========================================
  {
    let minY = Infinity;
    let dips = 0;
    let inDip = false;
    for (let i = 0; i < Math.round(32 / DT); i++) {
      mgr.update(DT, P.x, P.z, 0, [], { on: false });
      const y = figs.believer.root.position.y;
      minY = Math.min(minY, y);
      if (y < -0.05 && !inDip) { dips++; inDip = true; }
      if (y > -0.02) inDip = false;
    }
    check('believer: crouches (y dips toward -0.1)', minY <= -0.08, 'min y ' + minY.toFixed(3));
    check('believer: work dip recurs within 32s', dips >= 1, dips + ' dip(s)');
  }

  // ===== 4. double mirroring ==============================================
  {
    // Fresh double: starters close in during earlier sims and self-despawn
    // under the d<5 vanishing rule, so mirror tests need a new one behind you.
    const dbl = mgr.spawn('double', 0, -7, 888);
    // Phase A: player walks forward (+z) at 1.5 m/s for 2s -> double walks forward too
    const zA0 = dbl.body.z;
    for (let i = 0; i < Math.round(2 / DT); i++) {
      P.z += 1.5 * DT;
      mgr.update(DT, P.x, P.z, 0, [], { on: false });
    }
    const dzA = dbl.body.z - zA0;
    check('double: mirrors forward walking (moves same world direction)', dzA < -1, 'dz=' + dzA.toFixed(2));

    // Phase B: player strafes left-ish along +x at 1.2 m/s for 2s -> lateral mirrors across
    // the player/double axis (pure tangential motion passes straight through, like a mirror)
    const xB0 = dbl.body.x;
    const zB0 = dbl.body.z;
    for (let i = 0; i < Math.round(2 / DT); i++) {
      P.x += 1.2 * DT;
      mgr.update(DT, P.x, P.z, 0, [], { on: false });
    }
    const dxB = dbl.body.x - xB0;
    const dzB = dbl.body.z - zB0;
    check('double: mirrors strafing (tangential motion copied)', dxB > 1, 'dx=' + dxB.toFixed(2));
    check('double: strafe adds no spurious forward drift', Math.abs(dzB) < 0.15, 'dz=' + dzB.toFixed(2));

    // Phase C: torch stops it (existing behavior preserved). Driven directly
    // so the unlit manager path can't mirror the player underneath us.
    const zC0 = dbl.body.z;
    for (let i = 0; i < Math.round(1 / DT); i++) {
      P.z += 1.5 * DT;
      dbl.update(DT, P.x, P.z, [], Math.atan2(P.x - dbl.body.x, P.z - dbl.body.z), true);
    }
    check('double: beam still freezes it mid-stride', Math.abs(dbl.body.z - zC0) < 1e-9);
  }

  // ===== 5. incomplete twitch =============================================
  {
    let maxHeadY = 0;
    let spikes = 0;
    let inSpike = false;
    for (let i = 0; i < Math.round(30 / DT); i++) {
      mgr.update(DT, P.x, P.z, 0, [], { on: false });
      const hy = figs.incomplete.head.rotation.y;
      maxHeadY = Math.max(maxHeadY, Math.abs(hy));
      if (Math.abs(hy) > 0.2 && !inSpike) { spikes++; inSpike = true; }
      if (Math.abs(hy) < 0.05) inSpike = false;
    }
    check('incomplete: head jerks sharply', maxHeadY > 0.3, 'max |head.y| ' + maxHeadY.toFixed(2));
    check('incomplete: twitch occurs within 30s and decays between spikes', spikes >= 1, spikes + ' spike(s)');
  }

  // ===== 6. proximity audio hooks =========================================
  {
    check('proximity: callback fired every update', proxCallbackCount > 100, proxCallbackCount + ' calls');
    const expected = mgr.figures.length;
    check('proximity: one entry per live figure', proxLastLen === expected, proxLastLen + ' vs ' + expected);
    check('proximity: entries carry finite distances',
      mgr.proximities.every((e) => Number.isFinite(e.dist) && e.dist >= 0 && !!e.figure && typeof e.type === 'string'));

    const nearest = mgr.nearestDist(P.x, P.z);
    const minEntry = Math.min(...mgr.proximities.map((e) => e.dist));
    check('proximity: consistent with legacy nearestDist()', Math.abs(nearest - minEntry) < 1e-9);

    // despawn safety: vanished figures never linger in the published list
    mgr.update(DT, P.x, P.z, 0, [], { on: false });
    check('proximity: list matches live figure count after updates', mgr.proximities.length === mgr.count);
  }

  // ===== backward-compatible API surface ==================================
  {
    check('legacy: reset() clears figures', (mgr.reset(), mgr.count === 0));
    check('legacy: nearestDist() on empty manager is Infinity', mgr.nearestDist(P.x, P.z) === Infinity);
    const again = mgr.spawn('helper', 1, 1, 99);
    check('legacy: respawn after reset works', mgr.count === 1 && !!again);
  }

  scene.dispose();
  engine.dispose();
}

main()
  .catch((err) => { failures.push('crash: ' + (err && err.stack || err)); })
  .finally(() => {
    rmSync(BUILD, { recursive: true, force: true });
    console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
    if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
    process.exit(0);
  });


