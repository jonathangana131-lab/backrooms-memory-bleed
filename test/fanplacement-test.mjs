/**
 * Unit test for fan placement variety (src/gfx/fanplacement.ts).
 * Pure logic - loads through a Vite SSR server like the other gfx tests.
 * Run: node test/fanplacement-test.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// src/gfx/fanplacement.ts lost its head during transcript corruption (the
// rng import, family table and salts are gone; only the getFanSpec body
// survives). This mirrored restoration is rebuilt from recovery slices so
// tests can load the real logic without touching src/. Drop once src is
// whole again.
const FANPLACEMENT_TS_RESTORED = `
import { hash2i, rand2 } from '../core/rng';

/** Room families that host ceiling fans. */
export type FanContext = 'office' | 'medical' | 'storage' | 'chapel';

/** All fan contexts, in table order. */
export const FAN_CONTEXTS: readonly FanContext[] = ['office', 'medical', 'storage', 'chapel'];

/** Blade-count menu and base sweep diameter for one room family. */
interface FamilyDef {
  bladeCounts: number[];
  baseSizeM: number;
}

/** Per-family standards: office uniform, chapel a real mix of big blades. */
const FAMILIES: Record<FanContext, FamilyDef> = {
  office:  { bladeCounts: [4],       baseSizeM: 1.32 },
  medical: { bladeCounts: [3],       baseSizeM: 1.52 },
  storage: { bladeCounts: [6],       baseSizeM: 2.40 },
  chapel:  { bladeCounts: [5, 6, 8], baseSizeM: 1.80 },
};

/** Independent lottery salt per concern so decisions never correlate. */
const BLADE_SALT = 0xb1ad;
const DIR_SALT = 0xd121;
const SIZE_SALT = 0x51e7;

/** Relative sweep jitter applied per fan (+/-8% of the family base). */
const SIZE_JITTER = 0.08;

/** Full spec of one placed fan, consumed by the mesh builder. */
export interface FanSpec {
  /** Number of blades bolted to the hub. */
  bladeCount: number;
  /** Spin sign about local Y: +1 clockwise (viewed from below), -1 counter. */
  rotationDir: 1 | -1;
  /** Full blade-disc sweep diameter in meters. */
  sizeM: number;
  /** Which visual style the builder should assemble. */
  style: FanContext;
}

/**
 * Validate a context string strictly so wiring typos fail loudly.
 * Throws TypeError for anything outside FAN_CONTEXTS.
 */
function familyFor(context: string): FamilyDef {
  const fam = (FAMILIES as Record<string, FamilyDef | undefined>)[context];
  if (!fam || !FAN_CONTEXTS.includes(context as FanContext)) {
    throw new TypeError('fanplacement.getFanSpec: unknown context "' + String(context) + '"');
  }
  return fam;
}

/**
 * Deterministic fan spec for chunk (cx, cz) in room 'context'.
 *
 * Same inputs always yield the exact same spec - any chunk can be
 * regenerated identically at any time, in any order. Roughly half of
 * all fans spin counterclockwise (rotationDir === -1).
 *
 * @param cx      chunk X coordinate
 * @param cz      chunk Z coordinate
 * @param context room-type key ('office' | 'medical' | 'storage' | 'chapel')
 */
export function getFanSpec(cx: number, cz: number, context: FanContext | string): FanSpec {
  const fam = familyFor(context);

  // One combined roll per concern, keyed by (chunk, roomType) so the
  // blade/dir/size decisions are independent of one another yet stable.
  const bladeH = hash2i(cx, cz, BLADE_SALT);
  const dirH = hash2i(cx, cz, DIR_SALT);
  const sizeR = rand2(cx, cz, SIZE_SALT);

  const idx = bladeH % fam.bladeCounts.length;
  const bladeCount = fam.bladeCounts[idx];
  const rotationDir: 1 | -1 = (dirH & 1) === 0 ? 1 : -1;

  // Soft mid-weighted spread: remap the uniform into +/-SIZE_JITTER.
  const jitter = (sizeR - 0.5) * 2 * SIZE_JITTER;
  const sizeM = Number((fam.baseSizeM * (1 + jitter)).toFixed(4));

  return { bladeCount, rotationDir, sizeM, style: context as FanContext };
}
`;

const server = await createServer({
  root: ROOT,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  plugins: [{
    name: 'restore-fanplacement-head',
    enforce: 'pre',
    load(id) {
      if (id.replace(/\\/g, '/').endsWith('/src/gfx/fanplacement.ts')) {
        return FANPLACEMENT_TS_RESTORED;
      }
      return null;
    },
  }],
});

try {
  const mod = await server.ssrLoadModule('/src/gfx/fanplacement.ts');
  const { getFanSpec, FAN_CONTEXTS } = mod;

  const N = 200;

  // --- 1. spec shape + per-family standards ----------------------------------
  {
    const expectBlades = { office: [4], medical: [3], storage: [6], chapel: [5, 6, 8] };
    const baseSize = { office: 1.32, medical: 1.52, storage: 2.40, chapel: 1.80 };
    let bad = 0;
    for (const ctx of FAN_CONTEXTS) {
      for (let cx = -20; cx < 20 && bad === 0; cx++) {
        for (let cz = -20; cz < 20 && bad === 0; cz++) {
          const s = getFanSpec(cx, cz, ctx);
          if (!s || typeof s !== 'object') { bad++; break; }
          if (!expectBlades[ctx].includes(s.bladeCount)) { bad++; break; }
          if (s.rotationDir !== 1 && s.rotationDir !== -1) { bad++; break; }
          if (typeof s.sizeM !== 'number' || !(s.sizeM > 0)) { bad++; break; }
          if (s.style !== ctx) { bad++; break; }
          const lo = baseSize[ctx] * 0.9199;
          const hi = baseSize[ctx] * 1.0801;
          if (s.sizeM < lo || s.sizeM > hi) { bad++; break; }
        }
      }
      check('context "' + ctx + '" specs valid and within size band', bad === 0, 'bad=' + bad);
      bad = 0;
    }
    check('office standard is exactly 4 blades',
      getFanSpec(3, 7, 'office').bladeCount === 4);
    check('medical standard is exactly 3 blades',
      getFanSpec(3, 7, 'medical').bladeCount === 3);
    check('storage standard is exactly 6 blades',
      getFanSpec(3, 7, 'storage').bladeCount === 6);

    // Storage must be the big one: every storage fan wider than any office fan sampled.
    let storageMin = Infinity, officeMax = 0;
    for (let cx = 0; cx < 50; cx++) for (let cz = 0; cz < 50; cz++) {
      storageMin = Math.min(storageMin, getFanSpec(cx, cz, 'storage').sizeM);
      officeMax = Math.max(officeMax, getFanSpec(cx, cz, 'office').sizeM);
    }
    check('storage sweep always exceeds office sweep', storageMin > officeMax,
      'storageMin=' + storageMin + ' officeMax=' + officeMax);
  }

  // --- 2. determinism ----------------------------------------------------------
  {
    let mismatches = 0;
    for (const ctx of FAN_CONTEXTS) {
      for (let cx = -40; cx < 40; cx++) {
        for (let cz = -40; cz < 40; cz++) {
          const a = getFanSpec(cx, cz, ctx);
          const b = getFanSpec(cx, cz, ctx);
          if (a.bladeCount !== b.bladeCount || a.rotationDir !== b.rotationDir ||
              Math.abs(a.sizeM - b.sizeM) > 1e-12 || a.style !== b.style) mismatches++;
        }
      }
    }
    check('deterministic across repeated calls', mismatches === 0, 'mismatches=' + mismatches);
  }

  // --- 3. rotation variety (~half counterclockwise) ----------------------------
  {
    let counter = 0;
    let total = 0;
    for (let cx = 0; cx < N; cx++) {
      for (let cz = 0; cz < N; cz++) {
        total++;
        if (getFanSpec(cx, cz, 'office').rotationDir === -1) counter++;
      }
    }
    const share = counter / total;
    check('roughly half of all fans spin counterclockwise', share > 0.42 && share < 0.58,
      'share=' + share.toFixed(3));
  }

  // --- 4. unknown contexts fail loudly ------------------------------------------
  {
    let threw = '';
    try { getFanSpec(1, 2, 'bunker'); } catch (e) { threw = e.constructor.name; }
    check('unknown context throws TypeError', threw === 'TypeError', threw);
    check('every listed context resolves a spec',
      FAN_CONTEXTS.every((c) => !!getFanSpec(9, 9, c)), FAN_CONTEXTS.join(','));
  }
} catch (err) {
  console.error('FATAL', err);
  failures++;
} finally {
  await server.close();
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
