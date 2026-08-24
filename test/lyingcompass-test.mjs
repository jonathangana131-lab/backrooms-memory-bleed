/**
 * Lying compass tests (F94) — pure Node, no renderer.
 *
 * Verifies the F94 acceptance proof:
 *   1. clean state exact bearing — no wells, none in range, or contamination
 *      0 all return the true bearing exactly (normalized)
 *   2. bend monotone in contamination over a sweep, landing within the 35° cap
 *      and fully on the well bearing when it sits inside the cap
 *   3. strongest-well selection under multiple wells, including order-stable
 *      strength ties and strength beating proximity
 *   4. out-of-range wells inert — beyond WELL_RANGE_M even huge strength does
 *      nothing; exactly-at-range still counts
 *   5. determinism — repeated calls and independent model instances replay
 *      byte-identical results
 *   6. junk safe — NaN/Infinity positions, strengths, bearings, contamination,
 *      null/undefined wells never throw and always yield finite angles
 *
 * Run: node test/lyingcompass-test.mjs  (prints LYINGCOMPASS ALL PASS, exits 0)
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
  MAX_BEND_DEG,
  WELL_RANGE_M,
  normalizeDeg,
  bearingDeg,
  signedDeltaDeg,
  strongestWell,
  needleAngleDeg,
  LyingCompass,
} = await import('../src/ui/lyingcompass.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const finite = (v) => typeof v === 'number' && isFinite(v);

/** Well at a given bearing (deg) and distance from the origin player. */
const wellAt = (bearingDegIn, dist, strength) => ({
  x: Math.cos((bearingDegIn * Math.PI) / 180) * dist,
  z: Math.sin((bearingDegIn * Math.PI) / 180) * dist,
  strength,
});

// ---------------------------------------------------------------------------
console.log('1. Clean state is exact bearing');
{
  ok(needleAngleDeg(0, 0, 42, [], 0.9) === 42, 'no wells at any contamination reads true bearing');
  const far = [wellAt(120, WELL_RANGE_M + 10, 1e9)];
  ok(needleAngleDeg(0, 0, -73, far, 1) === -73, 'only out-of-range wells reads true bearing');
  ok(needleAngleDeg(0, 0, 200, [wellAt(90, 10, 5)], 0) === -160,
    'contamination 0 returns normalized true bearing (200 → -160)');
  ok(needleAngleDeg(0, 0, -181, [], 0) === 179, '-181 normalizes to 179');
}

// ---------------------------------------------------------------------------
console.log('2. Bend is monotone in contamination, capped at ' + MAX_BEND_DEG + '°');
{
  // Well 20° off the truth, inside the cap: c=1 must land exactly on it.
  const wells = [wellAt(20, 30, 1)];
  let prevOff = -1;
  let monotone = true;
  for (let i = 0; i <= 20; i++) {
    const c = i / 20;
    const angle = needleAngleDeg(0, 0, 0, wells, c);
    const off = Math.abs(angle);
    if (off < prevOff - 1e-12) monotone = false;
    prevOff = off;
    if (i === 0) ok(angle === 0, 'c=0 exact before sweep');
    if (i === 20) {
      ok(near(angle, 20, 1e-9), `c=1 lands exactly on well bearing inside cap (${angle})`);
    }
  }
  ok(monotone, 'deflection magnitude non-decreasing across c sweep 0→1');

  // Well far outside the cap: deflection saturates at exactly 35° at c=1.
  const capped = needleAngleDeg(0, 0, 0, [wellAt(150, 30, 1)], 1);
  ok(near(capped, MAX_BEND_DEG, 1e-9), `far well deflects exactly ${MAX_BEND_DEG}° (${capped})`);
  const halfCapped = needleAngleDeg(0, 0, 0, [wellAt(150, 30, 1)], 0.5);
  ok(near(halfCapped, MAX_BEND_DEG / 2, 1e-9),
    `half contamination gives exactly half the capped bend (${halfCapped})`);
  // Bend direction follows the shortest signed turn.
  const negBend = needleAngleDeg(0, 0, 0, [wellAt(-140, 30, 1)], 1);
  ok(near(negBend, -MAX_BEND_DEG, 1e-9), 'shortest signed turn bends counterclockwise (-35°)');
}

// ---------------------------------------------------------------------------
console.log('3. Strongest-well selection under multiple wells');
{
  const a = wellAt(30, 25, 1);
  const b = wellAt(-60, 25, 4);
  // b is 60° off truth so its pull saturates at the -35° cap; a would land +30.
  ok(near(needleAngleDeg(0, 0, 0, [a, b], 1), -MAX_BEND_DEG, 1e-9),
    'stronger well wins regardless of list order (b first)');
  ok(near(needleAngleDeg(0, 0, 0, [b, a], 1), -MAX_BEND_DEG, 1e-9),
    'stronger well wins regardless of list order (a first)');
  ok(near(needleAngleDeg(0, 0, 0, [a], 1), 30, 1e-9),
    'with only the weak well, needle lands exactly on its bearing');
  // Strength beats proximity: close weak well loses to distant strong one.
  const closeWeak = wellAt(80, 5, 0.5);
  const farStrong = wellAt(-40, 55, 10);
  ok(near(needleAngleDeg(0, 0, 0, [closeWeak, farStrong], 1), -35, 1e-9),
    'distant strong well beats near weak one (cap applied to its bearing)');
  // Exact tie: earliest in the list wins, stably.
  const t1 = wellAt(30, 20, 2);
  const t2 = wellAt(-30, 20, 2);
  ok(near(needleAngleDeg(0, 0, 0, [t1, t2], 1), 30, 1e-9), 'strength tie resolves to earlier well');
  ok(near(strongestWell(0, 0, [t2, t1])?.x ?? NaN, t2.x, 1e-12),
    'strongestWell tie-break matches needle behavior');
  // Strongest-well identity: winner is genuinely the max-strength entry.
  const field = [wellAt(10, 30, 3), wellAt(-70, 15, 7), wellAt(130, 45, 5)];
  const picked = strongestWell(0, 0, field);
  ok(picked !== null && near(picked.strength, 7, 1e-12), 'picked well is the max-strength one');
}

// ---------------------------------------------------------------------------
console.log('4. Out-of-range wells are inert; range edge counts');
{
  const justInside = wellAt(90, WELL_RANGE_M - 0.001, 1e6);
  ok(Math.abs(needleAngleDeg(0, 0, 0, [justInside], 1)) > 0.5,
    'well just inside range pulls the needle');
  const justOutside = wellAt(90, WELL_RANGE_M + 0.001, 1e6);
  ok(needleAngleDeg(0, 0, 0, [justOutside], 1) === 0,
    'well just outside range is inert despite huge strength');
  const exactEdge = wellAt(90, WELL_RANGE_M, 1e6);
  ok(Math.abs(needleAngleDeg(0, 0, 0, [exactEdge], 1)) > 0.5,
    'exactly-at-range well still counts (≤ boundary inclusive)');
  // Mixed: an inert far monster cannot mask an honest nearby well.
  const mixed = needleAngleDeg(0, 0, 0, [wellAt(170, WELL_RANGE_M + 1, 1e9), wellAt(20, 20, 1)], 1);
  ok(near(mixed, 20, 1e-9), 'out-of-range giant does not disturb in-range well pull');
}

// ---------------------------------------------------------------------------
console.log('5. Determinism across calls and instances');
{
  const wells = [wellAt(25, 22, 2.5), wellAt(-95, 40, 6)];
  const seqA = [];
  for (let i = 0; i <= 100; i++) {
    seqA.push(needleAngleDeg(3.5, -8.25, 12.5, wells, i / 100));
  }
  const seqB = [];
  for (let i = 0; i <= 100; i++) {
    seqB.push(needleAngleDeg(3.5, -8.25, 12.5, wells, i / 100));
  }
  ok(JSON.stringify(seqA) === JSON.stringify(seqB), 'pure function replays identically');

  const m1 = new LyingCompass();
  m1.setWells(wells);
  m1.setContamination(0.7);
  const m2 = new LyingCompass();
  m2.setWells(wells.slice());
  m2.setContamination(0.7);
  const r1 = m1.needleAngle(3.5, -8.25, 12.5);
  const r2 = m2.needleAngle(3.5, -8.25, 12.5);
  ok(r1 === r2, 'independent model instances agree bit-for-bit');
  ok(r1 === needleAngleDeg(3.5, -8.25, 12.5, wells, 0.7),
    'model delegates to the pure function exactly');
}

// ---------------------------------------------------------------------------
console.log('6. Junk inputs are safe and finite');
{
  const junkWells = [
    null,
    undefined,
    {},
    { x: NaN, z: 5, strength: 9 },
    { x: 4, z: Infinity, strength: 9 },
    { x: 4, z: 4 },
    { x: 4, z: 4, strength: NaN },
    { x: 4, z: 4, strength: -Infinity },
    { x: 4, z: 4, strength: '9' },
  ];
  let threw = false;
  let allFinite = true;
  try {
    for (const w of junkWells) {
      const v = needleAngleDeg(NaN, NaN, NaN, [w], NaN);
      if (!finite(v)) allFinite = false;
    }
    const v = needleAngleDeg(0, 0, Infinity, junkWells, Infinity);
    if (!finite(v)) allFinite = false;
    strongestWell(NaN, 0, junkWells);
    const junkModel = new LyingCompass();
    junkModel.setWells(undefined);
    junkModel.setContamination(NaN);
    if (!finite(junkModel.needleAngle(0, 0, 15))) allFinite = false;
  } catch {
    threw = true;
  }
  ok(!threw, 'junk wells/positions/bearings never throw');
  ok(allFinite, 'every junk-fed needle reading stays finite');
  ok(needleAngleDeg(0, 0, 10, [{ x: 4, z: 4, strength: '9' }], 0.9) === 10,
    'string-strength well is ignored, truth survives');
  // Non-finite contamination clamps to clean rather than poisoning the needle.
  ok(needleAngleDeg(0, 0, 33, [wellAt(90, 10, 5)], NaN) === 33,
    'NaN contamination reads as clean');
  ok(needleAngleDeg(0, 0, 33, [wellAt(90, 10, 5)], -5) === 33,
    'negative contamination clamps to clean');
  ok(near(needleAngleDeg(0, 0, 33, [wellAt(90, 10, 5)], 42), 68, 1e-9),
    'overshoot contamination clamps to full bend');
  const infModel = new LyingCompass();
  infModel.setContamination(Infinity);
  ok(infModel.needleAngle(0, 0, 5) === 5,
    'model-level Infinity contamination reads as clean');
  // Sanity on helpers.
  ok(normalizeDeg(540) === 180 && normalizeDeg(-180) === 180, 'normalizeDeg lands in (-180, 180]');
  ok(bearingDeg(1, 1) === 45 && bearingDeg(-1, 0) === 180, 'bearingDeg convention (+X 0°, +Z 90°)');
  ok(signedDeltaDeg(170, -170) === 20, 'signedDelta takes the short way around');
  ok(WELL_RANGE_M > 0 && MAX_BEND_DEG === 35, 'constants match spec (max 35° at c=1)');
}

// ---------------------------------------------------------------------------
if (failures === 0) {
  console.log(`LYINGCOMPASS ALL PASS (${check} checks)`);
} else {
  console.error(`LYINGCOMPASS FAILURES: ${failures}/${check}`);
  process.exit(1);
}
