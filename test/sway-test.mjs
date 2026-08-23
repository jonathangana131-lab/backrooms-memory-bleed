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

function makeLight(x = 0, y = 2.7, z = 0) {
  return { position: { x, y, z }, range: 13.5 };
}

/** Count direction reversals of a rotation series (velocity sign flips). */
function countReversals(rots) {
  let n = 0;
  for (let i = 2; i < rots.length; i++) {
    const v1 = rots[i - 1] - rots[i - 2];


