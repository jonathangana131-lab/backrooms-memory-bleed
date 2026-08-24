/**
 * Mezzanine tests (F51 - The Mezzanine That Wasn't).
 *
 * Proves the AC: two independent generations of the same (worldSeed,
 * chunkKey) are byte-identical interiors and mutation of one copy never
 * poisons regeneration; every generated base→balcony→exit stair path is
 * connected across 100 seeds; the glimpse footprint stays fixed regardless
 * of interior layout or seed; serialization round-trips; determinism holds;
 * and every random draw derives from src/core/rng.ts (static audit,
 * Math.random forbidden).
 *
 * Run: node test/mezzanine-test.mjs  (transpiles TS in-memory like pocketdim-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-mezzanine-'));
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
emit('src/world/mezzanine.ts', 'src/world/mezzanine.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  generateMezzanine, mezzanineGate, glimpseFootprint, parseChunkKey,
  stairPathExists, mezzanineWalkableArea,
  MEZZ_RARITY_ONE_IN, MIN_MEZZ_WIDTH, MIN_MEZZ_DEPTH,
  GLIMPSE_CELLS_WIDE, GLIMPSE_CELLS_DEEP,
} = await import(path.join(tmp, 'src/world/mezzanine.mjs'));

// ---- fixtures ---------------------------------------------------------------

/** A spread of chunk keys across signs and magnitudes. */
function sampleChunkKeys(n) {
  const keys = [];
  for (let i = 0; i < n; i++) {
    const cx = (i * 29) % 120 - 60;
    const cz = (i * 53 + 7) % 160 - 80;
    keys.push(`${cx},${cz}`);
  }
  return keys;
}
const serialize = (pair) => JSON.stringify(pair);

// ---- AC (a): byte-identical regen incl. mutation poisoning ------------------

test('AC-a: same seed+chunk regenerates BYTE-IDENTICAL pairs across two instances', () => {
  let gated = 0;
  for (const key of sampleChunkKeys(200)) {
    const a = generateMezzanine(0xbadc0de, key);
    if (!a) continue;
    gated++;
    const b = generateMezzanine(0xbadc0de, key);
    assert.equal(serialize(a), serialize(b), `regen mismatch for ${key}`);
    // Deep mutation of the first copy must not poison regeneration.
    a.interior.props.length = 0;
    a.interior.cells[0].kind = 'floor';
    a.interior.entry.x = -999;
    a.staircase.steps.length = 0;
    const c = generateMezzanine(0xbadc0de, key);
    assert.equal(serialize(c), serialize(b), `mutation leaked into regen for ${key}`);
  }
  console.log(`ok  AC-a sweep: ${gated}/200 chunks gated at seed 0xbadc0de`);
});

test('AC-a: gate closed means null, open means a full pair - always', () => {
  for (const key of sampleChunkKeys(300)) {
    const g = mezzanineGate(424242, key);
    const pair = generateMezzanine(424242, key);
    if (g) {
      assert.ok(pair, `gate open but no pair for ${key}`);
      assert.ok(pair.staircase && pair.interior, `partial pair for ${key}`);
    } else {
      assert.equal(pair, null, `gate closed but pair spawned for ${key}`);
    }
  }
});

// ---- AC (b): stair connectivity base→balcony→exit across 100 seeds ----------

test('AC-b: every generated pair connects base→balcony→exit across 100 seeds', () => {
  const keys = sampleChunkKeys(30);
  let pairs = 0;
  for (let s = 1; s <= 100; s++) {
    const seed = s * 7919;
    for (const key of keys) {
      const p = generateMezzanine(seed, key);
      if (!p) continue;
      pairs++;
      assert.ok(stairPathExists(p.staircase, p.interior),
        `stair path broken for ${key}@${seed}`);
      // Landing/entry agreement and exit walkability are part of the contract.
      assert.deepEqual(p.staircase.landing, p.interior.entry, `landing mismatch ${key}@${seed}`);
      const exitCell = p.interior.cells.find(
        (c) => c.x === p.interior.exit.x && c.z === p.interior.exit.z);
      assert.ok(exitCell && exitCell.kind !== 'wall', `exit not walkable ${key}@${seed}`);
    }
  }
  console.log(`ok  AC-b connectivity verified on ${pairs} generated pairs over 100 seeds`);
  assert.ok(pairs > 50, `too few gated pairs to trust connectivity claim: ${pairs}`);
});

test('AC-b: rarity rate nears 1-in-25 over a large uniform sweep', () => {
  const N = 2500;
  let hits = 0;
  for (let i = 0; i < N; i++) {
    if (mezzanineGate(i * 2654435761 >>> 0 || 1, `${i % 97},${(i * 31) % 89}`)) hits++;
  }
  const expected = N / MEZZ_RARITY_ONE_IN;
  assert.ok(hits > expected * 0.5 && hits < expected * 1.5,
    `rarity off: ${hits} hits vs ~${expected} expected`);
  console.log(`ok  rarity: ${hits}/${N} gated (~${(N / hits).toFixed(1)} chunks per staircase)`);
});

// ---- AC (c): footprint invariance --------------------------------------------

test('AC-c: glimpse footprint fixed regardless of seed and interior', () => {
  for (const key of sampleChunkKeys(40)) {
    const fp = glimpseFootprint(key);
    assert.deepEqual(fp, {
      glimpseX: fp.glimpseX,
      glimpseZ: fp.glimpseZ,
      cellsWide: GLIMPSE_CELLS_WIDE,
      cellsDeep: GLIMPSE_CELLS_DEEP,
    });
    assert.equal(fp.cellsWide, 4);
    assert.equal(fp.cellsDeep, 4);
    // Identical across seeds.
    for (const s of [1, 7, 999331, 0xf00d]) {
      const again = glimpseFootprint(key);
      assert.deepEqual(again, fp, `footprint moved across seeds for ${key} @${s}`);
    }
    // Unchanged by interior generation.
    const before = serialize({ ...fp });
    generateMezzanine(12345, key);
    assert.equal(glimpseFootprint(key) && JSON.stringify(glimpseFootprint(key)), before,
      `footprint changed after interior generation for ${key}`);
    // And any spawned staircase reports exactly that footprint.
    const p = generateMezzanine(12345, key);
    if (p) assert.deepEqual(p.staircase.footprint, fp, `staircase footprint drift ${key}`);
    // Interior decisively larger than its glimpsed frontage, never fed back.
    if (p) {
      assert.ok(p.interior.width >= MIN_MEZZ_WIDTH && p.interior.depth >= MIN_MEZZ_DEPTH);
      assert.ok(p.interior.width * p.interior.depth > fp.cellsWide * fp.cellsDeep * 2,
        `${key} interior not decisively larger than glimpse`);
    }
  }
});

// ---- AC (d): determinism ------------------------------------------------------

test('AC-d: identical inputs replay identical layouts, distinct seeds diverge', () => {
  for (const key of ['12,7', '-33,18', '0,0']) {
    assert.equal(
      serialize(generateMezzanine(987654321, key)),
      serialize(generateMezzanine(987654321, key)),
    );
  }
  const layouts = new Set();
  for (let s = 1; s <= 60; s++) {
    const p = generateMezzanine(s * 104729, '9,-4');
    if (p) layouts.add(serialize(p));
  }
  const total = [];
  for (let s = 1; s <= 60; s++) total.push(generateMezzanine(s * 104729, '9,-4'));
  const gatedTotal = total.filter(Boolean).length;
  assert.ok(layouts.size > gatedTotal * 0.8,
    `seed variety collapsed: ${layouts.size}/${gatedTotal} distinct`);
});

// ---- AC (e): serialize round-trip ---------------------------------------------

test('AC-e: JSON round-trip preserves the pair and re-serializes byte-identical', () => {
  for (const key of sampleChunkKeys(60)) {
    const p = generateMezzanine(0xfeedface, key);
    if (!p) continue;
    const clone = JSON.parse(JSON.stringify(p));
    assert.deepEqual(clone, p, `round-trip deep-equal failed for ${key}`);
    assert.equal(serialize(clone), serialize(p), `re-serialization differs for ${key}`);
  }
});

// ---- AC (f): all randomness from rng.ts ----------------------------------------

test('AC-f: module draws randomness only through src/core/rng.ts helpers', () => {
  const src = fsMod.readFileSync(path.join(ROOT, 'src/world/mezzanine.ts'), 'utf8');
  assert.ok(!src.includes('Math.random'), 'Math.random is forbidden outside audio DSP fills');
  assert.ok(/from '\.\.\/core\/rng'/.test(src), 'must import randomness helpers from core/rng');
  // Layout must actually vary with the hashed stream, i.e. rng is load-bearing.
  const dims = new Set(sampleChunkKeys(400).map((k) => {
    const p = generateMezzanine(777, k);
    return p ? p.interior.width + 'x' + p.interior.depth : '';
  }));
  dims.delete('');
  assert.ok(dims.size > 4, `layout dims suspiciously uniform: ${[...dims].join(',')}`);
});

// ---- structural sanity ---------------------------------------------------------

test('malformed chunk keys fail loud', () => {
  for (const bad of ['', '12', '12,7,3', 'a,b', '12;7', '1.5,2']) {
    assert.throws(() => parseChunkKey(bad), `expected throw for '${bad}'`);
    assert.throws(() => mezzanineGate(1, bad), `gate must throw for '${bad}'`);
  }
});

test('interior structure: continuous balcony ring, core floors, props/lights legal', () => {
  const key = sampleChunkKeys(500).find((k) => mezzanineGate(31337, k));
  assert.ok(key, 'no gated chunk found in fixture sweep');
  const p = generateMezzanine(31337, key);
  assert.ok(p);
  const m = p.interior;
  const kindAt = (x, z) => m.cells.find((c) => c.x === x && c.z === z)?.kind;
  // Balcony ring: every border cell walkable balcony.
  for (let x = 0; x < m.width; x++) {
    assert.equal(kindAt(x, 0), 'balcony', `ring gap at ${x},0`);
    assert.equal(kindAt(x, m.depth - 1), 'balcony', `ring gap at ${x},${m.depth - 1}`);
  }
  for (let z = 0; z < m.depth; z++) {
    assert.equal(kindAt(0, z), 'balcony', `ring gap at 0,${z}`);
    assert.equal(kindAt(m.width - 1, z), 'balcony', `ring gap at ${m.width - 1},${z}`);
  }
  // Entry on ring, exit in the core.
  assert.equal(m.entry.z === 0 || m.entry.z === m.depth - 1 ||
    m.entry.x === 0 || m.entry.x === m.width - 1, true, 'entry not on balcony ring');
  assert.ok(m.exit.x > 0 && m.exit.x < m.width - 1 && m.exit.z > 0 && m.exit.z < m.depth - 1,
    'exit not in the core');
  for (const prop of m.props) {
    assert.equal(kindAt(Math.floor(prop.x), Math.floor(prop.z)), 'floor', 'prop off core floor');
  }
  for (const light of m.lights) {
    assert.ok(light.alive === true && light.flicker >= 0 && light.flicker <= 1);
  }
  assert.ok(mezzanineWalkableArea(m) > GLIMPSE_CELLS_WIDE * GLIMPSE_CELLS_DEEP);
  console.log(`ok  sample mezzanine ${key}@31337 -> ${m.width}x${m.depth}, ` +
    `${mezzanineWalkableArea(m)} walkable cells, ${m.props.length} props, ` +
    `${m.lights.length} lights, stairs face '${p.staircase.face}' with ` +
    `${p.staircase.steps.length} risers`);
});
