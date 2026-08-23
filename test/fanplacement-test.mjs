/**
 * Unit test for fan placement variety (src/gfx/fanplacement.ts).
 * Pure logic - loads through a Vite SSR server like the other gfx tests.
 * Run: node test/fanplacement-test.mjs
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
  const mod = await server.ssrLoadModule('/src/gfx/fanplacement.ts');
  const { getFanSpec, FAN_CONTEXTS } = mod;

  const N = 200;

  // --- 1. spec shape + per-family standards ----------------------------------
  {
    const expectBlades = { office: [4], medical: [3], storage: [6], chapel: [5, 6, 8] };
    const baseSize = { office: 1.32, medical: 1.52, storage: 2.40, chapel: 1.80 };
    let bad = 0;
    for (const ctx of FAN_CONTEXTS) {
      for (let cx = -20; cx < 20 && bad === 0; cx++) {
        for (let cz = -20; cz < 20 && bad === 0; cz++) {
          const s = getFanSpec(cx, cz, ctx);
          if (!s || typeof s !== 'object') { bad++; break; }
          if (!expectBlades[ctx].includes(s.bladeCount)) { bad++; break; }
          if (s.rotationDir !== 1 && s.rotationDir !== -1) { bad++; break; }
          if (typeof s.sizeM !== 'number' || !(s.sizeM > 0)) { bad++; break; }
          if (s.style !== ctx) { bad++; break; }
          const lo = baseSize[ctx] * 0.9199;
          const hi = baseSize[ctx] * 1.0801;
          if (s.sizeM < lo || s.sizeM > hi) { bad++; break; }
        }
      }
      check('context "' + ctx + '" specs valid and within size band', bad === 0, 'bad=' + bad);
      bad = 0;
    }
    check('office standard is exactly 4 blades',
      getFanSpec(3, 7, 'office').bladeCount === 4);
    check('medical standard is exactly 3 blades',
      getFanSpec(3, 7, 'medical').bladeCount === 3);
    check('storage standard is exactly 6 blades',
      getFanSpec(3, 7, 'storage').bladeCount === 6);

    // Storage must be the big one: every storage fan wider than any office fan sampled.
    let storageMin = Infinity, officeMax = 0;
    for (let cx = 0; cx < 50; cx++) for (let cz = 0; cz < 50; cz++) {
      storageMin = Math.min(storageMin, getFanSpec(cx, cz, 'storage').sizeM);
      officeMax = Math.max(officeMax, getFanSpec(cx, cz, 'office').sizeM);
    }
    check('storage sweep always exceeds office sweep', storageMin > officeMax,
      'storageMin=' + storageMin + ' officeMax=' + officeMax);
  }

  // --- 2. determinism ----------------------------------------------------------
  {
    let mismatches = 0;
    for (const ctx of FAN_CONTEXTS) {
      for (let cx = -40; cx < 40; cx++) {
        for (let cz = -40; cz < 40; cz++) {
          const a = getFanSpec(cx, cz, ctx);
          const b = getFanSpec(cx, cz, ctx);
          if (a.bladeCount !== b.bladeCount || a.rotationDir !== b.rotationDir ||
              Math.abs(a.sizeM - b.sizeM) > 1e-12 || a.style !== b.style) mismatches++;
        }
      }
    }
    check('deterministic across repeated calls', mismatches === 0, 'mismatches=' + mismatches);
  }

  // --- 3. rotation variety (~half counterclockwise) ----------------------------
  {


