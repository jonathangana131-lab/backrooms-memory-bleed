/**
 * Unit test for ceiling fans (src/gfx/ceilingfan.ts).
 * Standalone (no GPU): loads the module through a Vite SSR server and runs
 * mesh checks against Babylon's NullEngine.
 * Run: node test/ceilingfan-test.mjs
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
  const { NullEngine, Scene } = B;
  const mod = await server.ssrLoadModule('/src/gfx/ceilingfan.ts');
  const { CeilingFan, tryPlace, FAN_SPEEDS, FAN_STATES } = mod;

  const OPEN_OFFICE = 1;
  const HONEYCOMB = 2;
  const OTHERS = [0, 3, 4];

  // --- 1. district gating ----------------------------------------------------
  {
    let placed = 0;
    for (let cx = -60; cx < 60; cx++) {
      for (let cz = -60; cz < 60; cz++) {
        for (const d of OTHERS) if (tryPlace(cx, cz, d) !== null) placed++;
      }
    }
    check('never places outside OPEN_OFFICE/HONEYCOMB', placed === 0, 'placed=' + placed);
  }

  // --- 2. rarity ~10% + determinism ------------------------------------------
  {


    let placed = 0;
    const N = 200;
    const seen = new Map();
    for (let cx = 0; cx < N; cx++) {
      for (let cz = 0; cz < N; cz++) {
        const p = tryPlace(cx, cz, OPEN_OFFICE);
        if (p) { placed++; seen.set(cx + ':' + cz + ':o', p); }
        const q = tryPlace(cx, cz, HONEYCOMB);
        if (q) { placed++; seen.set(cx + ':' + cz + ':h', q); }
      }
    }
    const rate = placed / (N * N * 2);
    check('placement rate ~1 per 10 qualifying chunks', rate > 0.085 && rate < 0.115, 'rate=' + rate.toFixed(4));

    let mismatches = 0;
    for (const [k, p] of seen) {
      const parts = k.split(':');
      const again = tryPlace(+parts[0], +parts[1], parts[2] === 'o' ? OPEN_OFFICE : HONEYCOMB);
      if (!again || Math.abs(again.x - p.x) > 1e-9 || Math.abs(again.z - p.z) > 1e-9) mismatches++;
    }
    check('deterministic across repeated calls', mismatches === 0, 'mismatches=' + mismatches);
  }

  // --- 3. placement near room centre, inside chunk ---------------------------
  {
    let bad = 0;
    let checked = 0;
    for (let cx = 0; cx < 300 && checked < 800; cx++) {
      for (let cz = 0; cz < 300 && checked < 800; cz++) {
        for (const d of [OPEN_OFFICE, HONEYCOMB]) {
          const p = tryPlace(cx, cz, d);
          if (!p) continue;
          checked++;
          const inX = p.x >= cx * 30 && p.x < (cx + 1) * 30;
          const inZ = p.z >= cz * 30 && p.z < (cz + 1) * 30;
          const nearCx = Math.abs(p.x - (cx * 30 + 15)) <= 3;
          const nearCz = Math.abs(p.z - (cz * 30 + 15)) <= 3;
          if (!(inX && inZ && nearCx && nearCz)) bad++;
        }
      }
    }
    check('fans sit near room centre inside their chunk', bad === 0 && checked > 0,
      'bad=' + bad + ' checked=' + checked);
  }

  // --- 4. mesh assembly hangs from the ceiling plane ---------------------------
  {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const fan = new CeilingFan(45, 75, 'slow');
    const mesh = fan.createMesh(scene);
    check('mesh builds and is named', !!mesh && mesh.name === 'ceilingFan',
      mesh && mesh.name);
    check('hangs from the ceiling plane y=WALL_H', Math.abs(mesh.position.y - 3.05) < 1e-9,
      String(mesh.position.y));
    check('anchored at the placement x/z', mesh.position.x === 45 && mesh.position.z === 75);
    check('wears the shared dull-metal material', !!mesh.material && mesh.material.name === 'bmbFanMetal',
      mesh.material && mesh.material.name);
    const fan2 = new CeilingFan(-45, -75, 'fast');
    const mesh2 = fan2.createMesh(scene);
    check('material is cached per scene', mesh2.material === mesh.material);
    scene.dispose();
  }

  // --- 5. spin rate and bent-rod wobble ----------------------------------------
  {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const fan = new CeilingFan(10, 10, 'off');
    const mesh = fan.createMesh(scene);
    for (let i = 0; i < 60; i++) fan.update(1 / 60, 'calm');
    check('off fans do not accumulate revolutions', fan.revolutions === 0,
      String(fan.revolutions));
    const stillX = mesh.position.x;
    const stillZ = mesh.position.z;
    for (let i = 0; i < 30; i++) fan.update(1 / 60, 'calm');
    check('off fans freeze solid', mesh.position.x === stillX && mesh.position.z === stillZ);

    fan.setState('fast');
    for (let i = 0; i < 60; i++) fan.update(1 / 60, 'calm');
    check('fast spins ~1.5 rev/s', Math.abs(fan.revolutions - 1.5) < 1e-6,
      String(fan.revolutions));
    const wobX = Math.abs(mesh.position.x - 10);
    const wobZ = Math.abs(mesh.position.z - 10);
    check('hub wobbles within +/-2 mm of its mount',
      wobX <= 0.0021 && wobZ <= 0.0021 && (wobX > 0 || wobZ > 0),
      'x=' + wobX + ' z=' + wobZ);
    scene.dispose();
  }

  // --- 6. fans only misbehave under tension -------------------------------------
  {
    const calm = new CeilingFan(20, 20, 'medium');
    let flipped = 0;
    let last = calm.state;
    for (let i = 0; i < 60 * 120; i++) {
      calm.update(1 / 60, 'release');
      if (calm.state !== last) { flipped++; last = calm.state; }
    }
    check('calm/release phases never flip state', flipped === 0, String(flipped));

    const tense = new CeilingFan(30, 30, 'medium');
    flipped = 0;
    last = tense.state;
    for (let i = 0; i < 60 * 120; i++) {
      tense.update(1 / 60, 'peak');
      if (tense.state !== last) { flipped++; last = tense.state; }
    }
    check('peak tension flips state within a couple of minutes', flipped >= 1, String(flipped));
  }

  // --- 7. setState validates strictly --------------------------------------------
  {
    const fan = new CeilingFan(5, 5, 'slow');
    fan.setState('fast');
    check('setState accepts every listed state', fan.state === 'fast');
    let threw = '';
    try { fan.setState('turbo'); } catch (e) { threw = e.constructor.name; }
    check('unknown states throw TypeError', threw === 'TypeError', threw);
    check('FAN_SPEEDS covers all four states',
      JSON.stringify(Object.keys(FAN_SPEEDS)) === JSON.stringify(FAN_STATES));
  }
} catch (err) {
  console.error('FATAL', err);
  failures++;
} finally {
  await server.close();
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
