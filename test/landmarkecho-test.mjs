/**
 * Landmark echoes tests (src/world/landmarkecho.ts, F59).
 * Standalone (no browser): transpiles rng.ts + constants.ts + landmarkecho.ts
 * into a temp dir and drives the model directly, same idiom as
 * crawlspaces-test.
 *
 * Acceptance:
 *   1. spacing invariant - every echo sits at exactly +/-7 chunks on BOTH
 *      axes from the base, across placements and seeds; world coords are
 *      chunkX/Z * CHUNK_SIZE
 *   2. byte-for-byte descriptor reuse - each echo carries the SAME
 *      descriptor object (reference-equal) and deep-equals the base
 *   3. occupancy gating - candidates failing the injected check are skipped,
 *      an all-open world yields exactly 4 echoes (the +/-7/+/-7 corners)
 *   4. deterministic skip + order - same seed replays identical output;
 *      different seeds vary visit order while never violating spacing
 *   5. fail-loud validation - missing canHost, non-integer bases, bad
 *      descriptors throw
 *
 * Run: node test/landmarkecho-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-landmarkecho-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/constants.ts', 'src/world/constants.mjs');
emit('src/world/landmarkecho.ts', 'src/world/landmarkecho.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const le = await import(pathToFileURL(path.join(tmp, 'src/world/landmarkecho.mjs')).href);
const { CHUNK_SIZE } = await import(pathToFileURL(path.join(tmp, 'src/world/constants.mjs')).href);

const SEED = 909527;
const S = le.ECHO_SPACING_CHUNKS;

// ---- fixtures ---------------------------------------------------------------
function makeDescriptor(id) {
  return {
    id,
    name: 'The Chapel of Static',
    props: ['pew', 'candle-stub', 'cracked-font'],
    lights: [
      { kind: 'fluoro', x: 1.5, y: 2.9, z: 3.0 },
      { kind: 'bare-bulb', x: -2, y: 2.6, z: 0 },
    ],
  };
}
const OPEN_WORLD = { canHost: () => true };
function placement(baseChunkX, baseChunkZ, id = 'chapel') {
  return { descriptor: makeDescriptor(id), baseChunkX, baseChunkZ };
}

// ---- 1. spacing invariant -----------------------------------------------------
{
  const bases = [[0, 0], [13, -9], [-41, 27], [100, 100]];
  let totalEchoes = 0;
  let spaced = true;
  let worlds = true;
  const seeds = [SEED, 5, 777771];
  for (const [bx, bz] of bases) {
    for (const seed of seeds) {
      const p = placement(bx, bz);
      const echoes = le.echoPositions(p, OPEN_WORLD, seed);
      totalEchoes += echoes.length;
      for (const e of echoes) {
        if (!le.isEchoSpaced(bx, bz, e.chunkX, e.chunkZ)) spaced = false;
        if (e.worldX !== e.chunkX * CHUNK_SIZE || e.worldZ !== e.chunkZ * CHUNK_SIZE) worlds = false;
        if ((e.chunkX - bx) % S !== 0 || Math.abs(e.chunkX - bx) !== S) spaced = false;
        if ((e.chunkZ - bz) % S !== 0 || Math.abs(e.chunkZ - bz) !== S) spaced = false;
      }
    }
  }
  check(`every echo at exactly +/-${S} chunks per axis`, spaced);
  check('echo count == 4 per fully-open placement (' + totalEchoes / (bases.length * seeds.length) + ')',
    totalEchoes === bases.length * seeds.length * 4);
  check('world coords derive as chunk * CHUNK_SIZE', worlds);

  // Negative-direction echoes too: base far enough that all four signs differ.
  const p = placement(-50, -50);
  const xs = new Set(le.echoPositions(p, OPEN_WORLD, SEED).map((e) => e.chunkX));
  check('both +/- directions appear on x', xs.has(-50 - S) && xs.has(-50 + S));
}

// ---- 2. byte-for-byte descriptor reuse ------------------------------------------
{
  const p = placement(3, 4);
  const echoes = le.echoPositions(p, OPEN_WORLD, SEED);
  check('every echo carries the SAME descriptor reference',
    echoes.every((e) => e.descriptor === p.descriptor));
  check('descriptor deep-equals the base definition',
    echoes.every((e) => {
      try { assert.deepEqual(e.descriptor, makeDescriptor('chapel')); return true; }
      catch { return false; }
    }));
  check('name/props/lights survive untouched',
    echoes[0].descriptor.name === 'The Chapel of Static' &&
    echoes[0].descriptor.props.length === 3 &&
    echoes[0].descriptor.lights.length === 2);
}

// ---- 3. occupancy gating ---------------------------------------------------------
{
  // Block everything: no echoes.
  check('fully occupied world yields zero echoes',
    le.echoPositions(placement(0, 0), { canHost: () => false }, SEED).length === 0);
  // Block exactly one corner deterministically: the far (+7, +7) chunk.
  const blocked = {
    canHost: (x, z) => !(x === S && z === S),
  };
  const echoes = le.echoPositions(placement(0, 0), blocked, SEED);
  check('blocked corner skipped, others kept',
    echoes.length === 3 && echoes.every((e) => !(e.chunkX === S && e.chunkZ === S)),
    JSON.stringify(echoes.map((e) => [e.chunkX, e.chunkZ])));
}

// ---- 4. deterministic skip + order -------------------------------------------------
{
  const p = placement(7, -3);
  const a = JSON.stringify(le.echoPositions(p, OPEN_WORLD, SEED).map((e) => [e.chunkX, e.chunkZ]));
  const b = JSON.stringify(le.echoPositions(p, OPEN_WORLD, SEED).map((e) => [e.chunkX, e.chunkZ]));
  check('same seed replays identical order + set', a === b);

  // Different seeds may reorder but must keep the same accepted set in an
  // open world and never break spacing.
  const orders = new Set();
  let spacingHeld = true;
  for (let s = 0; s < 12; s++) {
    const es = le.echoPositions(p, OPEN_WORLD, 1000 + s);
    orders.add(JSON.stringify(es.map((e) => [e.chunkX, e.chunkZ])));
    for (const e of es) if (!le.isEchoSpaced(p.baseChunkX, p.baseChunkZ, e.chunkX, e.chunkZ)) spacingHeld = false;
  }
  check('spacing held across every seed tried', spacingHeld);
  check('seed changes the visit order somewhere (' + orders.size + ' distinct orders)', orders.size > 1);

  // Deterministic skip under a seeded occupancy gate: same seed -> same set.
  const flaky = {
    canHost: (x, z) => (Math.abs(x * 31 + z * 17) % 10) < 7,
  };
  const r1 = JSON.stringify(le.echoPositions(p, flaky, SEED));
  const r2 = JSON.stringify(le.echoPositions(p, flaky, SEED));
  check('occupancy-conflict skips are deterministic per seed', r1 === r2);
}

// ---- 5. fail-loud validation --------------------------------------------------------
{
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  check('missing canHost throws',
    threw(() => le.echoPositions(placement(0, 0), null, SEED)));
  check('non-function canHost throws',
    threw(() => le.echoPositions(placement(0, 0), { canHost: 'yes' }, SEED)));
  check('non-integer base x throws',
    threw(() => le.echoPositions(placement(1.5, 0), OPEN_WORLD, SEED)));
  check('non-integer base z throws',
    threw(() => le.echoPositions(placement(0, NaN), OPEN_WORLD, SEED)));
  check('missing descriptor throws',
    threw(() => le.echoPositions({ baseChunkX: 0, baseChunkZ: 0 }, OPEN_WORLD, SEED)));
  check('isEchoSpaced rejects near misses',
    !le.isEchoSpaced(0, 0, S, 0) && !le.isEchoSpaced(0, 0, S + 1, S) && !le.isEchoSpaced(0, 0, 14, 14));
}

console.log(failures === 0 ? 'LANDMARKECHO_PASS' : `LANDMARKECHO_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
