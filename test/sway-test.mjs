/*
 * Fixture sway system test - runs headless in Node.
 *
 * src/gfx/sway.ts only imports Babylon maths as runtime code (pure JS),
 * everything else type-only, so we transpile it with the workspace
 * TypeScript compiler and drive FixtureSway against stub nodes/lights.
 *
 * Verifies:
 *   1. pendulum motion: +/-1.5 deg at ~0.4 Hz with per-fixture phase offsets
 *   2. director tension: amplitude widens toward +/-3 deg at tension=1
 *   3. light position sync: the PointLight swings on the same mount
 *   4. onSwayPeak fires exactly when swing direction reverses
 *   5. wind gusts: amplitude doubles for ~2 s every 30-60 s
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/gfx/sway.ts'), 'utf8');
const out = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
  // Node ESM needs explicit extensions; tsconfig uses bundler resolution.
  .replace(/from '(\/[^']+|@[^']+)'/g, "from '$1.js'");
const genPath = join(root, 'test/.sway.gen.mjs');
writeFileSync(genPath, out);

const { FixtureSway, GUST_MULT, GUST_DUR } = await import(genPath + '?t=' + Date.now());

const DEG = Math.PI / 180;
const DT = 1 / 60;

function makeNode(x = 0, y = 2.86, z = 0) {
  return { position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 } };
}

(Showing lines 1-40 of 253. Use offset=41 to continue.)


function makeLight(x = 0, y = 2.7, z = 0) {
  return { position: { x, y, z }, range: 13.5 };
}

/** Count direction reversals of a rotation series (velocity sign flips). */
function countReversals(rots) {
  let n = 0;
  for (let i = 2; i < rots.length; i++) {
    const v1 = rots[i - 1] - rots[i - 2];
    const v2 = rots[i] - rots[i - 1];
    if (v1 > 0 && v2 < 0) n++;      // was rising, now falling -> peak
    else if (v1 < 0 && v2 > 0) n++; // was falling, now rising -> trough
  }
  return n;
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));

(Showing lines 1-60 of 253. Use offset=61 to continue.)

  if (!ok) failures++;
}

async function main() {
  // ---- 1. pendulum motion --------------------------------------------
  {
    const sway = new FixtureSway();
    const a = makeNode(3, 2.86, 5);
    sway.register(a);
    const rots = [];
    for (let i = 0; i < 60 * 10; i++) {
      sway.update(DT, 0);
      rots.push(a.rotation.z);
    }
    const maxAbs = Math.max(...rots.map(Math.abs));
    check('swings within ~1.5 deg at tension=0',
      maxAbs <= 1.6 * DEG && maxAbs >= 1.4 * DEG,
      'max=' + (maxAbs / DEG).toFixed(3) + 'deg');

    // measure period from positive-going zero crossings (~one per period)
    const crossings = [];
    for (let i = 1; i < rots.length; i++) {
      if (rots[i - 1] < 0 && rots[i] >= 0) crossings.push(i);
    }
    const spanFrames = crossings[crossings.length - 1] - crossings[0];
    const cycles = crossings.length - 1;
    const hz = cycles / (spanFrames * DT);
    check('frequency ≈ 0.4 Hz', Math.abs(hz - 0.4) < 0.03, 'measured=' + hz.toFixed(3) + 'Hz');

    // per-fixture phase offsets must desynchronise fixtures
    const b = makeNode(8, 2.86, 4);
    sway.register(b);
    let differ = false;
    for (let i = 0; i < 240; i++) {
      sway.update(DT, 0);
      if (Math.abs(a.rotation.z - b.rotation.z) > 0.05 * DEG) { differ = true; break; }
    }
    check('per-fixture phase offsets desynchronise fixtures', differ);
    sway.clear();
  }

  // ---- 2. tension response -------------------------------------------
  {
    const sway = new FixtureSway();
    const a = makeNode();
    sway.register(a);
    let maxT0 = 0, maxT1 = 0;
    for (let i = 0; i < 60 * 12; i++) {
      sway.update(DT, 0);
      maxT0 = Math.max(maxT0, Math.abs(a.rotation.z));
    }
    for (let i = 0; i < 60 * 12; i++) {
      sway.update(DT, 1);
      maxT1 = Math.max(maxT1, Math.abs(a.rotation.z));
    }
    check('tension=0 amplitude ≈ 1.5 deg', Math.abs(maxT0 / DEG - 1.5) < 0.15, (maxT0 / DEG).toFixed(3));
    check('tension=1 amplitude ≈ 3 deg', Math.abs(maxT1 / DEG - 3) < 0.25, (maxT1 / DEG).toFixed(3));
    check('tension roughly doubles swing', maxT1 > maxT0 * 1.7 && maxT1 < maxT0 * 2.3,
      (maxT1 / maxT0).toFixed(2) + 'x');
    sway.clear();
  }

  // ---- 3. light position sync -----------------------------------------
  {
    const sway = new FixtureSway();
    const a = makeNode(10, 2.86, -4);
    const ARM = 0.31;
    const light = makeLight(10, a.position.y - ARM, -4); // hangs ARM below mount
    sway.register(a, light);
    let maxDx = 0;
    for (let i = 0; i < 60 * 6; i++) {
      sway.update(DT, 0);
      maxDx = Math.max(maxDx, Math.abs(light.position.x - 10));
      // hang-arm length must be preserved by the Z rotation
      const dy = light.position.y - a.position.y;
      const dx = light.position.x - a.position.x;
      if (Math.abs(Math.hypot(dx, dy) - ARM) > 1e-9) {
        check('hang-arm length preserved', false, 'len=' + Math.hypot(dx, dy));
        break;
      }
    }
    check('light moves horizontally with the swing', maxDx > 0.001, 'maxdx=' + maxDx.toFixed(5));
    check('lateral shift bounded by arm × sin(1.5°)',
      maxDx <= ARM * Math.sin(1.55 * DEG) + 1e-9, 'limit=' + (ARM * Math.sin(1.55 * DEG)).toFixed(5));

    // un-register restores rest pose exactly
    sway.unregister(a);
    check('unregister restores light rest position',
      light.position.x === 10 && light.position.y === a.position.y - ARM && light.position.z === -4);

    // re-register with a fresh light refreshes the binding
    const light2 = makeLight(10, a.position.y - 0.5, -4);
    sway.register(a, light2);
    for (let i = 0; i < 30; i++) sway.update(DT, 0);
    check('re-register rebinds light sync', light2.position.x !== 10 || light2.position.y !== a.position.y - 0.5);
    sway.clear();
  }

  // ---- 4. onSwayPeak chain-creak hook ----------------------------------
  {
    const sway = new FixtureSway();
    const a = makeNode();
    sway.register(a);
    const peaks = [];
    sway.onSwayPeak = (node) => peaks.push(node.rotation.z);
    const SECONDS = 20;
    const rots = [];
    for (let i = 0; i < 60 * SECONDS; i++) {
      sway.update(DT, 0);
      rots.push(a.rotation.z);
    }
    const expected = countReversals(rots);
    // ±1: the discrete detector can miss the very last reversal at the
    // window edge; the callback fires on the exact cos() sign flip.
    check('onSwayPeak fires once per direction reversal', Math.abs(peaks.length - expected) <= 1,
      'fired=' + peaks.length + ' reversals=' + expected);
    // ~twice per period at 0.4 Hz
    check('reversal rate ≈ 2 per 2.5 s period',
      Math.abs(peaks.length / SECONDS - 2 * 0.4) < 0.12,
      'rate=' + (peaks.length / SECONDS).toFixed(3) + '/s');
    // every callback lands near an amplitude extremum
    const nearExtremum = peaks.every((r) => Math.abs(r) >= 1.35 * DEG);
    check('peaks land at swing extrema', nearExtremum);
    sway.clear();

    const quiet = new FixtureSway();
    const b = makeNode();
    quiet.register(b);
    let firedWhileNull = false;
    quiet.onSwayPeak = null;
    Object.defineProperty(quiet, 'onSwayPeak', { value: () => { firedWhileNull = true; }, writable: true });
    // restore null explicitly - hook is optional
    quiet.onSwayPeak = null;
    for (let i = 0; i < 120; i++) quiet.update(DT, 0);
    check('null onSwayPeak tolerated', !firedWhileNull);
    quiet.clear();
  }

  // ---- 5. wind gusts ----------------------------------------------------
  {
    const sway = new FixtureSway();
    const a = makeNode();
    sway.register(a);
    // forced gust: amplitude should approach base × GUST_MULT during burst
    sway.triggerGust();
    let maxGust = 0;
    for (let i = 0; i < Math.round(GUST_DUR * 0.9 / DT); i++) {
      sway.update(DT, 0);
      maxGust = Math.max(maxGust, Math.abs(a.rotation.z));
    }
    check('gust boosts amplitude ≈ ×' + GUST_MULT,
      Math.abs(maxGust / DEG - 1.5 * GUST_MULT) < 0.35, 'max=' + (maxGust / DEG).toFixed(3) + 'deg');
    check('gustActive during burst', sway.gustActive);

    // envelope decays back to baseline afterwards
    for (let i = 0; i < 60 * 4; i++) sway.update(DT, 0);
    check('gustActive clears after burst', !sway.gustActive);

    // scheduler re-arms inside the 30-60 s window: a second gust occurs
    // within 61 s of simulated time without any manual trigger.
    let secondGustSeen = -1;
    for (let i = 0; i < 60 * 61; i++) {
      sway.update(DT, 0);
      if (sway.gustActive) { secondGustSeen = i * DT; break; }
    }
    check('gusts recur within 30-60 s unprompted', secondGustSeen > GUST_DUR && secondGustSeen <= 61,
      secondGustSeen < 0 ? 'never' : 'after ' + secondGustSeen.toFixed(1) + 's');
    sway.clear();
  }

  // ---- misc: duplicate register, dt clamp -------------------------------
  {
    const sway = new FixtureSway();
    const a = makeNode();
    sway.register(a);
    sway.register(a);
    check('duplicate register keeps one entry', sway.count === 1);
    sway.update(50, 0); // huge frame must not explode the sim
    check('dt clamp survives giant frames', Number.isFinite(a.rotation.z) && Math.abs(a.rotation.z) < 10 * DEG);
    sway.clear();
    check('clear restores empty registry', sway.count === 0);
  }

  unlinkSync(genPath);
  console.log(failures === 0 ? 'ALL SWAY TESTS PASSED' : failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  try { unlinkSync(genPath); } catch { /* ignore */ }
  process.exit(1);
});


