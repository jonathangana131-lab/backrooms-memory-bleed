/**
 * F25 Believer congregation tests.
 *
 * Verifies against src/entities/congregation.ts:
 *   1. formation validity over many seeds: pairwise seat distance >= 0.8 m,
 *      never inside collision radius (2 * ATTENDEE_RADIUS), every ring sits
 *      at its canonical radius from the altar
 *   2. determinism: same seed => byte-identical seats; different seeds differ
 *   3. service phases respect the injected day-phase provider exactly
 *      (idle/gathering/kneel/disperse windows)
 *   4. kneel poses are applied ONLY during the kneel phase
 *   5. gathering walks attendees toward their seats; disperse walks them out
 *   6. dispersal paths avoid the altar: seat->exit segments keep a
 *      >= ALTAR_CLEARANCE margin from the altar point
 *
 * TypeScript sources are transpiled on the fly (same idiom as fauna-test).
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'test', '.congregation-build');

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
transpile('src/entities/congregation.ts', 'src/entities/congregation.js');

const C = await import(join(BUILD, 'src/entities/congregation.js'));

function dist(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}
/** Minimum distance from point P to segment AB. */
function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / len2));
  return dist(px, pz, ax + t * abx, az + t * abz);
}

// ---- 1. formation validity over many seeds ---------------------------------
try {
  let worstPair = Infinity;
  let worstClearance = Infinity;
  let checked = 0;
  for (let seed = 1; seed <= 250; seed++) {
    const count = 3 + (seed % 38);
    const seats = C.generateFormation(10, -4, count, seed * 7919);
    if (seats.length !== count) throw new Error(`seed ${seed}: wanted ${count}, got ${seats.length}`);
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      const r = C.INNER_RING_RADIUS + s.ring * C.RING_GAP;
      if (Math.abs(dist(s.x, s.z, 10, -4) - r) > 1e-9) throw new Error(`seed ${seed} seat ${i} off-ring`);
      if (!Number.isFinite(s.yaw)) throw new Error(`seed ${seed} seat ${i} yaw NaN`);
      worstClearance = Math.min(worstClearance, dist(s.x, s.z, 10, -4));
      for (let j = i + 1; j < seats.length; j++) {
        const d = dist(s.x, s.z, seats[j].x, seats[j].z);
        worstPair = Math.min(worstPair, d);
        checked++;
        if (d < C.MIN_SEAT_DIST - 1e-9) throw new Error(`seed ${seed} pair ${i},${j} too close: ${d.toFixed(4)}`);
        if (d < 2 * C.ATTENDEE_RADIUS) throw new Error(`seed ${seed} pair ${i},${j} overlaps collision radius`);
      }
    }
  }
  check(`formation validity: ${checked} pairs across 250 seeds all >= MIN_SEAT_DIST (${worstPair.toFixed(4)}m worst)`, worstPair >= C.MIN_SEAT_DIST - 1e-9);
  check(`no attendee nearer the altar than INNER_RING_RADIUS (${worstClearance.toFixed(4)}m worst)`, worstClearance >= C.INNER_RING_RADIUS - 1e-9);
} catch (e) {
  check('formation validity over many seeds', false, e.message);
}

// ---- 2. determinism per seed -------------------------------------------------
{
  const a = C.generateFormation(0, 0, 25, 0xc0ffee);
  const b = C.generateFormation(0, 0, 25, 0xc0ffee);
  check('same seed => identical seats', JSON.stringify(a) === JSON.stringify(b));
  let differing = 0;
  for (let k = 1; k <= 10; k++) {
    if (JSON.stringify(C.generateFormation(0, 0, 25, k)) !== JSON.stringify(a)) differing++;
  }
  check(`different seeds jitter formations (${differing}/10 differ)`, differing >= 9);
  check('attendee count is honoured', C.generateFormation(5, 5, 7, 42).length === 7);
}

// ---- 3. phases respect the injected provider ---------------------------------
{
  const table = [
    [0.0, 'idle'], [0.5, 'idle'], [0.79, 'idle'],
    [C.SERVICE_START, 'gathering'], [0.82, 'gathering'],
    [C.KNEEL_START, 'kneel'], [0.9, 'kneel'],
    [C.SERVICE_END, 'disperse'], [0.95, 'disperse'],
    [C.DISPERSE_END, 'idle'], [0.99, 'idle'],
  ];
  let ok = true;
  for (const [p, want] of table) {
    if (C.servicePhaseAt(p) !== want) { ok = false; console.log('  mismatch', p, C.servicePhaseAt(p), 'want', want); }
  }
  check('servicePhaseAt window table', ok);

  let phase = 0.5;
  const cong = new C.Congregation({ centerX: 0, centerZ: 0, count: 8, seed: 11, dayPhase: () => phase });
  const seen = [];
  for (const p of [0.5, C.SERVICE_START + 0.01, C.KNEEL_START + 0.01, C.SERVICE_END + 0.01, C.DISPERSE_END + 0.01]) {
    phase = p;
    cong.update(0.05, () => phase);
    seen.push(cong.phase);
  }
  check(
    'Congregation.update follows provider transitions',
    JSON.stringify(seen) === JSON.stringify(['idle', 'gathering', 'kneel', 'disperse', 'idle']),
    seen.join(','),
  );
}

// ---- 4. kneel poses only during kneel ----------------------------------------
{
  let phase = 0.87; // mid-kneel
  const cong = new C.Congregation({ centerX: 0, centerZ: 0, count: 12, seed: 21, dayPhase: () => phase });
  cong.update(0.05, () => phase);
  const kneeling = cong.attendees.every((a) => a.pose === 'kneel' && a.seated && a.x === a.seat.x);
  check('mid-kneel: every attendee kneels on its seat', kneeling);

  for (const p of [0.5, C.SERVICE_START + 0.02, C.SERVICE_END + 0.02, 0.99]) {
    phase = p;
    cong.update(0.05, () => phase);
    if (cong.attendees.some((a) => a.pose === 'kneel')) {
      check(`pose outside kneel phase at dayPhase=${p}`, false, 'found kneel pose');
      break;
    }
  }
  check('no kneel pose in idle/gathering/disperse phases', true);
  // and back into kneel: poses re-apply
  phase = C.KNEEL_START + 0.01;
  cong.update(0.05, () => phase);
  check('re-entering kneel re-applies poses', cong.attendees.every((a) => a.pose === 'kneel'));
}

// ---- 5. gathering approaches / disperse departs ------------------------------
{
  let phase = C.SERVICE_START + 0.01;
  const cong = new C.Congregation({ centerX: 0, centerZ: 0, count: 10, seed: 31, dayPhase: () => phase });
  const startDists = cong.attendees.map((a) => dist(a.x, a.z, a.seat.x, a.seat.z));
  for (let i = 0; i < 120; i++) cong.update(0.5, () => phase); // 60 s of walking
  const endDists = cong.attendees.map((a) => dist(a.x, a.z, a.seat.x, a.seat.z));
  check(
    'gathering moves attendees to their seats',
    endDists.every((d) => d < 0.05) && startDists.every((d, i) => d > endDists[i]),
  );

  phase = C.SERVICE_END + 0.01; // disperse
  const atSeat = cong.attendees.map((a) => ({ x: a.x, z: a.z }));
  for (let i = 0; i < 240; i++) cong.update(0.5, () => phase); // 120 s of walking
  const goneOut = cong.attendees.filter((a, i) => {
    const exit = cong.exitTarget(i);
    return dist(a.x, a.z, exit.x, exit.z) < 0.05 && dist(a.x, a.z, atSeat[i].x, atSeat[i].z) > C.RAY_STANDOFF - 0.1;
  }).length;
  check('dispersal walks attendees out along their rays', goneOut === cong.attendees.length, `${goneOut}/${cong.attendees.length}`);
}

// ---- 6. dispersal paths avoid the altar --------------------------------------
try {
  let worst = Infinity;
  for (let seed = 1; seed <= 250; seed++) {
    const cong = new C.Congregation({ centerX: 3, centerZ: 7, count: 5 + (seed % 30), seed: seed * 104729, dayPhase: () => 0 });
    for (let i = 0; i < cong.seats.length; i++) {
      const s = cong.seats[i];
      const e = cong.exitTarget(i);
      worst = Math.min(worst, segDist(3, 7, s.x, s.z, e.x, e.z));
      // entry ray too: stand-off point -> seat
      const entry = rayStandoff(s, 3, 7);
      worst = Math.min(worst, segDist(3, 7, entry.x, entry.z, s.x, s.z));
    }
  }
  function rayStandoff(s, ax, az) {
    const dx = s.x - ax, dz = s.z - az;
    const d = Math.hypot(dx, dz);
    const k = (d + C.RAY_STANDOFF) / d;
    return { x: ax + dx * k, z: az + dz * k };
  }
  check(`entry+exit paths keep >= INNER_RING_RADIUS from the altar (${worst.toFixed(4)}m worst)`, worst >= C.INNER_RING_RADIUS - 1e-9);
} catch (e) {
  check('dispersal paths avoid the altar', false, e.message);
}

console.log(failures.length === 0 ? `ALL PASS (${passed} checks)` : `${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
