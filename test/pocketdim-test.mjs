/**
 * Pocket-dimension tests (F15).
 *
 * Proves the AC: byte-identical interior regeneration for the same
 * (worldSeed, doorKey) across two independent generations; different keys
 * never collide to the same interior; exterior footprint metadata stays
 * fixed and separate from interior size; and every random draw derives from
 * src/core/rng.ts (static audit, Math.random forbidden here - it is not an
 * audio DSP fill).
 *
 * Run: node test/pocketdim-test.mjs  (transpiles TS in-memory like anomalies-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-pocketdim-'));
fsMod.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fsMod.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}

emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/pocketdim.ts', 'src/world/pocketdim.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  generatePocketInterior, pocketFootprint, parseDoorKey,
  pocketArea, MIN_INTERIOR_WIDTH, MIN_INTERIOR_DEPTH,
  FOOTPRINT_CELLS_WIDE, FOOTPRINT_CELLS_DEEP,
} = await import(path.join(tmp, 'src/world/pocketdim.mjs'));

// ---- fixtures ---------------------------------------------------------------

const SEED = 0xbadc0de;
/** A spread of door keys across faces and negative coordinates. */
function sampleKeys(n) {
  const keys = [];
  for (let i = 0; i < n; i++) {
    const x = (i * 37) % 200 - 100;
    const z = (i * 91 + 13) % 300 - 150;
    const face = ['n', 's', 'e', 'w'][i % 4];
    keys.push(`${x},${z}:${face}`);
  }
  return keys;
}
const serialize = (interior) => JSON.stringify(interior);

// ---- AC (a): byte-identical regen ------------------------------------------

test('AC-a: same key+seed regenerates BYTE-IDENTICAL interiors across two instances', () => {
  for (const key of sampleKeys(25)) {
    const a = generatePocketInterior(SEED, key);
    const b = generatePocketInterior(SEED, key);
    assert.equal(serialize(a), serialize(b), `regen mismatch for ${key}`);
    // Deep mutation of the first copy must not poison regeneration.
    a.props.length = 0;
    a.cells[0].kind = 'floor';
    const c = generatePocketInterior(SEED, key);
    assert.equal(serialize(c), serialize(b), `mutation leaked into regen for ${key}`);
  }
});

test('AC-a: identical across different world seeds only when seed matches', () => {
  const k = '12,7:n';
  assert.equal(
    serialize(generatePocketInterior(SEED, k)),
    serialize(generatePocketInterior(SEED, k)),
  );
  // A different seed may differ; when it does, it must still regenerate stably.
  const other = generatePocketInterior(0x5eed ^ 1, k);
  assert.equal(
    serialize(other),
    serialize(generatePocketInterior(0x5eed ^ 1, k)),
  );
});

// ---- AC (b): no cross-key collisions ----------------------------------------

test('AC-b: different keys never collide to the same interior', () => {
  const seen = new Map();
  const keys = sampleKeys(400);
  for (const key of keys) {
    const s = serialize(generatePocketInterior(SEED, key));
    assert.ok(!seen.has(s), `interior collision between ${seen.get(s)} and ${key}`);
    seen.set(s, key);
  }
});

test('AC-b: same key under many seeds yields distinct streams per seed pair check', () => {
  // One key across 50 seeds: each (seed) layout must at least be stable, and
  // distinct seeds must not collapse onto one shared layout.
  const layouts = new Set();
  for (let s = 1; s <= 50; s++) {
    layouts.add(serialize(generatePocketInterior(s * 7919, '42,-9:e')));
  }
  assert.ok(layouts.size > 40, `seed variety collapsed: ${layouts.size}/50 distinct`);
});

// ---- AC (c): footprint metadata stays exterior-facing -----------------------

test('AC-c: footprint is fixed-size and reported separately from interior size', () => {
  for (const key of sampleKeys(60)) {
    const fp = pocketFootprint(key);
    assert.deepEqual(fp, {
      doorX: parseDoorKey(key).x,
      doorZ: parseDoorKey(key).z,
      face: parseDoorKey(key).face,
      cellsWide: FOOTPRINT_CELLS_WIDE,
      cellsDeep: FOOTPRINT_CELLS_DEEP,
    });
    assert.equal(fp.cellsWide, 3);
    assert.equal(fp.cellsDeep, 1);
    const interior = generatePocketInterior(SEED, key);
    // Interior dwarfs its frontage and never feeds back into the footprint.
    assert.ok(interior.width >= MIN_INTERIOR_WIDTH, `${key} width ${interior.width}`);
    assert.ok(interior.depth >= MIN_INTERIOR_DEPTH, `${key} depth ${interior.depth}`);
    assert.ok(
      interior.width * interior.depth > fp.cellsWide * fp.cellsDeep * 10,
      `${key} interior not decisively larger`,
    );
    const after = pocketFootprint(key);
    assert.deepEqual(after, fp, 'footprint changed after interior generation');
  }
});

test('AC-c: pocket floor area strictly exceeds exterior frontage area', () => {
  for (const key of sampleKeys(30)) {
    const interior = generatePocketInterior(SEED, key);
    const area = pocketArea(interior);
    assert.ok(area > FOOTPRINT_CELLS_WIDE * FOOTPRINT_CELLS_DEEP * 20, `${key} area ${area}`);
  }
});

// ---- AC (d): all randomness from rng.ts --------------------------------------

test('AC-d: module draws randomness only through src/core/rng.ts helpers', () => {
  const src = fsMod.readFileSync(path.join(ROOT, 'src/world/pocketdim.ts'), 'utf8');
  assert.ok(!src.includes('Math.random'), 'Math.random is forbidden outside audio DSP fills');
  assert.ok(/from '\.\.\/core\/rng'/.test(src), 'must import randomness helpers from core/rng');
  // Layout must actually vary with the hashed stream, i.e. rng is load-bearing.
  const dims = new Set(sampleKeys(80).map((k) => {
    const p = generatePocketInterior(SEED, k);
    return p.width + 'x' + p.depth;
  }));
  assert.ok(dims.size > 6, `layout dims suspiciously uniform: ${[...dims].join(',')}`);
});

// ---- structural sanity -------------------------------------------------------

test('malformed door keys fail loud', () => {
  for (const bad of ['', '12,7', '12,7:x', 'a,b:n', '12,7:north']) {
    assert.throws(() => parseDoorKey(bad), `expected throw for '${bad}'`);
  }
});

test('interior structure: bordered grid, reachable exit, props/lights on floors', () => {
  const p = generatePocketInterior(SEED, '12,7:n');
  const floorAt = (x, z) =>
    p.cells.some((c) => c.x === x && c.z === z && c.kind === 'floor');
  // Entry wall face n: row 0 has at least one floor cell.
  let entryFloors = 0;
  for (let x = 0; x < p.width; x++) if (floorAt(x, 0)) entryFloors++;
  assert.ok(entryFloors >= 1, 'no entry cell on north border');
  // Exit is walkable and not on the outer border.
  const ex = p.exit;
  assert.ok(floorAt(ex.x, ex.z), 'exit cell not walkable');
  assert.ok(ex.x > 0 && ex.x < p.width - 1 && ex.z > 0 && ex.z < p.depth - 1, 'exit on border');
  for (const prop of p.props) {
    assert.ok(floorAt(Math.floor(prop.x), Math.floor(prop.z)), 'prop off-floor');
  }
  for (const light of p.lights) {
    assert.ok(light.alive === true && light.flicker >= 0 && light.flicker <= 1);
  }
  console.log(`ok  sample pocket 12,7:n -> ${p.width}x${p.depth}, ` +
    `${pocketArea(p)} floor cells, ${p.props.length} props, ${p.lights.length} lights`);
});
