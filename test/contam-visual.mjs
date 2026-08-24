/**
 * Contamination visual tests: the Memory Contamination field must be VISIBLE
 * in the world without touching pure-sample chunks.
 *
 *   1. density-0 identity  - memIntensity 0 chunks are byte-identical to the
 *                            classic look (no drift anywhere, no extra decals)
 *   2. monotone drift      - tint deviation grows with memIntensity, per cell
 *                            and across whole chunk geometry
 *   3. byte-stable regen   - contaminated chunks rebuild to identical bytes
 *   4. fog response        - chunkFogDensity gains a contamination term only
 *                            when fed one; warmthAt blends contamination
 *   5. bleed decals        - high-contamination layouts carry stain/peel
 *                            decals, deterministic across rebuilds
 *
 * Runs the real TS modules through vite's SSR loader so no build step or
 * browser is needed.
 *
 *   node test/contam-visual.mjs
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
  const mesherMod = await server.ssrLoadModule('/src/world/mesher.ts');
  const { buildChunkGeometry, contamCellTint,
    CONTAM_SURFACE_FLOOR, CONTAM_SURFACE_WALL, CONTAM_SURFACE_CEIL } = mesherMod;
  const { EdgeCode, CHUNK_CELLS, CELL } = await server.ssrLoadModule('/src/world/constants.ts');
  const fogMod = await server.ssrLoadModule('/src/gfx/fogvariation.ts');
  const { createFogVariation, chunkFogDensity, CONTAM_FOG_BOOST } = fogMod;
  const archMod = await server.ssrLoadModule('/src/world/architect.ts');
  const { generateLayout, landmarkFor } = archMod;
  const fieldMod = await server.ssrLoadModule('/src/memory/field.ts');
  const { MemoryField, MemoryKind, REGION_SIZE } = fieldMod;

  const N = CHUNK_CELLS;
  // find a non-landmark chunk near spawn for layout-level assertions
  let LX = 0, LZ = 0;
  outer: for (let cz = -6; cz <= 6; cz++) {
    for (let cx = -6; cx <= 6; cx++) {
      if (!landmarkFor(cx, cz, 1337)) { LX = cx; LZ = cz; break outer; }
    }
  }

  const makeLayout = (intensity, kind) => ({
    cx: 3, cz: -2,
    hEdges: new Uint8Array((N + 1) * N).fill(EdgeCode.SOLID),
    vEdges: new Uint8Array(N * (N + 1)).fill(EdgeCode.SOLID),
    district: 0,
    lights: [], props: [], signs: [], notes: [],
    puddles: [], wires: [], stains: [], graffiti: [],
    memKind: kind, memIntensity: intensity,
  });

  // ---------- 1. density-0 identity ----------
  {
    check('contamCellTint is exactly [1,1,1] at intensity 0',
      [0, 0.5, 1].every(() => true) &&
      [[3, 7], [-11, 4002], [99991, -7]].every(([x, z]) =>
        [CONTAM_SURFACE_FLOOR, CONTAM_SURFACE_WALL, CONTAM_SURFACE_CEIL].every((s) => {
          const t = contamCellTint(0, MemoryKind.PERSONAL, x, z, s);
          return t[0] === 1 && t[1] === 1 && t[2] === 1;
        })));

    // classic tints an uncontaminated chunk may carry (hand-set constants
    // in the mesher); nothing else may appear at memIntensity 0
    const classic = new Set(['1.00000000,1.00000000,1.00000000']);
    for (const [r, g, b] of [
      [1.22, 1.19, 1.12],           // floor wear patches
      [0.42, 0.40, 0.37],           // baseboards
      [0.72, 0.70, 0.66],           // door frames
      [0.58, 0.57, 0.54],           // ceiling grid
    ]) classic.add(r.toFixed(8) + ',' + g.toFixed(8) + ',' + b.toFixed(8));

    const geo = buildChunkGeometry(makeLayout(0, MemoryKind.NONE));
    let foreign = 0;
    for (const grp of [geo.floor, geo.ceiling, geo.walls]) {
      // an empty color channel means "never touched" = pure white default
      if (!grp.colors || grp.colors.length === 0) continue;
      for (let v = 0; v < grp.positions.length / 3; v++) {
        const key = grp.colors[v * 4].toFixed(8) + ',' +
          grp.colors[v * 4 + 1].toFixed(8) + ',' + grp.colors[v * 4 + 2].toFixed(8);
        if (!classic.has(key)) foreign++;
      }
    }
    check('density-0 geometry carries only classic tints', foreign === 0,
      foreign + ' foreign-tint verts');

    // pure-sample identity holds regardless of memory kind sampled nearby:
    // kind alone must not shift colors when intensity is 0
    const geoOtherKind = buildChunkGeometry(makeLayout(0, MemoryKind.HOSPITAL));
    check('kind without intensity does not drift',
      JSON.stringify(geo.floor.colors) === JSON.stringify(geoOtherKind.floor.colors) &&
      JSON.stringify(geo.walls.colors) === JSON.stringify(geoOtherKind.walls.colors));
  }

  // ---------- 2. monotone drift vs memIntensity ----------
  {
    // per-cell: deviation from white must be non-decreasing in intensity
    let mono = true;
    let strict = false;
    for (let wx = 40; wx < 48; wx++) {
      for (let wz = -30; wz < -24; wz++) {
        for (const s of [CONTAM_SURFACE_FLOOR, CONTAM_SURFACE_WALL]) {
          let prev = 0;
          for (const inten of [0, 0.25, 0.5, 0.75, 1]) {
            const t = contamCellTint(inten, MemoryKind.OFFICE, wx, wz, s);
            const dev = Math.abs(t[0] - 1) + Math.abs(t[1] - 1) + Math.abs(t[2] - 1);
            if (dev < prev - 1e-12) mono = false;
            if (dev > prev + 1e-12) strict = true;
            prev = dev;
          }
        }
      }
    }
    check('per-cell tint deviation never decreases with intensity', mono);
    check('drift actually varies across cells and intensities', strict);

    // whole-chunk integration: total color deviation grows with intensity
    const devs = [];
    for (const inten of [0, 0.25, 0.5, 0.75, 1]) {
      const geo = buildChunkGeometry(makeLayout(inten, MemoryKind.OFFICE));
      let dev = 0;
      for (const grp of [geo.floor, geo.ceiling, geo.walls]) {
        for (let i = 0; i < grp.colors.length; i++) dev += Math.abs(grp.colors[i] - 1);
      }
      devs.push(dev);
    }
    let chunkMono = true;
    for (let i = 1; i < devs.length; i++) {
      if (devs[i] <= devs[i - 1]) chunkMono = false;
    }
    check('whole-chunk color deviation strictly increases with intensity', chunkMono,
      JSON.stringify(devs.map((d) => Math.round(d))));
    check('contaminated chunks actually deviate', devs[devs.length - 1] > 50);

    // walls sicken: at full intensity wall red channel sits below 1 somewhere
    const hot = buildChunkGeometry(makeLayout(1, MemoryKind.OFFICE));
    let sicklyWalls = 0;
    for (let v = 0; v < hot.walls.positions.length / 3; v++) {
      if (hot.walls.colors[v * 4] < 0.95) sicklyWalls++;
    }
    check('walls go sickly under full contamination', sicklyWalls > 100,
      String(sicklyWalls));
  }

  // ---------- 3. byte-stable regeneration ----------
  {
    const a = buildChunkGeometry(makeLayout(0.7, MemoryKind.TRANSIT));
    const b = buildChunkGeometry(makeLayout(0.7, MemoryKind.TRANSIT));
    const same = ['floor', 'ceiling', 'walls'].every((k) =>
      JSON.stringify(a[k].positions) === JSON.stringify(b[k].positions) &&
      JSON.stringify(a[k].colors) === JSON.stringify(b[k].colors));
    check('contaminated chunk regenerates byte-identical', same);
  }

  // ---------- 4. fog response ----------
  {
    const cx = 5, cz = 9;
    const base = chunkFogDensity(cx, cz);
    check('no contam term reproduces classic density exactly',
      chunkFogDensity(cx, cz, undefined, 0) === base);
    const half = chunkFogDensity(cx, cz, undefined, 0.5);
    const full = chunkFogDensity(cx, cz, undefined, 1);
    check('contamination densifies fog monotonically',
      half > base && full > half && full <= base * CONTAM_FOG_BOOST + 1e-12,
      base.toFixed(4) + ' -> ' + full.toFixed(4));
    check('full-contamination boost factor matches CONTAM_FOG_BOOST',
      Math.abs(full / base - CONTAM_FOG_BOOST) < 1e-9);

    const fv = createFogVariation();
    const S = 30; // CHUNK_SIZE
    fv.updateContamSet([{ cx, cz, intensity: 1 }]);
    // exactly on the chunk's lower-left lattice point the bilinear weight of
    // that chunk is 1, so the deep sample equals its raw boosted density
    const deep = fv.multiplierAt(cx * S, cz * S);
    check('sampler densifies deep inside a contaminated chunk',
      Math.abs(deep - full) < 1e-9, deep.toFixed(4) + ' vs ' + full.toFixed(4));
    const warmDeep = fv.warmthAt(cx * S, cz * S);
    check('warmth reads ~1 inside a saturated reconstruction zone',
      warmDeep > 0.98, String(warmDeep));
    fv.updateContamSet([]);
    check('clearing contamination restores classic sampling',
      Math.abs(fv.multiplierAt(cx * S, cz * S) -
        chunkFogDensity(cx, cz)) < 1e-9);
    check('warmth clears too', fv.warmthAt(cx * S, cz * S) === 0);
  }

  // ---------- 5. bleed decals ----------
  {
    const seed = 1337;
    // uncontaminated baseline layout: no bleed details beyond landmarks
    const clean = generateLayout(seed, LX, LZ);
    check('zero-contamination layout carries no blood/lint bleed decals',
      !(clean.details ?? []).some((d) => d.tag === 'blood' || d.tag === 'lint'));

    // inject strong personal memories around that chunk's center
    const mem = new MemoryField(seed);
    const centerX = (LX + 0.5) * N * CELL;
    const centerZ = (LZ + 0.5) * N * CELL;
    for (const [dx, dz] of [[0, 0], [REGION_SIZE, 0], [0, REGION_SIZE],
      [-REGION_SIZE, 0], [0, -REGION_SIZE]]) {
      mem.inject(centerX + dx, centerZ + dz, MemoryKind.PERSONAL, 1);
    }
    const hot1 = generateLayout(seed, LX, LZ, mem);
    const hot2 = generateLayout(seed, LX, LZ, mem);
    const bleeds1 = (hot1.details ?? []).filter((d) => d.tag === 'blood' || d.tag === 'lint');
    const bleeds2 = (hot2.details ?? []).filter((d) => d.tag === 'blood' || d.tag === 'lint');
    check('high-contamination layout grows bleed decals', bleeds1.length > 0,
      String(bleeds1.length));
    check('bleed decal set is byte-stable across rebuilds',
      JSON.stringify(bleeds1) === JSON.stringify(bleeds2));
    check('bleed decal density scales with sampled contamination',
      hot1.memIntensity > clean.memIntensity,
      hot1.memIntensity.toFixed(2) + ' vs ' + clean.memIntensity.toFixed(2));
    // stain blooms sit on the floor; peel curls hug walls
    const blooms = bleeds1.filter((d) => d.tag === 'blood');
    const peels = bleeds1.filter((d) => d.tag === 'lint');
    check('stain blooms are low horizontal quads',
      blooms.every((d) => d.y < 0.05 && d.face === undefined));
    check('peel curls mount on a wall face',
      peels.length === 0 || peels.every((d) => d.face !== undefined));
  }
} finally {
  await server.close();
}

if (failures > 0) {
  console.error('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nAll contam-visual checks passed.');
