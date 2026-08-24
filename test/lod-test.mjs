/**
 * Prop LOD tests: distance-based detail skipping in buildChunkGeometry.
 * Runs the real TS mesher through vite's SSR loader so no build step or
 * browser is needed.
 *
 *   node test/lod-test.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok - ' + name);
  } else {
    failures++;
    console.error('FAIL - ' + name + (detail ? ' :: ' + detail : ''));
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});
try {
  const { buildChunkGeometry, lodLevelFor, LOD_NEAR, LOD_FAR } =
    await server.ssrLoadModule('/src/world/mesher.ts');
  const { CELL, CHUNK_CELLS, EdgeCode } =
    await server.ssrLoadModule('/src/world/constants.ts');

  const N = CHUNK_CELLS;
  const SPAN = N * CELL;
  // open lattice so walls do not dominate vertex counts
  const makeLayout = () => {
    const hEdges = new Uint8Array((N + 1) * N).fill(EdgeCode.OPEN);
    const vEdges = new Uint8Array(N * (N + 1)).fill(EdgeCode.OPEN);
    return {
      cx: 3, cz: -2,
      hEdges, vEdges,
      district: 3, // District.CORRIDOR_GRID
      lights: [],
      props: [],
      signs: [],
      // papers: readable notes on the carpet
      notes: [
        { x: 100.5, z: -44.5, rot: 0.4 },
        { x: 102.5, z: -47.5, rot: 1.9 },
      ],
      puddles: [], wires: [],
      // stains/graffiti band
      stains: [{ x: 101, z: -46, r: 0.8 }],
      graffiti: [
        { x: 96, y: 1.4, z: -31.5, face: 0, text: 'NO EXIT' },
      ],
    };
  };

  // world-space center of chunk (3, -2); every distance below measures to it
  const center = { x: 3.5 * SPAN, z: -1.5 * SPAN };

  // ---------- 1. lodLevelFor distance bands ----------
  check('camera at chunk center -> level 0',
    lodLevelFor(center.x, center.z, center.x, center.z) === 0);
  check('at exactly LOD_NEAR -> still level 0 (strictly-greater bands)',
    lodLevelFor(center.x + LOD_NEAR, center.z, center.x, center.z) === 0);
  check('just past LOD_NEAR -> level 1',
    lodLevelFor(center.x + LOD_NEAR + 0.5, center.z, center.x, center.z) === 1);
  check('just inside LOD_FAR -> level 1',
    lodLevelFor(center.x + LOD_FAR - 0.5, center.z, center.x, center.z) === 1);
  check('past LOD_FAR -> level 2',
    lodLevelFor(center.x + LOD_FAR + 0.5, center.z, center.x, center.z) === 2);
  check('bands measure euclidean distance, not per-axis',
    lodLevelFor(center.x + 30, center.z + 35, center.x, center.z) === 1 &&
    lodLevelFor(center.x + 25, center.z + 25, center.x, center.z) === 0);
  check('non-finite camera falls back to full detail',
    lodLevelFor(NaN, Infinity, center.x, center.z) === 0);

  // ---------- 2. default call meshes everything (full detail) ----------
  const full = buildChunkGeometry(makeLayout());
  check('full detail meshes notes onto the carpet',
    full.debris.positions.length / 3 >= 8,
    'verts=' + full.debris.positions.length / 3);
  check('full detail meshes the ceiling stain (7-fan patch)',
    full.stains.positions.length / 3 === 28,
    'verts=' + full.stains.positions.length / 3);
  check('full detail meshes the graffiti sheet',
    full.graffiti.positions.length / 3 === 4,
    'verts=' + full.graffiti.positions.length / 3);

  // ---------- 3. near LOD skips small dressing quads ----------
  const nearCamX = center.x + LOD_NEAR + 0.5;
  const near = buildChunkGeometry(makeLayout(), nearCamX, center.z);
  check('near LOD drops debris and readable notes',
    near.debris.positions.length === 0,
    'verts=' + near.debris.positions.length / 3);
  check('near LOD keeps stains', near.stains.positions.length / 3 === 28);
  check('near LOD keeps graffiti', near.graffiti.positions.length / 3 === 4);
  check('near LOD leaves architecture untouched',
    near.walls.positions.length === full.walls.positions.length &&
    near.floor.positions.length === full.floor.positions.length &&
    near.ceiling.positions.length === full.ceiling.positions.length);

  // ---------- 4. far LOD additionally skips stains/graffiti ----------
  const far = buildChunkGeometry(makeLayout(), center.x + LOD_FAR + 0.5, center.z);
  check('far LOD drops stains', far.stains.positions.length === 0);
  check('far LOD drops graffiti', far.graffiti.positions.length === 0);
  check('far LOD still meshes architecture',
    far.floor.positions.length === full.floor.positions.length &&
    far.walls.positions.length === full.walls.positions.length);

  // ---------- determinism: same camera -> byte-identical geometry ----------
  const again = buildChunkGeometry(makeLayout(), nearCamX, center.z);
  check('same chunk + same camera rebuilds identically',
    deepEqual(near, again));
} finally {
  await server.close();
}

if (failures > 0) {
  console.error('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nAll LOD checks passed.');
