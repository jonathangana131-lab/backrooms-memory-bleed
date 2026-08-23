/**
 * Ambient fauna tests for BACKROOMS: MEMORY BLEED.
 *
 * Builds FaunaManager + Roach/DustDevil/Moth against a Babylon NullEngine
 * scene and verifies:
 *   1. chunk build spawns 2-4 roaches at floor level (y = 0.02)
 *   2. the global fauna budget (MAX_ACTIVE = 12) is never exceeded
 *   3. roaches scurry (move without the beam) and FREEZE under the torch beam
 *   4. roaches despawn beyond 25 m
 *   5. dust devils: ~5% of corridor chunks, never non-corridor chunks,
 *      lifetime ~20 s with grow-in/collapse scaling
 *   6. moths orbit their fixture on sin paths and leave when the light dies
 *   7. skitter audio fires only while a roach is actually running nearby,
 *      is very quiet, panned within [-1, 1], and silenced under the beam
 *
 * TypeScript sources are transpiled on the fly (same approach as
 * entity-behavior.mjs; src/world/constants.ts gets a JS shim because its
 * const enums don't survive isolated transpilation).
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.fauna-build');
const DT = 0.05;

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

function transpile(relSrc, outRel) {
  const srcTxt = readFileSync(join(ROOT, relSrc), 'utf8');
  let out = ts.transpileModule(srcTxt, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
    },
    isolatedModules: true,
  }).outputText;
  // Node ESM needs explicit extensions on relative and @babylonjs subpath imports.


