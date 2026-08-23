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


      if (Math.abs(y - 0.1) < 1e-6) baseTopVerts++;
      if (w.colors && Math.abs(w.colors[v * 4] - 0.42) < 1e-4) darkTintVerts++;
    }
    check('baseboards exist (tops at y=0.1)', baseTopVerts >= 100, 'verts=' + baseTopVerts);
    check('baseboards carry dark wall-material tint', darkTintVerts >= 100, 'verts=' + darkTintVerts);

    // strip sits proud of the wall face: some wall vertex at z offset ~ ht+0.008
    const ht = 0.16 / 2;
    let proudZ = 0;
    for (let v = 0; v < w.positions.length / 3; v++) {
      const z = w.positions[v * 3 + 2];
      if (Math.abs(z - Math.round(z / CELL) * CELL - ht - 0.008) < 1e-6 || Math.abs(z - Math.round(z / CELL) * CELL + ht + 0.008) < 1e-6) proudZ++;
    }
    check('baseboards sit proud of wall faces', proudZ > 0, 'verts=' + proudZ);
  }

  // ---------- 2. ceiling tile grid ----------
  {
    const c = geo.ceiling;
    const gridY = WALL_H - 0.009;
    let gridQuads = 0;
    for (let q = 0; q < c.positions.length / 12; q++) {
      const ys = [0, 1, 2, 3].map(i => c.positions[q * 12 + i * 3 + 1]);
      if (ys.every(y => Math.abs(y - gridY) < 1e-6)) gridQuads++;
    }
    check('ceiling grid grooves just below ceiling plane', gridQuads === 2 * (N + 1),
      'quads=' + gridQuads + ' expected=' + 2 * (N + 1));
    // thin: every groove quad spans <= 0.033 m across its short axis
    let thin = true;
    for (let q = 0; q < c.positions.length / 12; q++) {
      const ys = [0, 1, 2, 3].map(i => c.positions[q * 12 + i * 3 + 1]);
      if (!ys.every(y => Math.abs(y - gridY) < 1e-6)) continue; // skip tile quads
      const xs = [0, 1, 2, 3].map(i => c.positions[q * 12 + i * 3]);
      const zs = [0, 1, 2, 3].map(i => c.positions[q * 12 + i * 3 + 2]);
      const wx = Math.max(...xs) - Math.min(...xs);
      const wz = Math.max(...zs) - Math.min(...zs);
      if (Math.min(wx, wz) > 0.033) thin = false;
    }
    check('grid lines are thin', thin);
    // darker tint than plain ceiling tiles
    const lastV = c.positions.length / 3 - 1;
    check('grid lines carry dark tint', Math.abs(c.colors[lastV * 4] - 0.58) < 1e-4,
      'r=' + c.colors[lastV * 4]);
  }

  // ---------- 3. door frame headers ----------
  {
    const w = geo.walls;
    const mid = ((3 * N) + 5) * CELL + CELL / 2; // world x-center of doorway (cx=3, cell 5)
    const dw = 1.24 / 2, side = 0.2;
    let beamVerts = 0, beamTinted = 0;
    const y0 = 2.14 + 0.07, y1 = y0 + 0.15;
    for (let v = 0; v < w.positions.length / 3; v++) {
      const x = w.positions[v * 3], y = w.positions[v * 3 + 1];
      if (y > y0 - 1e-6 && y < y1 + 1e-6 && Math.abs(x - (mid - dw - side)) < 1e-6) beamVerts++;
      if (w.colors && w.colors[v * 4] !== undefined &&
          Math.abs(w.colors[v * 4] - 0.72) < 1e-4 && y > y0 - 1e-6 && y < y1 + 1e-6) beamTinted++;
    }
    check('header beam exists above doorway (full span)', beamVerts >= 8, 'verts=' + beamVerts);
    check('header beam carries trim tint', beamTinted >= 8, 'verts=' + beamTinted);

    // vertical doorway too
    const lay = makeLayout(MAZE);
    const vDoorRow = 4;
    lay.vEdges[vDoorRow * (N + 1) + 7] = EdgeCode.DOORWAY;
    const g2 = buildChunkGeometry(lay);
    const zmid = ((-2 * N) + vDoorRow) * CELL + CELL / 2;
    let beam2 = 0;
    for (let v = 0; v < g2.walls.positions.length / 3; v++) {
      const y = g2.walls.positions[v * 3 + 1], z = g2.walls.positions[v * 3 + 2];
      if (y > y0 - 1e-6 && y < y1 + 1e-6 && Math.abs(z - (zmid - dw - side)) < 1e-6) beam2++;
    }
    check('vertical doorways get headers too', beam2 >= 8, 'verts=' + beam2);
  }

  // ---------- 4. floor wear patterns ----------
  {
    const f = geo.floor;
    let wearVerts = 0, lighter = 0;
    for (let v = 0; v < f.positions.length / 3; v++) {
      const y = f.positions[v * 3 + 1];
      if (Math.abs(y - 0.002) < 1e-6) wearVerts++;
      if (f.colors && f.colors[v * 4] > 1.01 && Math.abs(f.positions[v * 3 + 1] - 0.002) < 1e-6) lighter++;
    }
    check('floor wear patches at y=0.002', wearVerts > 0, 'verts=' + wearVerts);
    check('wear patches are lighter carpet tint', lighter === wearVerts && wearVerts > 0, 'lighter=' + lighter);
    // irregular: fan quads share a center vertex -> repeated positions per patch
    check('wear uses irregular fans (>20 verts)', wearVerts >= 25, 'verts=' + wearVerts);

    // maze district must stay clean
    const gm = buildChunkGeometry(makeLayout(MAZE));
    let mazeWear = 0;
    for (let v = 0; v < gm.floor.positions.length / 3; v++) {
      if (Math.abs(gm.floor.positions[v * 3 + 1] - 0.002) < 1e-6) mazeWear++;
    }
    check('no wear patches outside corridor districts', mazeWear === 0);
  }

  // ---------- determinism ----------
  {
    const a = buildChunkGeometry(makeLayout(CORRIDOR_GRID));
    const b = buildChunkGeometry(makeLayout(CORRIDOR_GRID));
    check('geometry is deterministic',
      JSON.stringify(a.floor.positions) === JSON.stringify(b.floor.positions) &&
      JSON.stringify(a.walls.colors) === JSON.stringify(b.walls.colors));
  }

  // color channel stays vertex-synced (applyTint contract)
  {
    const sync = ['floor', 'ceiling', 'walls'].every(k =>
      geo[k].colors.length === (geo[k].positions.length / 3) * 4);
    check('color buffers synced with vertex counts', sync);
  }
} finally {
  await server.close();
}

if (failures > 0) {
  console.error('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nAll mesher-detail checks passed.');


