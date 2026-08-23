/**
 * Mesher architectural-detail tests: baseboards, ceiling grid, door headers,
 * floor wear. Runs the real TS mesher through vite's SSR loader so no build
 * step or browser is needed.
 *
 *   node test/mesher-detail.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log('  ok - ' + name);
  } else {
    failures++;
    console.error('FAIL - ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});
try {
  const { buildChunkGeometry } = await server.ssrLoadModule('/src/world/mesher.ts');
  const { WALL_H, CELL, CHUNK_CELLS, EdgeCode } = await server.ssrLoadModule('/src/world/constants.ts');

  const N = CHUNK_CELLS;
  // all-solid lattice with one doorway on an interior horizontal edge
  const makeLayout = (district) => {
    const hEdges = new Uint8Array((N + 1) * N).fill(EdgeCode.SOLID);
    const vEdges = new Uint8Array(N * (N + 1)).fill(EdgeCode.SOLID);
    const doorCell = 5;
    hEdges[6 * N + doorCell] = EdgeCode.DOORWAY;
    return {
      cx: 3, cz: -2,
      hEdges, vEdges,
      district,
      lights: [], props: [], signs: [], notes: [],
      puddles: [], wires: [], stains: [], graffiti: [],
      memKind: 0, memIntensity: 0,
    };
  };
  const CORRIDOR_GRID = 3; // District.CORRIDOR_GRID
  const MAZE = 0;

  const geo = buildChunkGeometry(makeLayout(CORRIDOR_GRID));

  // ---------- 1. baseboards ----------
  {
    const w = geo.walls;
    let baseTopVerts = 0, darkTintVerts = 0;
    for (let v = 0; v < w.positions.length / 3; v++) {
      const y = w.positions[v * 3 + 1];


