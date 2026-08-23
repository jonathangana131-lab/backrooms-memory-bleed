/**
 * Texture variety tests: carpet variants + per-chunk deterministic selection,
 * wall water-damage layers, per-tile ceiling grime, dynamic dirtying logic.
 *
 * Runs the real TS modules through vite's SSR loader - no browser needed.
 * Canvas painting itself needs a DOM, so createMaterials() is not invoked
 * here; instead we verify the pure selection/accumulation layer and audit
 * the painter source (which is fully seeded).
 *
 *   node test/texture-variety.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log('  ok - ' + name);
  } else {
    failures++;
    console.error('FAIL - ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const mats = await server.ssrLoadModule('/src/gfx/materials.ts');
  const { CARPET_VARIANT_COUNT, carpetVariantIndex, CARPET_UV_SCALE, DirtMap, DIRT_CELL, DIRT_MAX_LAYERS } = mats;

  // ---------- 1. carpet variant count ----------
  check('CARPET_VARIANT_COUNT is 3', CARPET_VARIANT_COUNT === 3, String(CARPET_VARIANT_COUNT));

  // ---------- 2. carpetVariantIndex determinism ----------
  let detOk = true;
  for (let i = 0; i < 200; i++) {
    const cx = Math.floor(Math.random() * 4001) - 2000;
    const cz = Math.floor(Math.random() * 4001) - 2000;
    if (carpetVariantIndex(cx, cz) !== carpetVariantIndex(cx, cz)) detOk = false;
  }
  check('carpetVariantIndex is deterministic', detOk);

  // ---------- 3. variant index range + spread ----------
  const counts = [0, 0, 0];
  let inRange = true;
  for (let cx = -50; cx <= 50; cx++) {
    for (let cz = -50; cz <= 50; cz++) {
      const v = carpetVariantIndex(cx, cz);
      if (!Number.isInteger(v) || v < 0 || v >= CARPET_VARIANT_COUNT) inRange = false;
      counts[v]++;
    }


