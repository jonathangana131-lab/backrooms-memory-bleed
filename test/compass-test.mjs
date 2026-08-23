/**
 * Unit tests for the pure math in src/ui/compass.ts.
 *
 * compass.ts is TypeScript with Babylon imports; we transpile it on the fly
 * with the repo's own typescript dependency, import it, and assert on the
 * framework-free helpers (edge clamping, fade, formatting, chevron angle).
 *
 * Run: node test/compass-test.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'ui', 'compass.ts');
const outPath = path.join(here, '.compass.transpiled.mjs');

const src = readFileSync(srcPath, 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
// Node ESM needs explicit extensions; add ".js" to bare package imports.
const nodeReady = js.replace(
  /(from\s+['"])(@babylonjs\/[^'"]+)(['"])/g,
  (_m, pre, spec, post) => pre + spec + '.js' + post,
);
writeFileSync(outPath, nodeReady);

let mod;
try {
  mod = await import('./.compass.transpiled.mjs');
} finally {
  unlinkSync(outPath);
}

let failed = 0;
let passed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log('  ok  ' + name);
  } else {
    failed++;
    console.error('FAIL  ' + name);
  }
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

const { edgeAnchor, fadeForDistance, formatDistance, chevronAngleDeg, EDGE_MARGIN } = mod;

console.log('edgeAnchor');
{
  const w = 1280, h = 720, m = EDGE_MARGIN;
  // Target far to the right of center: pinned to right edge minus margin.


