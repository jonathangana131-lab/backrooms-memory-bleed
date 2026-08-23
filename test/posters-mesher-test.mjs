/**
 * Unit tests for the poster emission layer (src/gfx/posters-mesher.ts).
 * Standalone (no browser/Babylon): transpiles the module (+ its runtime
 * deps) into a temp dir and drives the pure generate()/emit()/
 * renderPosterInto() API with a recording canvas stub.
 * Run: node test/posters-mesher-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-postersmesher-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  // rewrite relative imports to .mjs and drop Babylon runtime imports -
  // bakePoster needs a real Scene/GPU so it is not exercised headless.
  const fixed = js
    .replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'")
    .replace(/import\s*\{[^}]*\}\s*from\s*'@babylonjs[^']*';/g, '');
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/gfx/posters.ts', 'gfx/posters.mjs');
emit('src/gfx/posters-mesher.ts', 'gfx/posters-mesher.mjs');

const pmMod = await import(pathToFileURL(path.join(tmp, 'gfx/posters-mesher.mjs')).href);
const postersMod = await import(pathToFileURL(path.join(tmp, 'gfx/posters.mjs')).href);
const {
  PosterMesherPass,
  posterQuadSize,
  posterTintForState,
  posterTextureKey,
  posterSeedFor,
  renderPosterInto,
  POSTER_QUAD_WIDTH,
  POSTER_QUAD_OFFSET,
  POSTER_MIN_Y,
  ALL_POSTER_TEXTURE_KEYS,
} = pmMod;
const { getPostersForChunk, posterAging, posterCanvasSize, POSTER_TYPES, POSTER_STATES } = postersMod;

function close(a, b, eps = 1e-6) {


