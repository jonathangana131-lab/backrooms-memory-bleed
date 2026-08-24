/**
 * Crawlspaces tests (src/world/crawlspaces.ts, F58).
 * Standalone (no browser): transpiles rng.ts + constants.ts + crawlspaces.ts
 * into a temp dir and drives the model directly, same idiom as
 * mapfragments-test.
 *
 * Acceptance:
 *   1. gap rate + placement - gaps land only on injected floor cells,
 *      roughly one per six chunks across seeds
 *   2. nav flags - every gap cell reports {crawlable:true, fallSafe:true};
 *      non-gap cells report null (injected grid untouched)
 *   3. fall safety - 500 simulated entries all land at the shallow
 *      CRAWL_Y_OFFSET layer with fallSafe true and zero lethal outcomes
 *   4. closed pockets - flood fill from any pocket cell over under-floor
 *      walkability never escapes the footprint (wall ring seals it)
 *   5. climb-out - allowed exactly at the gap rim column
 *   6. determinism per seed - same (grid, seed) replays identical gaps;
 *      different seeds decorrelate
 *   7. serialize round-trip - deserialize(serialize(m)) answers identically;
 *      malformed saves throw
 *
 * Run: node test/crawlspaces-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-crawlspaces-'));
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
emit('src/world/crawlspaces.ts', 'src/world/crawlspaces.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const cs = await import(pathToFileURL(path.join(tmp, 'src/world/crawlspaces.mjs')).href);
const { CHUNK_CELLS } = await import(pathToFileURL(path.join(tmp, 'src/world/constants.mjs')).href);

const SEED = 909527;

// ---- fixtures ---------------------------------------------------------------
// Dense floor grid: every cell walkable.
function denseGrid(chunksX, chunksZ) {
  return {
    chunksX, chunksZ,
    isFloor: () => true,
  };
}
// Sparse grid with holes on a checker pattern of every 3rd row.
function holedGrid(chunksX, chunksZ) {
  return {
    chunksX, chunksZ,
    isFloor: (x, z) => ((z % 3) !== 0) || ((x % 2) === 0),
  };
}

// ---- 1. gap rate + placement -------------------------------------------------
{
  let totalGaps = 0;
  const CH = 40; // 1600 chunks per seed -> ~267 expected gaps
  for (const seed of [11, 22, SEED]) {
    const m = new cs.CrawlspaceModel(denseGrid(CH, CH), seed);
    const gaps = m.gaps();
    totalGaps += gaps.length;
    check(`seed ${seed}: every gap is inside the streamed extent`,
      gaps.every((g) =>
        g.cellX >= 0 && g.cellX < CH * CHUNK_CELLS &&
        g.cellZ >= 0 && g.cellZ < CH * CHUNK_CELLS),
      JSON.stringify(gaps.find((g) =>
        g.cellX < 0 || g.cellZ < 0 || g.cellX >= CH * CHUNK_CELLS || g.cellZ >= CH * CHUNK_CELLS)));
  }
  const nChunks = 3 * CH * CH;
  const rate = totalGaps / nChunks;
  check(`gap rate ~1/6 (got ${rate.toFixed(3)})`, rate > 1 / 6 - 0.05 && rate < 1 / 6 + 0.05);
}
{
  // Gaps land only where the injected grid says floor.
  const CH = 24;
  const grid = holedGrid(CH, CH);
  const m = new cs.CrawlspaceModel(grid, SEED);
  check('all gaps sit on injected floor cells',
    m.gaps().every((g) => grid.isFloor(g.cellX, g.cellZ)),
    JSON.stringify(m.gaps().filter((g) => !grid.isFloor(g.cellX, g.cellZ))));
}

// ---- 2. nav flags -------------------------------------------------------------
{
  const CH = 16;
  const m = new cs.CrawlspaceModel(denseGrid(CH, CH), SEED);
  const g0 = m.gaps()[0];
  const f = m.flagsAt(g0.cellX, g0.cellZ);
  check('gap cell nav flags are crawlable+fallSafe',
    !!f && f.crawlable === true && f.fallSafe === true, JSON.stringify(f));
  check('flagsAt agrees with isGap everywhere sampled', (() => {
    for (let z = 0; z < CH * CHUNK_CELLS; z += 7) {
      for (let x = 0; x < CH * CHUNK_CELLS; x += 7) {
        if (m.isGap(x, z) !== (m.flagsAt(x, z) !== null)) return false;
      }
    }
    return true;
  })());
  // Non-gap cells unchanged: null, i.e. the injected grid stays authoritative.
  const nonGap = { cellX: g0.cellX + 3, cellZ: g0.cellZ + 4 };
  check('non-gap cells report null flags (unchanged)',
    m.flagsAt(nonGap.cellX, nonGap.cellZ) === null && !m.isGap(nonGap.cellX, nonGap.cellZ));
}

// ---- 3. fall safety: 500 simulated entries ------------------------------------
{
  const CH = 30;
  const m = new cs.CrawlspaceModel(denseGrid(CH, CH), SEED);
  const gaps = m.gaps();
  let lethal = 0;
  let wrongDepth = 0;
  let unsafe = 0;
  const N = 500;
  for (let i = 0; i < N; i++) {
    const g = gaps[i % gaps.length];
    const entryY = m.enterY(100); // surface floor at y=100
    if (entryY !== 100 + cs.CRAWL_Y_OFFSET || Math.abs(entryY - (100 - 1.2)) > 1e-9) wrongDepth++;
    const f = m.flagsAt(g.cellX, g.cellZ);
    if (!f || !f.fallSafe || !f.crawlable) unsafe++;
    // A safe entry never kills: shallow drop depth below any lethal threshold.
    const dropMeters = 100 - entryY;
    if (!(dropMeters <= Math.abs(cs.CRAWL_Y_OFFSET) + 1e-9)) lethal++;
  }
  check(`500 entries: zero lethal drops`, lethal === 0, `${lethal} lethal`);
  check('500 entries: all land at CRAWL_Y_OFFSET (-1.2 m)', wrongDepth === 0, `${wrongDepth} wrong`);
  check('500 entries: every entry cell fallSafe+crawlable', unsafe === 0, `${unsafe} unsafe`);
}

// ---- 4. pocket geometry closed --------------------------------------------------
{
  const CH = 20;
  const m = new cs.CrawlspaceModel(denseGrid(CH, CH), SEED);
  const g = m.gaps()[0];
  const interior = m.pocketInterior(g);
  const ring = m.pocketWallRing(g);
  check('interior is 3x3 centred on the gap',
    interior.length === 9 && interior.some((c) => c.cellX === g.cellX && c.cellZ === g.cellZ));
  check('wall ring is the 16 cells around the 3x3', ring.length === 16);
  check('ring does not intersect interior',
    !ring.some((r) => interior.some((c) => r.cellX === c.cellX && r.cellZ === c.cellZ)));

  // Flood fill from the centre over "walkable" under-floor cells (inside some
  // pocket footprint, not wall ring): must never escape each pocket footprint.
  function sealed(pocketGap) {
    const inner = new Set(
      m.pocketInterior(pocketGap).map((c) => c.cellX + ',' + c.cellZ));
    const walls = new Set(
      m.pocketWallRing(pocketGap).map((c) => c.cellX + ',' + c.cellZ));
    const seen = new Set();
    const queue = [pocketGap];
    while (queue.length) {
      const cur = queue.pop();
      const k = cur.cellX + ',' + cur.cellZ;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!inner.has(k)) return false; // escaped the footprint -> void reachable
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = (cur.cellX + dx) + ',' + (cur.cellZ + dz);
        if (walls.has(nk) || seen.has(nk)) continue; // wall blocks movement
        if (m.isUnderFloor(cur.cellX + dx, cur.cellZ + dz)) {
          queue.push({ cellX: cur.cellX + dx, cellZ: cur.cellZ + dz });
        }
      }
    }
    return true;
  }
  check('flood fill from every pocket centre stays sealed',
    m.gaps().every(sealed), JSON.stringify(m.gaps().find((gg) => !sealed(gg))));
  check('isUnderFloor false far from any gap', !m.isUnderFloor(g.cellX + 10, g.cellZ));
}

// ---- 5. climb-out ----------------------------------------------------------------
{
  const CH = 12;
  const m = new cs.CrawlspaceModel(denseGrid(CH, CH), SEED);
  const g = m.gaps()[0];
  check('climb-out allowed at the gap rim column', m.canClimbOut(g.cellX, g.cellZ));
  check('climb-out refused off the gap column',
    !m.canClimbOut(g.cellX + 1, g.cellZ) && !m.canClimbOut(g.cellX, g.cellZ - 1) &&
    !m.canClimbOut(g.cellX + 2, g.cellZ + 2));
}

// ---- 6. determinism per seed -------------------------------------------------------
{
  const CH = 25;
  const a = new cs.CrawlspaceModel(holedGrid(CH, CH), SEED).serialize();
  const b = new cs.CrawlspaceModel(holedGrid(CH, CH), SEED).serialize();
  check('same seed byte-identical gap set', JSON.stringify(a) === JSON.stringify(b));
  const other = new cs.CrawlspaceModel(holedGrid(CH, CH), SEED ^ 0xffff).serialize();
  check('different seed differs', JSON.stringify(a) !== JSON.stringify(other));
}

// ---- 7. serialize round-trip + fail-loud validation -------------------------------
{
  const CH = 18;
  const m = new cs.CrawlspaceModel(denseGrid(CH, CH), SEED);
  const save = m.serialize();
  const back = cs.CrawlspaceModel.deserialize(save);
  check('round-trip: identical gaps()',
    JSON.stringify(back.serialize()) === JSON.stringify(save));
  check('round-trip: flagsAt matches on every original gap',
    m.gaps().every((g) => {
      const f1 = m.flagsAt(g.cellX, g.cellZ);
      const f2 = back.flagsAt(g.cellX, g.cellZ);
      return !!f1 && !!f2 && f1.crawlable === f2.crawlable && f1.fallSafe === f2.fallSafe;
    }));
  check('round-trip: seed preserved', back.seed === m.seed);
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };
  check('malformed save throws (bad version)', threw(() => cs.CrawlspaceModel.deserialize({ version: 2, seed: 1, gaps: [] })));
  check('malformed save throws (no gaps array)', threw(() => cs.CrawlspaceModel.deserialize({ version: 1, seed: 1 })));
  check('malformed save throws (null)', threw(() => cs.CrawlspaceModel.deserialize(null)));
  check('malformed gap entry throws', threw(() =>
    cs.CrawlspaceModel.deserialize({ version: 1, seed: 1, gaps: [{ cellX: 1.5, cellZ: 2 }] })));
  check('negative chunk counts rejected', threw(() => new cs.CrawlspaceModel({ chunksX: -1, chunksZ: 4, isFloor: () => true }, SEED)));
  check('non-function isFloor rejected', threw(() => new cs.CrawlspaceModel({ chunksX: 1, chunksZ: 1, isFloor: 'x' }, SEED)));
}

console.log(failures === 0 ? 'CRAWLSPACES_PASS' : `CRAWLSPACES_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
