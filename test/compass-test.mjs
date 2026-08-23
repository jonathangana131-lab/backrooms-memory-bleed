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


  const r = edgeAnchor(w / 2 + 5000, h / 2, w, h, m);
  check('clamps to right edge', approx(r.x, w - m));
  check('keeps vertical center', approx(r.y, h / 2));

  // Target above center: pinned to top edge minus margin.
  const t = edgeAnchor(w / 2, h / 2 - 9000, w, h, m);
  check('clamps to top edge', approx(t.y, m));

  // Diagonal target hits the corner region, inside both insets.
  const c = edgeAnchor(w / 2 + 3000, h / 2 - 3000, w, h, m);
  check('diagonal stays within x inset', c.x <= w - m + 1e-6 && c.x >= m - 1e-6);
  check('diagonal stays within y inset', c.y <= h - m + 1e-6 && c.y >= m - 1e-6);
  // Direction preserved along the ray from center.
  check('diagonal direction preserved', approx(c.x - w / 2, -(c.y - h / 2), 1e-4));

  // Degenerate zero vector returns a valid in-bounds point.
  const d0 = edgeAnchor(w / 2, h / 2, w, h, m);
  check('degenerate stays in bounds', d0.x >= m && d0.x <= w - m && d0.y >= m && d0.y <= h - m);
}

console.log('fadeForDistance');
{
  check('fully visible at 50m', fadeForDistance(50) === 1);
  check('fully visible at FADE_START_M', fadeForDistance(18) === 1);
  check('half faded at midpoint (15m)', approx(fadeForDistance(15), 0.5));
  check('gone at 12m', fadeForDistance(12) === 0);
  check('gone below 12m', fadeForDistance(3) === 0);
  check('no-target distance stays visible', fadeForDistance(Infinity) === 1);
}

console.log('formatDistance');
{
  check('rounds meters', formatDistance(142.3) === '142m');
  check('rounds down at .49', formatDistance(10.49) === '10m');
  check('unknown distance placeholder', formatDistance(Infinity) === '?m');
  check('huge distance capped', formatDistance(25000) === '>10km');
}

console.log('chevronAngleDeg');
{
  check('right is 90deg', approx(chevronAngleDeg(1, 0), 90));
  check('down is 180deg', approx(chevronAngleDeg(0, 1), 180));
  check('left is -90deg', approx(chevronAngleDeg(-1, 0), -90));
  check('up is 0deg', approx(chevronAngleDeg(0, -1), 0));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);


