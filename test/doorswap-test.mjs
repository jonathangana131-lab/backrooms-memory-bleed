/**
 * Door/wall swap tests (F23).
 *
 * Proves the AC: the swap is atomic (a freeze-and-inspect probe observing
 * the grid at every application point sees both cells flipped or neither);
 * nav + collision + mesher-marker invariants hold on every observable state;
 * results are deterministic per (seed, coord pair); revertSwap restores
 * byte-identical prior cells; and invalid targets fail loud without any
 * mutation.
 *
 * Run: node test/doorswap-test.mjs  (transpiles TS in-memory like blackoutdeltas-test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-doorswap-'));
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
// architect is only reached via type-only imports elsewhere; doorswap itself
// needs nothing beyond rng.
emit('src/world/doorswap.ts', 'src/world/doorswap.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  wallCell, doorCell, openCell,
  swapDoorWall, revertSwap, assertSwapConsistent,
} = await import(path.join(tmp, 'src/world/doorswap.mjs'));

const SEED = 0x0cef23;

/**
 * Probe grid with full observation journaling. Every bulk write is recorded
 * with a frozen deep snapshot of ALL cells taken BEFORE the write applies -
 * so if the caller ever issued two separate single-cell writes, the second
 * snapshot would expose a half-swapped grid.
 */
class ProbeGrid {
  constructor() {
    this.cells = new Map();
    this.snapshots = []; // { writes, frozenState } frozen BEFORE applying
    this.writeCount = 0;
  }

  key(x, z) { return x + ',' + z; }

  getCell(x, z) {
    const c = this.cells.get(this.key(x, z));
    return c ? { ...c } : undefined;
  }

  putCells(writes) {
    const frozenState = JSON.stringify([...this.cells.entries()].map(([k, c]) => [k, { ...c }]));
    this.snapshots.push({
      coords: writes.map((w) => w.x + ',' + w.z),
      beforeWrite: frozenState,
    });
    this.writeCount++;
    for (const w of writes) this.cells.set(this.key(w.x, w.z), { ...w.cell });
  }
}

/** Fixture grid: a corridor of cells with a door flanked by solid walls. */
function makeGrid() {
  const g = new ProbeGrid();
  const put = (x, z, cell) => g.putCells([{ x, z, cell }]);
  for (let x = 0; x < 6; x++) put(x, 0, openCell());   // corridor floor
  put(3, 1, doorCell());                                // door in south wall
  put(2, 1, wallCell());
  put(4, 1, wallCell());                                // adjacent solid wall
  return g;
}

const DOOR = { x: 3, z: 1 };
const WALL = { x: 4, z: 1 };

function fullSnapshot(g) {
  return JSON.stringify([...g.cells.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// ---- AC: atomicity ------------------------------------------------------------

test('swap issues exactly ONE bulk write covering both cells', () => {
  const g = makeGrid();
  const writesBefore = g.writeCount;
  swapDoorWall(g, DOOR, WALL, SEED);
  assert.equal(g.writeCount - writesBefore, 1, 'swap must be a single putCells call');
  const snap = g.snapshots[g.snapshots.length - 1];
  assert.deepEqual(snap.coords.sort(), [DOOR.x + ',' + DOOR.z, WALL.x + ',' + WALL.z].sort());
});

test('freeze-and-inspect: every observed pre-write state is all-old or all-new, never half', () => {
  const g = makeGrid();
  swapDoorWall(g, DOOR, WALL, SEED);
  // The probe froze full-grid snapshots immediately before each write. With a
  // single two-cell write there are exactly two observations of interest:
  // the frozen pre-state (all-old) and the post-swap reads (all-new). Any
  // half-applied intermediate would appear as a snapshot whose door cell is
  // already 'wall' while the wall cell is not yet 'door' - prove none exists.
  const halfSwapped = g.snapshots.some((s) => {
    const state = new Map(JSON.parse(s.beforeWrite));
    const d = state.get(DOOR.x + ',' + DOOR.z);
    const w = state.get(WALL.x + ',' + WALL.z);
    if (!d || !w) return false; // fixture snapshots before both cells existed
    return (d.marker === 'wall') !== (w.marker === 'door');
  });
  assert.equal(halfSwapped, false, 'grid was observed half-swapped');
  assert.equal(g.getCell(DOOR.x, DOOR.z).marker, 'wall');
  assert.equal(g.getCell(WALL.x, WALL.z).marker, 'door');
});

test('post-swap state satisfies nav+collision+mesh invariants on both sides', () => {
  const g = makeGrid();
  const rec = swapDoorWall(g, DOOR, WALL, SEED);
  // assertSwapConsistent throws on any marker/nav/solid disagreement...
  assertSwapConsistent(g, rec);
  // ...and the raw cells agree independently:
  const d = g.getCell(DOOR.x, DOOR.z);
  const w = g.getCell(WALL.x, WALL.z);
  assert.equal(d.marker, 'wall');
  assert.equal(d.nav, false, 'new wall must block nav');
  assert.equal(d.solid, true, 'new wall must collide');
  assert.equal(w.marker, 'door');
  assert.equal(w.nav, true, 'new door must admit nav');
  assert.equal(w.solid, false, 'new door must be collision-free');
});

// ---- AC: determinism -----------------------------------------------------------

test('deterministic per (seed, coord pair): identical records across instances', () => {
  const a = makeGrid(), b = makeGrid();
  const ra = swapDoorWall(a, DOOR, WALL, SEED);
  const rb = swapDoorWall(b, DOOR, WALL, SEED);
  assert.deepEqual(ra, rb);
  assert.deepEqual(fullSnapshot(a), fullSnapshot(b));
  // A different coord pair is its own deterministic outcome:
  const c = makeGrid(), d = makeGrid();
  const rc1 = swapDoorWall(c, DOOR, { x: 2, z: 1 }, SEED);
  const rc2 = swapDoorWall(d, DOOR, { x: 2, z: 1 }, SEED);
  assert.deepEqual(rc1, rc2);
  // Seeded door variant is a stable integer in [0,4):
  assert.equal(typeof ra.doorVariant, 'number');
  assert.ok(ra.doorVariant >= 0 && ra.doorVariant < 4);
});

// ---- AC: byte-identical revert --------------------------------------------------

test('revertSwap restores byte-identical prior state', () => {
  const g = makeGrid();
  const before = fullSnapshot(g);
  const rec = swapDoorWall(g, DOOR, WALL, SEED);
  assert.notEqual(fullSnapshot(g), before, 'sanity: swap changed the grid');
  revertSwap(g, rec);
  assert.equal(fullSnapshot(g), before);
  // Revert is also atomic (single bulk write):
  assert.deepEqual(g.snapshots[g.snapshots.length - 1].coords.sort(),
    [DOOR.x + ',' + DOOR.z, WALL.x + ',' + WALL.z].sort());
});

test('swap -> revert -> identical re-swap replays identically', () => {
  const g = makeGrid();
  const r1 = swapDoorWall(g, DOOR, WALL, SEED);
  revertSwap(g, r1);
  const r2 = swapDoorWall(g, DOOR, WALL, SEED);
  assert.deepEqual(r1, r2);
});

// ---- validation fails loud, mutates nothing --------------------------------------

test('rejects non-door source / non-wall target / coincident coords, mutating nothing', () => {
  const cases = [
    { door: { x: 0, z: 0 }, wall: WALL, why: 'source is open floor, not a door' },
    { door: { x: 2, z: 1 }, wall: WALL, why: 'source is solid wall, not a door' },
    { door: { x: 99, z: 99 }, wall: WALL, why: 'source cell does not exist' },
    { door: DOOR, wall: { x: 0, z: 0 }, why: 'target is open floor, not wall' },
    { door: DOOR, wall: { x: 40, z: 40 }, why: 'target cell does not exist' },
    { door: DOOR, wall: DOOR, why: 'coincident coordinates' },
  ];
  for (const c of cases) {
    const g = makeGrid();
    const before = fullSnapshot(g);
    assert.throws(() => swapDoorWall(g, c.door, c.wall, SEED), Error, c.why);
    assert.equal(fullSnapshot(g), before, 'failed swap must not mutate: ' + c.why);
  }
});

test('marker vocabulary matches the mesher-facing contract', () => {
  assert.deepEqual(wallCell(), { marker: 'wall', nav: false, solid: true });
  assert.deepEqual(doorCell(), { marker: 'door', nav: true, solid: false });
  assert.deepEqual(openCell(), { marker: 'open', nav: true, solid: false });
});
