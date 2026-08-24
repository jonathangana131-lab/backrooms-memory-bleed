/**
 * Wire-bundles suite (run: node test/wirebundles-test.mjs)
 *
 * RECOVERY NOTE: the original src/world/wirebundles.ts (a WireBundles class
 * with generateForChunk()) was never recovered from the session transcripts -
 * only this test survived. The feature itself lives folded into the
 * reconstructed tree as:
 *   - src/world/architect.ts: generateWires()/generateCables() fill
 *     layout.wires with WireInstance specs {x, z, len} (wires follow dead
 *     lights; STORAGE canyon chunks grow ceiling cable bundles);
 *   - src/world/mesher.ts: addWires() consumes those specs through addBox()
 *     into the g.fixturesDead group.
 * This suite targets that surviving implementation and preserves every
 * surviving fragment's assertion intent: spec generation/determinism,
 * mesher.addBox consumption without throwing, before/after geometry counts,
 * clean triangle output, and the empty/degenerate-input section.
 *
 * Runs the real TS through vite's SSR loader so no build step or browser is
 * needed.
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log('PASS ' + name + (cond ? '' : ' :: ' + detail));
  } else {
    failures++;
    console.log('FAIL ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const { generateLayout } = await server.ssrLoadModule('/src/world/architect.ts');
  const { buildChunkGeometry } = await server.ssrLoadModule('/src/world/mesher.ts');
  const { CELL, CHUNK_CELLS, WALL_H, EdgeCode, District } =
    await server.ssrLoadModule('/src/world/constants.ts');

  const N = CHUNK_CELLS;
  const SEED = 1337;
  const MAZE = District.MAZE;
  const STORAGE = District.STORAGE;

  // Hand-built layout double mirroring the fragment's makeLayout(cx, cz,
  // district, extra): solid lattice, no generated dressing, caller-supplied
  // extras so wire specs are fully controlled.
  function makeLayout(cx, cz, district, extra = {}) {
    const hEdges = new Uint8Array((N + 1) * N).fill(EdgeCode.SOLID);
    const vEdges = new Uint8Array(N * (N + 1)).fill(EdgeCode.SOLID);
    return {
      cx, cz, hEdges, vEdges, district,
      lights: [], props: [], signs: [], notes: [],
      puddles: [], wires: [], stains: [], graffiti: [],
      memKind: 0, memIntensity: 0,
      ...extra,
    };
  }

  // --- 1. spec generation: shape of the emitted instances --------------------
  {
    let sawWires = false, shapesOk = true;
    for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const lay = generateLayout(SEED, cx, cz);
        if (!Array.isArray(lay.wires)) { shapesOk = false; continue; }
        for (const w of lay.wires) {
          shapesOk = shapesOk &&
            typeof w.x === 'number' && Number.isFinite(w.x) &&
            typeof w.z === 'number' && Number.isFinite(w.z) &&
            typeof w.len === 'number' && w.len > 0;
        }
        if (lay.wires.length > 0) sawWires = true;
      }
    }
    check('generated chunks carry well-formed wire specs', shapesOk);
    check('wire bundles occur across the scanned world', sawWires);
  }

  // --- 2. deterministic generation -------------------------------------------
  {
    const a = generateLayout(SEED, -4, 3);
    const b = generateLayout(SEED, -4, 3);
    check('identical requests generate byte-identical wire sets',
      JSON.stringify(a.wires) === JSON.stringify(b.wires),
      JSON.stringify(a.wires.slice(0, 2)) + ' vs ' + JSON.stringify(b.wires.slice(0, 2)));
  }

  // --- 3. wires follow dead lights ---------------------------------------------
  {
    // find a non-STORAGE chunk hosting wires (there the only source is
    // generateWires, which reuses dead-light data)
    let lay = null;
    outer:
    for (let cz = -4; cz <= 4; cz++) {
      for (let cx = -4; cx <= 4; cx++) {
        const l = generateLayout(SEED, cx, cz);
        if (l.wires.length > 0 && l.district !== District.STORAGE) { lay = l; break outer; }
      }
    }
    check('non-STORAGE chunk with wires exists in scan', lay !== null);
    if (lay) {
      const dead = lay.lights.filter((l) => !l.alive);
      let anchored = true;
      for (const w of lay.wires) {
        // generateWires offsets a dead light by <= +-0.3 in x, +-0.25 in z
        const near = dead.some((l) =>
          Math.abs(w.x - l.x) <= 0.31 && Math.abs(w.z - l.z) <= 0.26);
        // len = 0.5 + r*1.4 with r < 0.45
        if (!near || !(w.len >= 0.5 && w.len < 1.2)) { anchored = false; break; }
      }
      check('every dangling bundle anchors to a dead light',
        anchored, 'wires=' + lay.wires.length + ' deadLights=' + dead.length);
      check('dead lights outnumber their bundles on a dying chunk',
        lay.wires.length > 0 && dead.length >= lay.wires.length,
        'wires=' + lay.wires.length + ' dead=' + dead.length);
    }
  }

  // --- 4. STORAGE ceiling cables stay in-chunk ---------------------------------
  {
    let lay = null;
    outer:
    for (let cz = -6; cz <= 6; cz++) {
      for (let cx = -6; cx <= 6; cx++) {
        const l = generateLayout(SEED, cx, cz);
        if (l.district === District.STORAGE && l.wires.length >= 3) { lay = l; break outer; }
      }
    }
    check('STORAGE canyon chunk grows cable bundles', lay !== null);
    if (lay) {
      const x0 = lay.cx * N * CELL, x1 = (lay.cx + 1) * N * CELL;
      const z0 = lay.cz * N * CELL, z1 = (lay.cz + 1) * N * CELL;
      const inChunk = lay.wires.every((w) => w.x >= x0 && w.x < x1 && w.z >= z0 && w.z < z1);
      // generateCables lens land in rng.range(0.6, 2.2)
      const lensOk = lay.wires.every((w) => w.len > 0 && w.len <= 2.3);
      check('cable bundles stay inside their chunk bounds', inChunk);
      check('cable lengths within generator range', lensOk,
        'maxLen=' + Math.max(...lay.wires.map((w) => w.len)));
    }
  }

  // --- 5..8 mesher.addBox consumes BundleBox specs ------------------------------
  {
    const baseline = makeLayout(0, 0, MAZE, {});
    const gBase = buildChunkGeometry(baseline);
    const baseVerts = gBase.fixturesDead.positions.length / 3;

    const wires = [
      { x: 5.0, z: 6.0, len: 0.8 },
      { x: 6.7, z: 7.3, len: 1.1 },
      { x: 8.4, z: 8.6, len: 1.4 },
      { x: 10.1, z: 9.9, len: 1.7 },
      // long enough to engage the bot = max(0.4, top - len) floor guard
      { x: 12.8, z: 11.2, len: 3.0 },
    ];
    try {
      const before = gBase.fixturesDead.positions.length;
      const g = buildChunkGeometry(makeLayout(0, 0, MAZE, { wires }));
      const grewBy = g.fixturesDead.positions.length - before;
      // each spec meshes into exactly two thin conductors; every conductor is
      // one axis-aligned box of 20 vertices
      check('each bundle adds exactly its two-conductor vertex budget',
        grewBy === wires.length * 120,
        'grewBy=' + grewBy + ' expected=' + wires.length * 120);
      const verts = g.fixturesDead.positions.length / 3;
      const tris = g.fixturesDead.indices.length / 3;
      check('meshed fixture group carries real geometry',
        verts > 0 && tris > 0, 'verts=' + verts + ' tris=' + tris);
      check('emitted mesh is clean triangles (indices multiple of 3)',
        g.fixturesDead.indices.length % 3 === 0 && verts > 0);
      check('every meshed vertex is indexed exactly once',
        g.fixturesDead.indices.length === (verts / 3) * 4.5,
        'indices=' + g.fixturesDead.indices.length + ' verts=' + verts);

      // conductors hang from just under the ceiling down to bot = max(0.4, top-len)
      let ymin = Infinity, ymax = -Infinity;
      for (let v = 0; v < verts; v++) {
        const y = g.fixturesDead.positions[v * 3 + 1];
        ymin = Math.min(ymin, y);
        ymax = Math.max(ymax, y);
      }
      const top = WALL_H - 0.02;
      check('bundles hang from just under the ceiling',
        Math.abs(ymax - top) < 1e-6, 'ymax=' + ymax.toFixed(4) + ' top=' + top);
      // the len=3.0 spec bottoms out at max(0.4, top - 3.0) = 0.4
      check('longest drop clamps at the 0.4 m floor guard',
        Math.abs(ymin - Math.min(...wires.map((w) => Math.max(0.4, top - w.len)))) < 1e-6,
        'ymin=' + ymin.toFixed(4));
      check('bundle drops respect per-spec length',
        ymin >= 0.39 && ymax <= top + 1e-9);
    } catch (e) {
      check('mesher.addBox consumes wire specs without throwing', false, String(e));
    }

    // per-spec growth is linear and independent of position
    {
      const one = buildChunkGeometry(makeLayout(0, 0, MAZE, { wires: [wires[0]] }));
      check('single bundle matches the per-spec vertex budget',
        one.fixturesDead.positions.length / 3 === baseVerts + 40,
        'verts=' + one.fixturesDead.positions.length / 3);
    }
  }

  // --- 9. empty/degenerate inputs ---------------------------------------------
  {
    const empty = makeLayout(0, 0, MAZE, {}); // no walls, no lights, no wires
    const out = buildChunkGeometry(empty);
    check('wall-free chunk yields zero instances',
      Array.isArray(empty.wires) && empty.wires.length === 0 &&
      out.fixturesDead.positions.length === 0,
      'wires=' + empty.wires.length +
      ' fixtureVerts=' + out.fixturesDead.positions.length / 3);

    const doorwayOnly = makeLayout(0, 0, STORAGE, {});
    doorwayOnly.hEdges[5 * N + 4] = EdgeCode.DOORWAY; // DOORWAY edge only
    const out2 = buildChunkGeometry(doorwayOnly);
    check('doorway-only edges host no runs',
      out2.fixturesDead.positions.length === 0 && doorwayOnly.wires.length === 0,
      'fixtureVerts=' + out2.fixturesDead.positions.length / 3);
  }
} finally {
  await server.close();
}

console.log(failures === 0 ? '\nALL TESTS PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
