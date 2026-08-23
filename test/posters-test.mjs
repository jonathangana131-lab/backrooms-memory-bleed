/**
 * Unit tests for wall posters (src/gfx/posters.ts).
 * Standalone (no browser, no Babylon): transpiles the modules into a temp
 * dir and drives placement with hand-built layouts and paintPoster with a
 * recording 2D-context stub.
 * Run: node test/posters-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-posters-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/gfx/posters.ts', 'gfx/posters.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx/posters.mjs')).href);
const {
  POSTER_TYPES, POSTER_STATES, POSTER_SALT,
  POSTER_OFFSET, POSTER_Y_MIN, POSTER_Y_MAX,
  posterAging, posterCanvasSize, getPostersForChunk, paintPoster,
} = mod;

// ---------------------------------------------------------------------------
// Poster type / state catalog
// ---------------------------------------------------------------------------
check('five poster types declared', POSTER_TYPES.length === 5 &&
  ['missing', 'event', 'safety', 'map', 'motivational'].every(t => POSTER_TYPES.includes(t)),
  JSON.stringify(POSTER_TYPES));
check('three aging states declared', POSTER_STATES.length === 3 &&
  ['fresh', 'faded', 'torn'].every(s => POSTER_STATES.includes(s)),
  JSON.stringify(POSTER_STATES));

// ---------------------------------------------------------------------------
// Aging profiles
// ---------------------------------------------------------------------------
{
  const fresh = posterAging('fresh');
  const faded = posterAging('faded');
  const torn = posterAging('torn');
  let ok = true;
  for (const [name, a] of [['fresh', fresh], ['faded', faded], ['torn', torn]]) {
    for (const k of ['alpha', 'tear', 'curl']) {
      if (!(a[k] >= 0 && a[k] <= 1)) ok = false;
    }
    void name;
  }
  check('aging profiles in [0,1] for all fields', ok);
  check('fresh is most opaque', fresh.alpha > faded.alpha && fresh.alpha > torn.alpha);
  check('faded is least opaque', faded.alpha < fresh.alpha && faded.alpha < torn.alpha);
  check('torn has the most tear damage', torn.tear > fresh.tear && torn.tear > faded.tear);
  // Deterministic pure function
  check('posterAging deterministic', JSON.stringify(posterAging('torn')) === JSON.stringify(torn));
}

// ---------------------------------------------------------------------------
// Placement: gating rate ~15% of chunks
// ---------------------------------------------------------------------------


