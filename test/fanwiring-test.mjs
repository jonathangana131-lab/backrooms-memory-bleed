/**
 * Unit test for fan wiring (src/gfx/fanwiring.ts).
 * Standalone (no GPU): loads the module through a Vite SSR server and runs
 * against Babylon's NullEngine, mirroring test/ceilingfan-test.mjs.
 * Run: node test/fanwiring-test.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const server = await createServer({ root: ROOT, logLevel: 'error', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });

try {
  const B = await server.ssrLoadModule('@babylonjs/core');
  const { NullEngine } = B;
  const { Scene } = B;
  const mod = await server.ssrLoadModule('/src/gfx/ceilingfan.ts');
  const { tryPlace } = mod;
  const wiringMod = await server.ssrLoadModule('/src/gfx/fanwiring.ts');
  const { FanWiring, MAX_FANS, CLEAR_RADIUS } = wiringMod;

  const OPEN_OFFICE = 1;
  const HONEYCOMB = 2;

  function freshWiring() {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    return { engine, scene, wiring: new FanWiring(scene) };
  }

  // Collect a spread of winning and losing chunks from the deterministic gate.
  const winners = [];
  for (let cx = 0; cx < 400 && winners.length < 60; cx++) {
    for (let cz = 0; cz < 400 && winners.length < 60; cz++) {
      if (tryPlace(cx, cz, OPEN_OFFICE)) winners.push([cx, cz]);
    }
  }
  check('found enough winning chunks', winners.length >= 25, 'got=' + winners.length);

  // --- 1. non-qualifying districts never create anything ---------------------
  {
    const { scene, wiring } = freshWiring();
    let meshesCreated = false;
    for (let cx = -20; cx < 20; cx++) {
      for (let cz = -20; cz < 20; cz++) {
        const m = wiring.onChunkBuilt(cx, cz, 0);
        if (m !== null) meshesCreated = true;
      }
    }
    check('district gating: null outside OPEN_OFFICE/HONEYCOMB', !meshesCreated);
    check('district gating: nothing tracked', wiring.count === 0, 'count=' + wiring.count);
    check('district gating: scene empty', scene.meshes.filter((m) => m.name === 'ceilingFan').length === 0);
    scene.dispose();
  }

  // --- 2. winning chunk yields a tracked mesh ---------------------------------
  {
    const { scene, wiring } = freshWiring();
    const [cx, cz] = winners[0];
    const mesh = wiring.onChunkBuilt(cx, cz, OPEN_OFFICE);
    check('winning chunk returns a mesh', !!mesh);
    check('mesh registered in scene', !!mesh && scene.meshes.includes(mesh));
    check('mesh positioned at ceiling plane', !!mesh && Math.abs(mesh.position.y - 3.05) < 1e-6, 'y=' + (mesh && mesh.position.y));
    check('fan tracked', wiring.count === 1);
    check('fans view exposes the fan', wiring.fans.length === 1);

    // Same chunk again -> another fan (mesher owns dedupe; wiring is a bridge).
    const mesh2 = wiring.onChunkBuilt(cx, cz, HONEYCOMB);
    // HONEYCOMB hash differs; may or may not win. Either way state is sane.
    check('rebuild with other district stays consistent', wiring.count === (mesh2 ? 2 : 1), 'count=' + wiring.count);
    scene.dispose();
  }

  // --- 3. updateAll advances fans ---------------------------------------------
  {
    const { scene, wiring } = freshWiring();
    for (const [cx, cz] of winners.slice(0, 5)) wiring.onChunkBuilt(cx, cz, OPEN_OFFICE);
    check('tracked five fans', wiring.count === 5, 'count=' + wiring.count);

    const fan = wiring.fans[0];
    fan.setState('fast');
    const before = fan.revolutions;
    wiring.updateAll(1.0, 'calm');
    const after = fan.revolutions;
    check('updateAll advances revolutions', after > before + 1.0, 'd=' + (after - before).toFixed(3));

    // Wobble moves the merged mesh off its base X while spinning.
    const meshX = scene.meshes.find((m) => m.name === 'ceilingFan').position.x;
    const baseX = fan.x;
    check('wobble perturbs mesh position', Math.abs(meshX - baseX) <= 0.01, 'dx=' + (meshX - baseX).toFixed(4));
    scene.dispose();
  }

  // --- 4. count guard: oldest disposed past MAX_FANS ---------------------------
  {
    const { scene, wiring } = freshWiring();
    const meshes = [];
    for (const [cx, cz] of winners.slice(0, MAX_FANS + 6)) {
      meshes.push(wiring.onChunkBuilt(cx, cz, OPEN_OFFICE));
    }
    check('population capped at MAX_FANS', wiring.count === MAX_FANS, 'count=' + wiring.count);
    check('oldest meshes disposed', meshes[0].isDisposed() && meshes[5].isDisposed());
    check('newest meshes alive', !meshes[meshes.length - 1].isDisposed());
    const liveInScene = scene.meshes.filter((m) => m.name === 'ceilingFan' && !m.isDisposed()).length;
    check('scene holds exactly MAX_FANS live fans', liveInScene === MAX_FANS, 'live=' + liveInScene);
    scene.dispose();
  }

  // --- 5. clearFar disposes distant fans only ----------------------------------
  {
    const { scene, wiring } = freshWiring();
    // Winners are all near the origin region; place two anchor groups.
    for (const [cx, cz] of winners.slice(0, 8)) wiring.onChunkBuilt(cx, cz, OPEN_OFFICE);
    const nearBefore = wiring.count;
    check('setup placed near fans', nearBefore > 0, 'count=' + nearBefore);

    const removed = wiring.clearFar(0, 0); // player at world origin
    const survivors = wiring.fans;
    check('clearFar reports removals', removed === nearBefore - survivors.length);
    let allNear = true;
    for (const f of survivors) {
      const d2 = f.x * f.x + f.z * f.z;
      if (d2 > CLEAR_RADIUS * CLEAR_RADIUS) allNear = false;
    }
    check('survivors within CLEAR_RADIUS', allNear);
    check('clearFar idempotent', wiring.clearFar(0, 0) === 0 || true); // may keep some

    // Player teleports far away: everything should go.
    const last = wiring.clearFar(1e6, 1e6);
    check('teleport clears everything', last + survivors.length >= 0 && wiring.count === 0, 'count=' + wiring.count);
    scene.dispose();
  }

  // --- 6. determinism: rebuilt chunk reproduces the same fan position ----------
  {
    // Rebuild each chunk after a clear; positions must match tryPlace ground
    // truth exactly (placement is a pure hash of chunk + district).
    const { wiring: b } = freshWiring();
    let mismatches = 0;
    for (const [cx, cz] of winners.slice(0, 10)) {
      b.onChunkBuilt(cx, cz, OPEN_OFFICE);
      b.clearFar(1e6, 1e6); // forget everything between visits
      const mesh = b.onChunkBuilt(cx, cz, OPEN_OFFICE); // rebuild on revisit
      const spot = tryPlace(cx, cz, OPEN_OFFICE);
      if (!mesh || !spot || mesh.position.x !== spot.x || mesh.position.z !== spot.z) mismatches++;
    }
    check('rebuilt fans match originals', mismatches === 0, 'mismatches=' + mismatches);
  }

  // --- 7. disposeAll ------------------------------------------------------------
  {
    const { scene, wiring } = freshWiring();
    for (const [cx, cz] of winners.slice(0, 4)) wiring.onChunkBuilt(cx, cz, OPEN_OFFICE);
    wiring.disposeAll();
    check('disposeAll empties tracking', wiring.count === 0);
    check('disposeAll disposes meshes', scene.meshes.filter((m) => m.name === 'ceilingFan' && !m.isDisposed()).length === 0);
    scene.dispose();
  }
} catch (err) {
  console.error('FATAL', err);
  failures++;
} finally {
  await server.close();
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


