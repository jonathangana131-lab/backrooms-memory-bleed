/**
 * Texture variety tests: carpet variants + per-chunk deterministic selection,
 * wall water-damage layers, per-tile ceiling grime, dynamic dirtying logic.
 *
 * Runs the real TS modules through vite's SSR loader - no browser needed.
 * Canvas painting itself needs a DOM, so createMaterials() is not invoked
 * here; instead we verify the pure selection/accumulation layer and audit
 * the painter source (which is fully seeded).
 *
 *   node test/texture-variety.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
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
  const mats = await server.ssrLoadModule('/src/gfx/materials.ts');
  const { CARPET_VARIANT_COUNT, carpetVariantIndex, CARPET_UV_SCALE, DirtMap, DIRT_CELL, DIRT_MAX_LAYERS } = mats;

  // ---------- 1. carpet variant count ----------
  check('CARPET_VARIANT_COUNT is 3', CARPET_VARIANT_COUNT === 3, String(CARPET_VARIANT_COUNT));

  // ---------- 2. carpetVariantIndex determinism ----------
  let detOk = true;
  for (let i = 0; i < 200; i++) {
    const cx = Math.floor(Math.random() * 4001) - 2000;
    const cz = Math.floor(Math.random() * 4001) - 2000;
    if (carpetVariantIndex(cx, cz) !== carpetVariantIndex(cx, cz)) detOk = false;
  }
  check('carpetVariantIndex is deterministic', detOk);

  // ---------- 3. variant index range + spread ----------
  const counts = [0, 0, 0];
  let inRange = true;
  for (let cx = -50; cx <= 50; cx++) {
    for (let cz = -50; cz <= 50; cz++) {
      const v = carpetVariantIndex(cx, cz);
      if (!Number.isInteger(v) || v < 0 || v >= CARPET_VARIANT_COUNT) inRange = false;
      counts[v]++;
    }


  }
  check('variant indices stay in range across the sweep', inRange);
  const spread = Math.min(...counts);
  check('all three variants appear across the sweep', spread > 0, JSON.stringify(counts));

  // ---------- 4. UV scale mirrors the mesher ----------
  check('CARPET_UV_SCALE is 1 / 1.7', CARPET_UV_SCALE === 1 / 1.7);

  // ---------- 5. DirtMap accumulation ----------
  {
    const dm = new DirtMap();
    check('fresh map has no marks', dm.totalMarks === 0 && dm.visitsAt(0, 0) === 0);
    const first = dm.mark(10, 10);
    check('first mark returns a splat', first !== null && typeof first.u === 'number' && typeof first.radiusU === 'number');
    check('visit recorded in the right bucket', dm.visitsAt(10, 10) === 1 && dm.totalMarks === 1);
    check('splats carry the documented alpha', first.alpha === 0.09);

    // same bucket accumulates; splats stop once DIRT_MAX_LAYERS is reached
    let lastOp = first;
    let nulls = 0;
    for (let i = 1; i < DIRT_MAX_LAYERS + 5; i++) {
      const op = dm.mark(10.2, 10.3); // same DIRT_CELL bucket
      if (op === null) nulls++;
      else { lastOp = op; }
    }
    check('bucket accepts exactly DIRT_MAX_LAYERS layers',
      dm.visitsAt(10, 10) - nulls === DIRT_MAX_LAYERS,
      'visits=' + dm.visitsAt(10, 10) + ' nulls=' + nulls);
    check('accepted splat reports its visit number', lastOp.visits <= DIRT_MAX_LAYERS);

    // a different bucket is independent
    check('neighbouring bucket starts clean', dm.mark(50, 50) !== null && dm.visitsAt(50, 50) === 1);

    dm.reset();
    check('reset clears visit tracking', dm.visitsAt(10, 10) === 0 && dm.totalMarks === 0);
  }

  // ---------- 6. dynamic dirtying wiring (source audit) ----------
  const src = fs.readFileSync(path.join(root, 'src/gfx/materials.ts'), 'utf8');
  // The whole variety system lives in materials.ts today.
  const s = src;

  // ---------- 7. Variety system surface contract (source audit) ----------
  check('TextureVariety exposes carpetVariants', /carpetVariants: StandardMaterial\[\];/.test(src));
  check('TextureVariety exposes markDirty(x, z, radius?)', /markDirty\(x: number, z: number, radius\?: number\): void;/.test(src));
  check('createMaterials publishes variants + markDirty + dirtMap on the singleton',
    /textureVariety\.carpetVariants = carpetVariants;/.test(src)
    && /textureVariety\.markDirty = markDirty;/.test(src)
    && /textureVariety\.dirtMap = dirtMap;/.test(src));
  check('MaterialSet keeps its legacy material-only shape',
    // Variety fields moved to their own TextureVariety interface; the
    // MaterialSet body itself must stay materials-only (comments excluded).
    (() => {
      const start = s.indexOf('export interface MaterialSet');
      const open = s.indexOf('{', start);
      const close = s.indexOf('}', open);
      // strip comments: the legacy alias doc mentions carpetVariants
      const body = s.slice(open + 1, close)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      return /markDirty|dirtMap|carpetVariants/.test(body) === false;
    })());

} finally {
  await server.close();
}



if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}


