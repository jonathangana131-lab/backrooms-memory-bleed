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


