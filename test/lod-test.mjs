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

(Showing lines 1-60 of 181. Use offset=61 to continue.)

