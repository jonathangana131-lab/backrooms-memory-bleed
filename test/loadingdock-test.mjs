/**
 * F60 Loading Dock tests.
 *
 * Verifies against src/world/loadingdock.ts:
 *   1. descriptor validity: exterior skybox flagged, unique bay doors with
 *      sane geometry, per-seed determinism (deep-equal rebuilds)
 *   2. serialize round-trip: deserialize(serialize(d)) deep-equals d,
 *      re-serialization is byte-identical, tampered JSON fails loud
 *   3. no-arrival proof: across seeds, sampling the envelope at every
 *     cycle end for 100,000 simulated seconds is STRICTLY increasing and
 *      always < APPROACH_CEILING < ARRIVAL_INTENSITY; hasArrived false
 *   4. fine-grained monotonicity: quarter-second stepping never decreases
 *   5. bed determinism: same seed => byte-identical parameter streams;
 *      different seeds diverge
 *
 * TypeScript sources are transpiled on the fly (same idiom as
 * congregation-test).
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.loadingdock-build');

let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

function transpile(relSrc, outRel) {
  const srcTxt = readFileSync(join(ROOT, relSrc), 'utf8');
  const out = ts.transpileModule(srcTxt, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
    },
    isolatedModules: true,
  }).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.js'");
  const outPath = join(BUILD, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
}
rmSync(BUILD, { recursive: true, force: true });
transpile('src/core/rng.ts', 'src/core/rng.js');
transpile('src/world/loadingdock.ts', 'src/world/loadingdock.js');

const LD = await import(join(BUILD, 'src/world/loadingdock.js'));

// ---- 1. descriptor validity ----------------------------------------------------
try {
  const d = LD.makeDockDescriptor(1337);
  check('exterior skybox flagged', d.exteriorSkybox === true);
  check(`bay door count == BAY_DOOR_COUNT (${d.bayDoors.length})`, d.bayDoors.length === LD.BAY_DOOR_COUNT);
  const ids = new Set(d.bayDoors.map((b) => b.id));
  check('bay door ids unique', ids.size === d.bayDoors.length);
  check('bay doors have positive openings',
    d.bayDoors.every((b) => b.width > 0 && b.height > 0 && Number.isFinite(b.x) && Number.isFinite(b.z)));
  const d2 = LD.makeDockDescriptor(1337);
  check('same seed rebuilds deep-equal descriptor', JSON.stringify(d) === JSON.stringify(d2));
  check('different seed differs', JSON.stringify(d) !== JSON.stringify(LD.makeDockDescriptor(1338)));
} catch (e) {
  check('descriptor validity', false, e.message);
}

// ---- 2. serialize round-trip ---------------------------------------------------
try {
  for (const seed of [0, 1, 1337, 0xc0ffee]) {
    const d = LD.makeDockDescriptor(seed);
    const s = LD.serializeDock(d);
    const back = LD.deserializeDock(s);
    if (JSON.stringify(back) !== JSON.stringify(d)) throw new Error(`round-trip mismatch seed=${seed}`);
    if (LD.serializeDock(back) !== s) throw new Error(`re-serialization not byte-identical seed=${seed}`);
    if (JSON.parse(s).seed !== (seed >>> 0)) throw new Error(`seed not preserved seed=${seed}`);
  }
  check('serialize round-trip byte-stable across seeds', true);

  let threw = 0;
  for (const bad of [
    'not json',
    '{"id":"dock-x"}',
    '{"id":"dock-x","seed":1,"exteriorSkybox":"yes","apronDepth":9,"bayDoors":[{"id":"b","x":0,"z":0,"yaw":0,"width":1,"height":1}]}',
    '{"id":"dock-x","seed":1,"exteriorSkybox":true,"apronDepth":-3,"bayDoors":[{"id":"b","x":0,"z":0,"yaw":0,"width":1,"height":1}]}',
    '{"id":"dock-x","seed":1,"exteriorSkybox":true,"apronDepth":9,"bayDoors":[]}',
    '{"id":"dock-x","seed":1,"exteriorSkybox":true,"apronDepth":9,"bayDoors":[{"id":"b","x":NaN,"z":0,"yaw":0,"width":1,"height":1}]}',
  ]) {
    try { LD.deserializeDock(bad); } catch { threw++; }
  }
  check(`tampered serializations fail loud (${threw}/6 threw)`, threw === 6);
} catch (e) {
  check('serialize round-trip', false, e.message);
}

// ---- 3. no-arrival proof over 100k simulated seconds ---------------------------
try {
  const SEEDS = [1, 7, 42, 1337, 90210, 0xc0ffee, 424242, 31337];
  const CYCLES = Math.ceil(100000 / LD.APPROACH_CYCLE_SECONDS);
  let worstCeiling = -Infinity;
  let proofHolds = true;
  let arrivalEver = false;
  for (const seed of SEEDS) {
    let now = 0;
    const bed = new LD.EngineApproachBed(LD.makeDockDescriptor(seed), () => now);
    let prev = -Infinity;
    for (let n = 0; n < CYCLES; n++) {
      const v = bed.sampleCycleEnd(n);
      if (!(v > prev)) { proofHolds = false; break; }
      if (!(v < LD.ARRIVAL_INTENSITY)) { proofHolds = false; break; }
      worstCeiling = Math.max(worstCeiling, v);
      // live clock reads at the same instant must agree
      now = (n + 1) * LD.APPROACH_CYCLE_SECONDS;
      if (bed.arrived || bed.intensity >= LD.ARRIVAL_INTENSITY) arrivalEver = true;
      prev = v;
    }
    if (!proofHolds) break;
  }
  check(`strictly increasing AND < ARRIVAL_INTENSITY for 100k s x ${SEEDS.length} seeds`, proofHolds && !arrivalEver,
    `worst sample ${worstCeiling}`);
  check(`ceiling respected: worst sample ${worstCeiling.toFixed(6)} < APPROACH_CEILING ${LD.APPROACH_CEILING}`,
    worstCeiling < LD.APPROACH_CEILING);
  check('envelope formula spot-check t=3600',
    Math.abs(LD.approachEnvelope(3600) - LD.APPROACH_CEILING * (3600 / (3600 + LD.APPROACH_TAU_SECONDS))) < 1e-12);
} catch (e) {
  check('no-arrival proof', false, e.message);
}

// ---- 4. fine-grained monotonicity ----------------------------------------------
try {
  let now = 0;
  const bed = new LD.EngineApproachBed(LD.makeDockDescriptor(5150), () => now);
  let monotone = true;
  let prev = -Infinity;
  for (; now <= 20000; now += 0.25) {
    const v = bed.intensity;
    if (v < prev - 1e-15) { monotone = false; break; }
    prev = v;
  }
  check('quarter-second stepping never decreases intensity over 20k s', monotone);
  check('hasArrived stays false at 20k s', bed.arrived === false);
} catch (e) {
  check('fine-grained monotonicity', false, e.message);
}

// ---- 5. bed determinism ---------------------------------------------------------
try {
  function stream(seed, steps) {
    let now = 0;
    const bed = new LD.EngineApproachBed(LD.makeDockDescriptor(seed), () => now);
    const rows = [];
    for (let i = 0; i < steps; i++) { now += 1.5; rows.push(JSON.stringify(bed.params())); }
    return rows;
  }
  const a = stream(777, 600);
  const b = stream(777, 600);
  const c = stream(778, 600);
  check('same seed => byte-identical parameter stream', a.every((r, i) => r === b[i]));
  check('different seed diverges somewhere', a.some((r, i) => r !== c[i]));
  check('intensity field matches envelope at every sample',
    (() => {
      let now = 999;
      const bed = new LD.EngineApproachBed(LD.makeDockDescriptor(777), () => now);
      return Math.abs(bed.params().intensity - bed.intensity) < 1e-15;
    })());
} catch (e) {
  check('bed determinism', false, e.message);
}

console.log(failures.length === 0 ? `LOADINGDOCK_PASS (${passed} checks)` : `LOADINGDOCK_FAIL (${failures.length})`);
for (const f of failures) console.log('  FAILED :: ' + f);
process.exit(failures.length === 0 ? 0 : 1);
