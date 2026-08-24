/**
 * Footprint trail tests: spawn/alternation, fade lifetime, pool recycling,
 * surface profiles and buffer-stability (zero reallocation). Runs the real
 * TS module against Babylon's NullEngine through vite's SSR loader — no
 * browser or GPU needed.
 *
 *   node test/footprints-test.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok - ' + name);
  else { failures++; console.error('FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const B = await server.ssrLoadModule('@babylonjs/core');
  const mod = await server.ssrLoadModule('/src/gfx/footprints.ts');
  const {
    Footprints, FOOTPRINT_POOL_SIZE, FOOTPRINT_LIFETIME, FOOTPRINT_ALPHA,
    SURFACE_PROFILES, STRIDE_HALF, PRINT_Y,
  } = mod;

  function makeScene() {
    const engine = new B.NullEngine();
    return new B.Scene(engine);
  }

  // ---------- 1. spec constants ----------
  check('pool holds 40 quads', FOOTPRINT_POOL_SIZE === 40);
  check('lifetime is 30 seconds', FOOTPRINT_LIFETIME === 30);
  check('peak alpha is 0.25', FOOTPRINT_ALPHA === 0.25);

  // ---------- 2. spawning + left/right alternation ----------
  {
    const fp = new Footprints(makeScene(), 'hard');
    fp.step(0, 0, 0, -1, false); // walking toward -Z
    fp.step(0.9, 0, 0, -1, false);
    check('two steps -> two live prints', fp.count === 2);
    const a = fp.centerAt(0);
    const b = fp.centerAt(1);
    // perpendicular to (0,-1) is (1,0): offsets measured from each stamp's
    // OWN base (the two steps sit 0.9 apart on purpose) must straddle the
    // travel line symmetrically
    const oa = a.x - 0;
    const ob = b.x - 0.9;
    check('first print offset left of travel', oa < 0, 'x=' + a.x);
    check('second print offset right of travel', ob > 0, 'x=' + b.x);
    check('offsets are symmetric', near(Math.abs(oa), Math.abs(ob)),
      Math.abs(oa) + ' vs ' + Math.abs(ob));
    check('pair interleaves fore/aft by stride half',
      near(Math.abs(b.z - a.z), STRIDE_HALF * 2), 'dz=' + (b.z - a.z));
    fp.dispose();
  }

  // ---------- 3. heading normalization ----------
  {
    const fp = new Footprints(makeScene(), 'hard');
    fp.step(5, 5, 10, 0, false); // unnormalized +X
    const c = fp.centerAt(0);
    // normalized heading (1,0): centre sits STRIDE_HALF fore/aft on x with
    // the hard-surface lateral offset on z (side alternation is covered in 2)
    const fx = c.x - 5;
    const fz = c.z - 5;
    check('unnormalized direction handled',
      near(Math.abs(fx), STRIDE_HALF) && near(Math.abs(fz), SURFACE_PROFILES.hard.lateral),
      'c=' + JSON.stringify(c));
    fp.step(5, 5, 0, 0, false); // degenerate heading
    check('zero-length heading skipped', fp.count === 1);
    fp.dispose();
  }

  // ---------- 4. fresh-print alpha ----------
  {
    const fp = new Footprints(makeScene(), 'carpet');
    fp.step(0, 0, 1, 0, false);
    check('fresh print alpha peaks at 0.25', near(fp.alphaAt(0), FOOTPRINT_ALPHA), String(fp.alphaAt(0)));
    fp.update(1 / 60);
    check('alpha decays after one frame', fp.alphaAt(0) < FOOTPRINT_ALPHA && fp.alphaAt(0) > 0.2);
    fp.dispose();
  }

  // ---------- 5. fade lifetime: linear to zero, then slot frees ----------
  {
    const fp = new Footprints(makeScene(), 'hard');
    fp.step(0, 0, 1, 0, false);
    let mono = true;
    let prev = fp.alphaAt(0);
    const dt = 0.5;
    let elapsed = 0;
    while (elapsed < FOOTPRINT_LIFETIME) {
      fp.update(dt);
      elapsed += dt;
      const a = fp.alphaAt(0);
      if (a > prev + 1e-9 || a < 0) mono = false;
      prev = a;
    }
    check('fade is monotonic and non-negative', mono);
    check('alpha ~ 0 at end of lifetime', near(fp.alphaAt(0), 0, 1e-6), String(fp.alphaAt(0)));
    fp.update(dt); // push past expiry
    check('print recycles its slot after 30s', fp.count === 0);
    fp.dispose();
  }

  // ---------- 6. surface awareness ----------
  {
    const car = SURFACE_PROFILES.carpet;
    const hard = SURFACE_PROFILES.hard;
    check('carpet stamp larger than hard', car.width > hard.width && car.length > hard.length);
    check('carpet stamp darker than hard', car.shade < hard.shade);

    const fpC = new Footprints(makeScene(), 'carpet');
    const fpH = new Footprints(makeScene(), 'hard');
    fpC.step(0, 0, 1, 0, false);
    fpH.step(0, 0, 1, 0, false);
    const meshC = fpC['mesh'];
    const meshH = fpH['mesh'];
    const colC = meshC.getVerticesData('color');
    const colH = meshH.getVerticesData('color');
    check('vertex RGB darker on carpet', colC[0] < colH[0], colC[0] + ' vs ' + colH[0]);
    check('same peak alpha on both surfaces', near(colC[3], colH[3]));
    const posC = meshC.getVerticesData('position');
    const posH = meshH.getVerticesData('position');
    // heading is +X, so the stamp length shows up as the X extent across corners
    function extentX(p) {
      return Math.max(p[0], p[3], p[6], p[9]) - Math.min(p[0], p[3], p[6], p[9]);
    }
    const spanC = extentX(posC);
    const spanH = extentX(posH);
    check('carpet quad physically longer', spanC > spanH, spanC + ' vs ' + spanH);
    check('quads hover above floor', near(posC[1], PRINT_Y));
    fpC.dispose(); fpH.dispose();
  }

  // ---------- 7. sprint widens the gait ----------
  {
    const fp = new Footprints(makeScene(), 'hard');
    fp.step(0, 0, 1, 0, false);
    const walk = Math.abs(fp.centerAt(0).z);
    fp.clear();
    fp.step(0, 0, 1, 0, true);
    const sprint = Math.abs(fp.centerAt(0).z);
    check('sprinting stamps wider than walking', sprint > walk, sprint + ' vs ' + walk);
    fp.dispose();
  }

  // ---------- 8. pool recycling: oldest first, cap at 40 ----------
  {
    const fp = new Footprints(makeScene(), 'hard');
    const stamped = [];
    for (let i = 0; i < FOOTPRINT_POOL_SIZE + 5; i++) {
      fp.step(i, 0, 1, 0, false);
      stamped.push({ x: i, z: fp.centerAt((fp.printsSpawned - 1) % FOOTPRINT_POOL_SIZE).z });
    }
    check('live count capped at pool size', fp.count === FOOTPRINT_POOL_SIZE);
    check('all spawns accounted', fp.printsSpawned === FOOTPRINT_POOL_SIZE + 5);
    // after N+5 stamps the ring has wrapped: prints #40..#44 overwrote the
    // oldest slots 0..4, so slot k holds the newest print congruent to k mod N
    let wrapOk = true;
    for (let k = 0; k < FOOTPRINT_POOL_SIZE; k++) {
      const expectX = k < 5 ? FOOTPRINT_POOL_SIZE + k : k;
      const cx = fp.centerAt(k).x;
      // centres sit STRIDE_HALF fore/aft of the integer stamp line on x
      if (Math.round(cx) !== expectX || !near(Math.abs(cx - expectX), STRIDE_HALF)) {
        wrapOk = false; break;
      }
    }
    check('ring recycles oldest slots first', wrapOk);
    fp.dispose();
  }

  // ---------- 9. zero reallocation during gameplay ----------
  {
    const scene = makeScene();
    const fp = new Footprints(scene, 'carpet');
    const posBefore = fp['mesh'].getVerticesData('position');
    const colBefore = fp['mesh'].getVerticesData('color');
    for (let i = 0; i < 200; i++) {
      fp.step(i * 0.01, i * 0.02, 0.6, 0.8, i % 2 === 0);
      fp.update(1 / 60);
    }
    const posAfter = fp['mesh'].getVerticesData('position');
    const colAfter = fp['mesh'].getVerticesData('color');
    check('position buffer identity stable (in-place updates)', posAfter === posBefore);
    check('colour buffer identity stable (in-place updates)', colAfter === colBefore);
    check('steady state still capped at 40', fp.count <= FOOTPRINT_POOL_SIZE);
    fp.dispose();
  }

  // ---------- 10. clear() resets everything ----------
  {
    const fp = new Footprints(makeScene(), 'hard');
    for (let i = 0; i < 10; i++) fp.step(i * 0.1, 0, 1, 0, false);
    fp.clear();
    check('clear empties the trail', fp.count === 0);
    check('clear zeroes alphas', fp.alphaAt(0) === 0 && fp.alphaAt(9) === 0);
    const pos = fp['mesh'].getVerticesData('position');
    check('cleared quads collapse below floor', near(pos[1], -10));
    // ring restarts cleanly afterwards; heading (0,1) puts the lateral
    // offset on x and the fore/aft interleave on z
    fp.step(3, 4, 0, 1, false);
    const c = fp.centerAt(0);
    check('usable again after clear',
      fp.count === 1 &&
      near(Math.abs(c.x - 3), SURFACE_PROFILES.hard.lateral) &&
      near(Math.abs(c.z - 4), STRIDE_HALF),
      'c=' + JSON.stringify(c));
    fp.dispose();
  }

  // ---------- 11. unknown surface falls back safely ----------
  {
    let threw = false;
    try {
      const fp = new Footprints(makeScene(), /** @type {any} */ ('lava'));
      check('unknown surface falls back to hard profile', fp['profile'] === SURFACE_PROFILES.hard);
      fp.dispose();
    } catch { threw = true; }
    check('unknown surface does not throw', !threw);
  }
} finally {
  await server.close();
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


