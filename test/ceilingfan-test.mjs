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

(Showing lines 1-40 of 177. Use offset=41 to continue.)

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

(Showing lines 1-80 of 177. Use offset=81 to continue.)

