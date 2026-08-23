/**
 * Ambient fauna tests for BACKROOMS: MEMORY BLEED.
 *
 * Builds FaunaManager + Roach/DustDevil/Moth against a Babylon NullEngine
 * scene and verifies:
 *   1. chunk build spawns 2-4 roaches at floor level (y = 0.02)
 *   2. the global fauna budget (MAX_ACTIVE = 12) is never exceeded
 *   3. roaches scurry (move without the beam) and FREEZE under the torch beam
 *   4. roaches despawn beyond 25 m
 *   5. dust devils: ~5% of corridor chunks, never non-corridor chunks,
 *      lifetime ~20 s with grow-in/collapse scaling
 *   6. moths orbit their fixture on sin paths and leave when the light dies
 *   7. skitter audio fires only while a roach is actually running nearby,
 *      is very quiet, panned within [-1, 1], and silenced under the beam
 *
 * TypeScript sources are transpiled on the fly (same approach as
 * entity-behavior.mjs; src/world/constants.ts gets a JS shim because its
 * const enums don't survive isolated transpilation).
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.fauna-build');
const DT = 0.05;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

function transpile(relSrc, outRel) {
  const srcTxt = readFileSync(join(ROOT, relSrc), 'utf8');
  let out = ts.transpileModule(srcTxt, {
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
  transpile('src/entities/fauna.ts', 'src/entities/fauna.js');
  writeConstantsShim();

  const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
  const { Scene } = await import('@babylonjs/core/scene.js');
  const faunaUrl = pathToFileURL(join(BUILD, 'src/entities/fauna.js')).href;
  const fauna = await import(faunaUrl);
  const { FaunaManager, Roach, DustDevil, Moth, MAX_ACTIVE, ROACH_DESPAWN_DIST, DUST_DEVIL_LIFETIME } = fauna;

  const engine = new NullEngine();
  const scene = new Scene(engine);

  // ---- 1: chunk builds spawn 2-4 floor-hugging roaches ----------------------
  {
    const mgr = new FaunaManager(scene);
    for (let i = 0; i < 8; i++) {
      mgr.reset();
      mgr.onChunkBuilt(i, 0, 9000 + i, { corridor: false, lights: [] });
      check('chunk ' + i + ': spawns 2-4 roaches',
        mgr.roaches.length >= 2 && mgr.roaches.length <= 4, String(mgr.roaches.length));
      check('chunk ' + i + ': every roach hugs the floor at y = 0.02',
        mgr.roaches.every((r) => Math.abs(r.root.position.y - 0.02) < 1e-9));
    }
  }

  // ---- 2: global budget -------------------------------------------------------
  {
    const mgr = new FaunaManager(scene);
    // lots of corridor chunks with busy light banks; caps must hold throughout
    const lights = [];
    for (let i = 0; i < 10; i++) lights.push({ x: i * 3.0, z: 7.0, alive: true });
    let maxSeen = 0;
    for (let cx = 0; cx < 40; cx++) {
      mgr.onChunkBuilt(cx, cx % 3, 424242, { corridor: true, lights });
      maxSeen = Math.max(maxSeen, mgr.count);
    }
    check('fauna budget never exceeds MAX_ACTIVE=' + MAX_ACTIVE, maxSeen <= MAX_ACTIVE,
      'peak ' + maxSeen);
    const c = mgr.census();
    check('census matches the live pools',
      c.roach === mgr.roaches.length && c.devil === mgr.devils.length && c.moth === mgr.moths.length);
  }

  // ---- 3: scurry vs freeze -----------------------------------------------------
  {
    const r = new Roach(scene, 0, 0, 12345);
    let travelled = 0;
    let px = r.x, pz = r.z;
    for (let i = 0; i < Math.round(6 / DT); i++) {
      r.update(DT, [], false);
      travelled += Math.hypot(r.x - px, r.z - pz);
      px = r.x; pz = r.z;
    }
    check('unlit roach actually scurries around', travelled > 0.5, String(travelled.toFixed(2)));

    const bx = r.x, bz = r.z;
    r.update(DT, [], true); // caught in the torch beam
    check('beam light freezes the roach instantly', r.frozen === true);
    let drift = 0;
    for (let i = 0; i < Math.round(2 / DT); i++) {
      r.update(DT, [], true);
      drift += Math.hypot(r.x - bx, r.z - bz);
    }
    check('frozen roach holds perfectly still under the beam', drift === 0, String(drift));
    check('frozen roach reports not-running', r.isRunning() === false);
  }

  // ---- 4: roaches despawn beyond 25 m ------------------------------------------
  {
    const mgr = new FaunaManager(scene);
    mgr.onChunkBuilt(0, 0, 777, { corridor: false, lights: [] });
    check('roaches exist before the walk-away', mgr.roaches.length > 0);
    // step far from the chunk with the beam off; past ROACH_DESPAWN_DIST they vanish
    for (let i = 0; i < Math.round(2 / DT); i++) mgr.update(DT, 60, 60, 0, []);
    check('roaches despawn beyond ' + ROACH_DESPAWN_DIST + ' m', mgr.roaches.length === 0,
      String(mgr.roaches.length));
  }

  // ---- 5: dust devils ------------------------------------------------------------
  {
    // never in non-corridor chunks, whatever the seed
    let leaked = 0, scanned = 0;
    const mgr = new FaunaManager(scene);
    for (let cx = -50; cx < 50; cx++) {
      mgr.reset();
      mgr.onChunkBuilt(cx, 17, 1000 + cx, { corridor: false, lights: [] });
      leaked += mgr.devils.length;
      scanned++;
    }
    check('non-corridor chunks never grow dust devils (' + scanned + ' chunks)', leaked === 0);

    // corridor chunks DO get them occasionally (~5%): scan a wide deterministic band
    let corridorDevils = 0;
    for (let cx = -100; cx < 100; cx++) {
      mgr.reset();
      mgr.onChunkBuilt(cx, 99, 31337, { corridor: true, lights: [] });
      corridorDevils += mgr.devils.length;
    }
    check('corridor chunks grow dust devils at a low rate (~5%)',
      corridorDevils > 0 && corridorDevils < 200 * 0.2,
      corridorDevils + ' devils in 200 chunks');

    // lifetime: swirls ~20 s with grow-in and collapse scaling
    const devil = new DustDevil(scene, 0, 0, 555);
    devil.update(DT, []);
    const earlyScale = devil.root.scaling.x;
    for (let t = DT; t < 1.0; t += DT) devil.update(DT, []);
    const grownScale = devil.root.scaling.x;
    check('devil grows in over its first second',
      earlyScale > 0.001 && grownScale > earlyScale,
      earlyScale.toFixed(3) + ' -> ' + grownScale.toFixed(3));
    for (let t = 1.0; t < DUST_DEVIL_LIFETIME / 2; t += DT) devil.update(DT, []);
    const midScale = devil.root.scaling.x;
    check('devil holds full size through its middle age', midScale > grownScale * 0.99,
      'at ' + devil.life.toFixed(1) + 's scale=' + midScale.toFixed(3));
    for (let t = devil.life; t <= DUST_DEVIL_LIFETIME + DT; t += DT) devil.update(DT, []);
    check('devil collapses dead at ~' + DUST_DEVIL_LIFETIME + ' s', devil.dead === true);
  }

  // ---- 6: moths --------------------------------------------------------------------
  {
    const m = new Moth(scene, 3, -4, 888);
    let orbitOk = true, moved = false;
    let lx = m.root.position.x, lz = m.root.position.z;
    for (let i = 0; i < Math.round(8 / DT); i++) {
      m.update(DT);
      const p = m.root.position;
      if (Math.hypot(p.x - 3, p.z + 4) > 1.2) orbitOk = false;   // never strays from the fixture
      if (p.y < 2.0 || p.y > 2.95) orbitOk = false;              // bobs around the ceiling light
      if (Math.hypot(p.x - lx, p.z - lz) > 1e-5) moved = true;
      lx = p.x; lz = p.z;
    }
    check('moth orbits close around its fixture on sin paths', orbitOk);
    check('moth is always in motion', moved);

    // a dead fixture takes its resident with it
    const mgr = new FaunaManager(scene);
    const light = { x: 10.0, z: 2.0, alive: true };
    // deterministic: find a chunk seed whose build gives this light a moth
    let seeded = false;
    for (let ws = 0; ws < 200 && !seeded; ws++) {
      mgr.reset();
      mgr.onChunkBuilt(ws, 5, ws, { corridor: false, lights: [light] });
      seeded = mgr.moths.some((mo) => mo.fixtureKey === '10,2');
    }
    check('an alive working light can gain a resident moth', seeded);
    if (seeded) {
      light.alive = false; // the light dies
      mgr.update(DT, 0, 0, 0, [], undefined, [light]);
      check('moth leaves when its light dies', !mgr.moths.some((mo) => mo.fixtureKey === '10,2'));
    }
  }

  // ---- 7: skitter audio ---------------------------------------------------------------
  {
    const mgr = new FaunaManager(scene);
    const events = [];
    mgr.onSkitter = (pan, volume) => events.push({ pan, volume });

    // single hand-placed roach near the player keeps the source unambiguous
    const r = new Roach(scene, 2, 0, 4242);
    mgr.roaches.push(r);

    // free-running: quiet, throttled ticks fire while it scurries nearby
    for (let i = 0; i < Math.round(30 / DT); i++) mgr.update(DT, 0, 0, 0, []);
    check('skitter fires while a roach runs nearby', events.length > 0, String(events.length));
    check('skitter bursts stay very quiet (<= 0.045)',
      events.every((e) => e.volume <= 0.045 + 1e-9),
      JSON.stringify(events.map((e) => e.volume)));
    check('skitter pans stay inside [-1, 1]',
      events.every((e) => e.pan >= -1 && e.pan <= 1));

    // under the beam the roach freezes, and silence follows
    events.length = 0;
    const dx = r.x - 0, dz = r.z - 0;
    const d = Math.hypot(dx, dz);
    const yawAtRoach = Math.atan2(-dx / d, -dz / d); // torch facing straight at it
    for (let i = 0; i < Math.round(10 / DT); i++) mgr.update(DT, 0, 0, yawAtRoach, [], { on: true });
    check('roach pinned under the beam', r.frozen === true);
    check('no skitter while the roach is beam-frozen', events.length === 0,
      JSON.stringify(events));
  }

  engine.dispose();
}

main()
  .then(() => {
    rmSync(BUILD, { recursive: true, force: true });
    if (failures.length > 0) {
      console.error('\n' + failures.length + ' failure(s)');
      process.exit(1);
    }
    console.log('\nAll fauna tests passed (' + passed + ' checks).');
  })
  .catch((e) => {
    rmSync(BUILD, { recursive: true, force: true });
    console.error(e);
    process.exit(1);
  });
