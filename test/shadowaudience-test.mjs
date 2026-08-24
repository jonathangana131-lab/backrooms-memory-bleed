/**
 * F70 Shadow audience tests.
 *
 * Verifies against src/entities/shadowaudience.ts:
 *   1. gather/scatter gating (the AC): across 300 simulated peaks,
 *      an audience exists exactly while tension holds the peak and
 *      never outside it
 *   2. scatter is exact: a tension drop empties the set on that very
 *      tick; walking within R of a silhouette removes exactly that one
 *      on that very tick, and a mid-peak approach wipeout does not
 *      re-gather until tension has left the band
 *   3. count is monotone in peak depth band (constant-depth peaks)
 *   4. determinism per seed: identical seed + inputs reproduce byte-equal
 *      silhouette timelines; different seeds differ somewhere
 *   5. bounded alive set: never more than maxCount alive on any tick
 *
 * TypeScript sources are transpiled on the fly (same idiom as
 * hymn-test).
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.shadowaudience-build');

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
transpile('src/entities/shadowaudience.ts', 'src/entities/shadowaudience.js');

const { ShadowAudience } = await import(join(BUILD, 'src/entities/shadowaudience.js'));

// Six hall ends spread around the origin; player roams near the middle.
const ENDS = [
  { x: -40, z: -40 }, { x: 40, z: -40 }, { x: -40, z: 40 },
  { x: 40, z: 40 }, { x: 0, z: -60 }, { x: 0, z: 60 },
];
const THRESHOLD = 0.8;
const DT = 1 / 30;

/** Build an audience whose tension comes from a mutable holder. */
function make(seed, opts = {}) {
  const state = { t: 0 };
  const audience = new ShadowAudience(() => state.t, ENDS, seed, { gatherThreshold: THRESHOLD, ...opts });
  return { audience, state };
}

// ---------------------------------------------------------------------------
// 1. Gather iff peak across 300 simulated peaks
// ---------------------------------------------------------------------------
{
  // 300 peaks of varying depth separated by calm valleys; tension ramps so
  // crossings pass through the threshold rather than jumping it.
  let okGatheredDuringPeak = true;
  let okEmptyOutsidePeak = true;
  let gatherCount = 0;
  const { audience, state } = make(12345);
  let px = 0, pz = 0;
  for (let p = 0; p < 300; p++) {
    const depth = 0.82 + ((p * 7919) % 100) / 100 * 0.18;
    // valley: tension well below threshold
    for (let i = 0; i < 20; i++) {
      state.t = 0.3;
      px += 0.05; pz -= 0.03;
      audience.update(DT, px, pz);
      if (audience.gathered) okEmptyOutsidePeak = false;
    }
    // rise
    for (let i = 0; i < 10; i++) {
      state.t = 0.3 + (THRESHOLD - 0.3) * ((i + 1) / 10);
      audience.update(DT, px, pz);
      if (state.t < THRESHOLD && audience.gathered) okGatheredDuringPeak = false;
    }
    // hold the peak
    let sawCrowd = false;
    for (let i = 0; i < 30; i++) {
      state.t = depth;
      audience.update(DT, px, pz);
      if (audience.gathered) sawCrowd = true;
    }
    if (!sawCrowd) okGatheredDuringPeak = false;
    // fall back under the threshold
    for (let i = 0; i < 10; i++) {
      state.t = THRESHOLD - (THRESHOLD - 0.3) * ((i + 1) / 10);
      audience.update(DT, px, pz);
      if (state.t < THRESHOLD && audience.gathered) okEmptyOutsidePeak = false;
    }
    if (audience.gathered || sawCrowd) gatherCount++;
  }
  check('300 peaks: audience present through every held peak', okGatheredDuringPeak && gatherCount === 300, `gathered peaks=${gatherCount}`);
  check('300 peaks: audience empty whenever tension is below threshold', okEmptyOutsidePeak);
}

// ---------------------------------------------------------------------------
// 2a. Scatter exact on tension drop
// ---------------------------------------------------------------------------
{
  const { audience, state } = make(777);
  state.t = 1.0;
  audience.update(DT, 0, 0);
  const before = audience.silhouettes.length;
  check('precondition: peak gathers a crowd', before > 0, `count=${before}`);
  state.t = THRESHOLD - 0.01;
  audience.update(DT, 0, 0);
  check('tension drop scatters everyone on that very tick', !audience.gathered && audience.silhouettes.length === 0);
}

// ---------------------------------------------------------------------------
// 2b. Scatter exact on direct approach (+ mid-peak wipeout does not re-gather)
// ---------------------------------------------------------------------------
{
  const { audience, state } = make(888);
  state.t = 0.95;
  audience.update(DT, 0, 0);
  const crowd = [...audience.silhouettes];
  check('precondition: multiple silhouettes for approach test', crowd.length >= 2, `count=${crowd.length}`);
  // Stand exactly on the nearest silhouette.
  const victim = crowd.reduce((a, b) => (b.x * b.x + b.z * b.z < a.x * a.x + a.z * a.z ? b : a));
  audience.update(DT, victim.x, victim.z);
  const ids = new Set(audience.silhouettes.map((s) => s.id));
  check('approach within R removes exactly the approached silhouette on that very tick', !ids.has(victim.id) && ids.size === crowd.length - 1);
  // Walk into every remaining one while tension stays high: no re-gather mid-peak.
  let wipedClean = true;
  for (const s of crowd) {
    audience.update(DT, s.x, s.z);
  }
  wipedClean = !audience.gathered;
  let regatheredEarly = false;
  for (let i = 0; i < 120; i++) {
    audience.update(DT, 0, 0); // tension still 0.95 >= threshold
    if (audience.gathered) regatheredEarly = true;
  }
  check('mid-peak approach wipeout leaves no instant re-gather while tension holds', wipedClean && !regatheredEarly);
}

// ---------------------------------------------------------------------------
// 3. Count monotone in peak depth band
// ---------------------------------------------------------------------------
{
  const bands = [0.8, 0.84, 0.88, 0.92, 0.96, 1.0];
  const counts = [];
  for (const depth of bands) {
    const { audience, state } = make(4242);
    state.t = depth;
    audience.update(DT, 0, 0);
    audience.update(DT, 0, 0); // settle any growth target
    counts.push(audience.silhouettes.length);
  }
  let monotone = true;
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[i - 1]) monotone = false;
  check('steady count non-decreasing over depth bands ' + JSON.stringify(counts), monotone);
  check('threshold-edge peak yields exactly one silhouette', counts[0] === 1);
  check('full-saturation peak yields maxCount silhouettes', counts[counts.length - 1] === 6);
}

// ---------------------------------------------------------------------------
// 4. Determinism per seed
// ---------------------------------------------------------------------------
{
  const run = (seed) => {
    const { audience, state } = make(seed);
    const trace = [];
    let px = 0, pz = 0;
    for (let p = 0; p < 12; p++) {
      for (let i = 0; i < 15; i++) { state.t = 0.2; audience.update(DT, px, pz); }
      for (let i = 0; i < 25; i++) { state.t = 0.85 + (p % 4) * 0.05; px += 0.1; audience.update(DT, px, pz); }
      for (const s of audience.silhouettes) trace.push(`${s.id}:${s.x.toFixed(6)},${s.z.toFixed(6)}:${s.yaw.toFixed(6)}`);
    }
    return trace.join('|');
  };
  const a = run(31337), b = run(31337), c = run(31338);
  check('same seed reproduces a byte-identical multi-peak timeline', a === b);
  check('different seeds produce different gathering timelines', a !== c);
}

// ---------------------------------------------------------------------------
// 5. Bounded alive set
// ---------------------------------------------------------------------------
{
  const MAXC = 5;
  const { audience, state } = make(999, { maxCount: MAXC });
  let worst = 0;
  let px = 0, pz = 0;
  // Long mixed timeline: oscillating tension plus wandering player.
  for (let i = 0; i < 6000; i++) {
    state.t = 0.5 + 0.5 * Math.sin(i * 0.01);
    px += Math.cos(i * 0.37) * 0.4;
    pz += Math.sin(i * 0.29) * 0.4;
    audience.update(DT, px, pz);
    worst = Math.max(worst, audience.silhouettes.length);
  }
  check(`alive set bounded by maxCount=${MAXC} across 6000 ticks`, worst <= MAXC, `worst=${worst}`);
}

// ---------------------------------------------------------------------------

console.log(`\nshadowaudience: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
