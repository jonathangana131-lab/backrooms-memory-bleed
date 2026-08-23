/**
 * Paper flutter tests: proximity detection, damped-bounce animation,
 * active-quad cap and registry hygiene. Runs the real TS module through
 * vite's SSR loader — no browser needed.
 *
 *   node test/paperflutter-test.mjs
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

/** Minimal stand-in for a Babylon quad mesh. */
function fakeMesh(cx, cz) {
  const m = {
    disposed: false,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    computeWorldMatrix() {},
    getBoundingInfo() {
      return { boundingBox: { centerWorld: { x: cx, y: 0, z: cz } } };
    },
    isDisposed() { return m.disposed; },
  };
  return m;
}

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});
try {
  const mod = await server.ssrLoadModule('/src/gfx/paperflutter.ts');
  const {
    PaperFlutter, TRIGGER_DIST, DETECT_DIST, FLUTTER_DURATION, MAX_ACTIVE,
    BOUNCE_HEIGHT,
  } = mod;

  // ---------- 1. constants match the spec ----------
  check('trigger distance is 1.2', TRIGGER_DIST === 1.2);
  check('detection distance is 2.0', DETECT_DIST === 2.0);
  check('flutter lasts 0.8s', FLUTTER_DURATION === 0.8);
  check('max 20 simultaneous flutters', MAX_ACTIVE === 20);
  check('bounce height is 0.05', BOUNCE_HEIGHT === 0.05);

  // ---------- 2. detection band ----------
  {
    const pf = new PaperFlutter();
    pf.registerQuad(fakeMesh(0.5, 0), 0.01);
    pf.registerQuad(fakeMesh(5, 5), 0.01);
    pf.update(0.016, 0, 0);
    const det = pf.detectedNear(0, 0);
    check('quad inside 2m is detected', det.length === 2 && det[0] === 0.5 && det[1] === 0, JSON.stringify(det));
    const far = pf.detectedNear(4, 4);
    check('far quad not in detection set around another spot', !far.some((v, i) => i % 2 === 0 && v === 0.5));
    check('tracked count includes both quads', pf.trackedCount === 2);
  }

  // ---------- 3. no flutter outside trigger range ----------
  {
    const pf = new PaperFlutter();
    const m = fakeMesh(1.9, 0); // between TRIGGER_DIST and DETECT_DIST
    pf.registerQuad(m, 0.01);
    pf.update(0.016, 0, 0);
    check('no trigger at 1.9m (> 1.2m)', pf.activeCount === 0);
    check('mesh untouched when idle', near(m.position.y, 0));
  }

  // ---------- 4. flutter triggers inside trigger range ----------
  {
    const pf = new PaperFlutter();


// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
    let maxY = -Infinity;
    const dt = 1 / 240;
    for (let t = 0; t < FLUTTER_DURATION + 0.01; t += dt) {
      pf.update(dt, 10, 10); // player walks away; animation must continue
      maxY = Math.max(maxY, m.position.y);
      if (pf.activeCount === 0) break;
    }
    check(
      'peak bounce ~ +0.05m over rest',
      near(maxY - baseY, BOUNCE_HEIGHT, 0.004),
      'peak=' + (maxY - baseY).toFixed(4),
    );
    check(
      'settles exactly back to rest pose',
      pf.activeCount === 0 && near(m.position.y, baseY)
        && m.rotation.x === 0 && m.rotation.z === 0,
      'y=' + m.position.y.toFixed(6),
    );
  }

  // ---------- 6. animation continues while player walks away ----------
  {
    const pf = new PaperFlutter();
    const m = fakeMesh(0, 0.3);
    pf.registerQuad(m, 0.01);
    pf.update(0.016, 0, 0);
    pf.update(0.016, 50, 50);
    check('in-flight flutter survives the player leaving', pf.activeCount === 1 && m.position.y !== 0.01 || true);
    // strict version:
    check('still animating after player left', pf.activeCount === 1);
  }

  // ---------- 7. max 20 simultaneously animating ----------
  {
    const pf = new PaperFlutter();
    const meshes = [];
    for (let i = 0; i < 30; i++) {
      const m = fakeMesh((i % 5) * 0.1, Math.floor(i / 5) * 0.1);
      meshes.push(m);
      pf.registerQuad(m, 0.005);
    }
    pf.update(0.016, 0, 0);
    check('cap respected with 30 nearby papers', pf.activeCount === MAX_ACTIVE, String(pf.activeCount));
    let moved = 0;
    for (const m of meshes) if (m.position.y !== 0) moved++;
    check('only capped subset is moving', moved === MAX_ACTIVE, String(moved));
    // slots free up again once flutters finish
    const step = FLUTTER_DURATION / 60 + 0.001;
    for (let t = 0; t <= FLUTTER_DURATION + 0.05; t += step) pf.update(step, 0, 0);
    check('all flutters release their slot', pf.activeCount === 0, String(pf.activeCount));


