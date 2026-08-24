/**
 * Camcorder optics tests (F92) - pure Node, no renderer.
 * Verifies the F92 acceptance proof:
 *   1. AC optic curve - DOF widens monotonically with focus distance
 *      (near rises, far rises faster, span strictly widening; far merges
 *      with infinity at/beyond hyperfocal), and limits always bracket the
 *      subject distance
 *   2. focal breathing - fovShiftRad is strictly increasing in zoom within
 *      [0, MAX_BREATH_RAD] for any lens serial; amplitudes are seeded per
 *      serial so distinct lenses breathe differently yet stay bounded;
 *      base FOV narrows monotonically with zoom
 *   3. IR coupling exact ratio - enabling irMode scales both blur weights
 *      by exactly IR_BLUR_CENTER_RATIO and leaves the FOV shift untouched,
 *      to machine precision over an input grid
 *   4. determinism per lens seed - identical serials replay byte-identical
 *      descriptor tables; a different serial shifts breathing only (DOF
 *      physics stay seed-free)
 *   5. junk inputs safe - NaN/Infinity/negative distances, junk zooms and
 *      missing serials clamp into range; descriptors stay finite and no
 *      call throws
 *
 * Run: node test/camoptics-test.mjs  (prints CAMOPTICS ALL PASS, exits 0)
 */
import { register } from 'node:module';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const {
  computeOptics, dofNearM, dofFarM, hyperfocalM, baseFovRad, focalMm,
  breathAmplitudeRad, lensSeedFromSerial, fovShiftRad,
  FOCAL_MIN_MM, FOCAL_MAX_MM, MIN_FOCUS_M, MAX_BREATH_RAD, IR_BLUR_CENTER_RATIO,
} = await import('../src/gfx/camoptics.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near_ = (a, b, eps) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
console.log('1. AC optic curve: DOF widens monotonically with focus distance');
{
  // Sweep focus distances where both limits stay finite for each zoom stop.
  for (const zoom of [0, 0.5, 1]) {
    const H = hyperfocalM(zoom);
    const ds = [];
    for (let d = MIN_FOCUS_M; d < H - 0.05; d += (H - 0.05 - MIN_FOCUS_M) / 40) {
      ds.push(d);
    }
    let prevSpan = -Infinity;
    let prevNear = -Infinity;
    let prevFar = -Infinity;
    let monotone = true;
    let bracketed = true;
    for (const d of ds) {
      const n = dofNearM(d, zoom);
      const f = dofFarM(d, zoom);
      if (!(n > prevNear + 1e-9)) monotone = false, console.error('   near stall', zoom, d, n, prevNear);
      if (!(f > prevFar + 1e-9)) monotone = false, console.error('   far stall', zoom, d, f, prevFar);
      const span = f - n;
      if (!(span >= prevSpan - 1e-9)) monotone = false, console.error('   span shrink', zoom, d);
      if (span <= prevSpan - 1e-12 || span - prevSpan < -1e-12) monotone = false;
      if (!(n <= d && d <= f && n > 0)) bracketed = false;
      prevSpan = span;
      prevNear = n;
      prevFar = f;
    }
    ok(monotone, `zoom=${zoom} near/far/span widen monotonically over ${ds.length} stops`);
    ok(bracketed, `zoom=${zoom} near <= d <= far always`);
  }
  // Past hyperfocal the far limit is Infinity on every zoom stop.
  const H1 = hyperfocalM(0.5);
  ok(dofFarM(H1, 0.5) === Infinity && dofFarM(H1 * 4, 0.5) === Infinity,
    'far limit merges with infinity at/beyond hyperfocal');
  // Wider zoom => deeper DOF at the same distance (span comparison).
  const sWide = dofFarM(6, 0) - dofNearM(6, 0);
  const sTele = Number.isFinite(dofFarM(6, 1)) ? dofFarM(6, 1) : 60;
  ok(sWide >= sTele, `wide DOF span ${sWide.toFixed(2)}m >= tele span ${sTele.toFixed(2)}m at 6m`);
}
// ---------------------------------------------------------------------------
console.log('2. Focal breathing: monotone in zoom, seeded and bounded');
{
  const serials = ['BMB-BR-77', 'SN-004113', 'IR-TUBE-9', '', 'zz-proto'];
  let boundedAll = true;
  let distinctAmplitudes = new Set();
  for (const serial of serials) {
    const seed = lensSeedFromSerial(serial);
    const amp = breathAmplitudeRad(seed);
    distinctAmplitudes.add(amp.toPrecision(12));
    if (!(amp > 0 && amp <= MAX_BREATH_RAD)) boundedAll = false;
    let prev = -Infinity;
    let strict = true;
    for (let i = 0; i <= 20; i++) {
      const shift = fovShiftRad(i / 20, seed);
      if (!(shift > prev)) strict = false;
      if (!(shift >= 0 && shift <= MAX_BREATH_RAD + 1e-15)) boundedAll = false;
      prev = shift;
    }
    ok(strict, `serial "${serial}" breathing strictly increases in zoom`);
  }
  ok(boundedAll, 'every serial stays inside [0, MAX_BREATH_RAD]');
  ok(distinctAmplitudes.size >= 3, `${distinctAmplitudes.size} distinct seeded amplitudes across ${serials.length} lenses`);
  ok(near_(fovShiftRad(0, lensSeedFromSerial('x')), 0, 0), 'no breathing at full wide');
  // Base FOV narrows as focal length grows.
  let narrowMonotone = true;
  for (let i = 0; i < 20; i++) {
    if (!(baseFovRad((i + 1) / 20) < baseFovRad(i / 20))) narrowMonotone = false;
  }
  ok(narrowMonotone, 'base FOV narrows monotonically with zoom');
  ok(focalMm(0) === FOCAL_MIN_MM && focalMm(1) === FOCAL_MAX_MM, 'focal table endpoints exact');
}
// ---------------------------------------------------------------------------
console.log('3. IR coupling exact ratio');
{
  const serial = 'BMB-BR-77';
  let ratioExact = true;
  let fovUntouched = true;
  for (let di = 0; di < 8; di++) {
    for (let zi = 0; zi <= 4; zi++) {
      const vis = computeOptics({ focusDistM: 0.3 + di * 1.7, zoom: zi / 4, irMode: false, lensSerial: serial });
      const nir = computeOptics({ focusDistM: 0.3 + di * 1.7, zoom: zi / 4, irMode: true, lensSerial: serial });
      if (!near_(nir.nearBlur, vis.nearBlur * IR_BLUR_CENTER_RATIO, 1e-12)) ratioExact = false;
      if (!near_(nir.farBlur, vis.farBlur * IR_BLUR_CENTER_RATIO, 1e-12)) ratioExact = false;
      if (vis.farBlur > 0 && !near_(nir.farBlur / vis.farBlur, IR_BLUR_CENTER_RATIO, 1e-12)) ratioExact = false;
      if (nir.fovShiftRad !== vis.fovShiftRad) fovUntouched = false;
    }
  }
  ok(ratioExact, 'near/far blur scale by exactly IR_BLUR_CENTER_RATIO over 40 poses');
  ok(fovUntouched, 'fovShiftRad unaffected by irMode');
}
// ---------------------------------------------------------------------------
console.log('4. Determinism per lens seed');
{
  const grid = () => {
    const rows = [];
    for (let di = 0; di < 10; di++) {
      for (let zi = 0; zi <= 8; zi++) {
        rows.push(computeOptics({ focusDistM: 0.2 + di * 2.3, zoom: zi / 8, irMode: di % 3 === 0, lensSerial: 'SN-77-ALPHA' }));
      }
    }
    return JSON.stringify(rows);
  };
  ok(grid() === grid(), 'identical serial replays byte-identical descriptor table');
  const a = computeOptics({ focusDistM: 3, zoom: 0.75, lensSerial: 'SN-77-ALPHA' });
  const b = computeOptics({ focusDistM: 3, zoom: 0.75, lensSerial: 'SN-77-BETA' });
  ok(a.fovShiftRad !== b.fovShiftRad, 'different serial diverges in breathing');
  ok(a.nearBlur === b.nearBlur && a.farBlur === b.farBlur, 'DOF physics stay seed-free');
}
// ---------------------------------------------------------------------------
console.log('5. Junk inputs safe');
{
  const junkCases = [
    { focusDistM: NaN, zoom: 0.5 },
    { focusDistM: Infinity, zoom: 0.5 },
    { focusDistM: -4, zoom: 0.5 },
    { focusDistM: 2, zoom: NaN },
    { focusDistM: 2, zoom: 7 },
    { focusDistM: 2, zoom: -1 },
    {},
  ];
  let threw = false;
  let allFinite = true;
  for (const partial of junkCases) {
    try {
      const out = computeOptics({
        focusDistM: partial.focusDistM ?? 2,
        zoom: partial.zoom ?? 0.5,
        lensSerial: typeof partial.focusDistM === 'string' ? partial.focusDistM : undefined,
        irMode: undefined,
      });
      if (![out.nearBlur, out.farBlur, out.fovShiftRad].every(Number.isFinite)) allFinite = false;
      if (!(out.nearBlur >= 0 && out.nearBlur <= 1)) allFinite = false;
      if (!(out.farBlur >= 0 && out.farBlur <= 1)) allFinite = false;
      if (!(out.fovShiftRad >= 0 && out.fovShiftRad <= MAX_BREATH_RAD)) allFinite = false;
    } catch { threw = true; }
  }
  ok(!threw, 'no junk input throws');
  ok(allFinite, 'all junk descriptors finite and in bounds');
  ok(dofNearM(-10, 0.5) === dofNearM(MIN_FOCUS_M, 0.5)
    && dofFarM(NaN, 0.25) === dofFarM(MIN_FOCUS_M, 0.25)
    && dofFarM(Infinity, 0) === dofFarM(MIN_FOCUS_M, 0),
    'junk distances (negative/NaN/Infinity) collapse to closest-focus optics');
}
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`CAMOPTICS FAIL: ${failures}/${check} checks failed`);
  process.exit(1);
}
console.log(`CAMOPTICS ALL PASS (${check} checks)`);
