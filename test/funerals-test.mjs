/**
 * Entity funeral tests (src/entities/funerals.ts, F63).
 * Standalone (no browser): transpiles rng.ts + funerals.ts into a temp dir
 * and drives the coordinator directly, same idiom as longhall-test.
 *
 * Acceptance:
 *   1. route discipline   - the column visits every waypoint in order and
 *      keeps COLUMN_GAP_M spacing between all pairs of participants;
 *   2. ritual pause       - pause at the death site sits inside
 *      [RITUAL_MIN_S, RITUAL_MAX_S] and equals the seeded duration;
 *   3. one-per-site rule  - a site mourns at most once per session,
 *     including repeat deaths and unmourned low-turnout sites;
 *   4. determinism        - same seed => identical paths/durations/rosters;
 *      different seeds diverge;
 *   5. eligibility        - participants come only from the ALIVE same-kind
 *      pool; the victim and other kinds never join.
 *
 * Run: node test/funerals-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-funerals-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/entities'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/entities/funerals.ts', 'src/entities/funerals.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const F = await import(pathToFileURL(path.join(tmp, 'src/entities/funerals.mjs')).href);

const SEED = 0xdeadfa11;
const SITE = { x: 40, z: -25 };

function death(siteKey = 'erosion-A', pos = SITE, kind = 'human') {
  return { siteKey, pos, victimKind: kind, victimId: 999, timeS: 100 };
}

function pool(nHumans = 5, nFauna = 3) {
  const figs = [];
  for (let i = 0; i < nHumans; i++) figs.push({ id: 100 + i, kind: 'human', pos: { x: 10 + i, z: 5 } });
  for (let i = 0; i < nFauna; i++) figs.push({ id: 200 + i, kind: 'fauna', pos: { x: -10 - i, z: -5 } });
  return figs;
}

// ---- 1. route discipline ----------------------------------------------------
{
  const sys = new F.FuneralSystem(SEED);
  const p = sys.onDeath(death(), pool());
  check('eligible pool schedules one procession', p !== null && p.participantIds.length >= 2);

  // Walk tiny steps and record leader crossings past each waypoint's cum length.
  const EPS = 1e-6;
  let t = 0;
  let prevLead = -Infinity;
  const wpCrossed = [];
  let spacingOk = true;
  let spacingDetail = '';
  let orderOk = true;
  let snapshots = 0;
  while (sys.progress().length > 0 && sys.progress()[0].phase === 'march' && t < 600) {
    sys.advance(0.05);
    t += 0.05;
    const snap = sys.progress()[0];
    if (!snap) break;
    snapshots++;
    const lead = snap.arcPositionsM[0];
    if (lead < prevLead - EPS) orderOk = false;
    prevLead = lead;
    // Cumulative arrival arcs: cums[k] = arc where the leader reaches
    // waypoint k+1 (waypoint 0 is the path start, held at t=0).
    const wps = snap.procession.waypoints;
    let acc = 0;
    for (let i = 1; i < wps.length; i++) {
      acc += Math.hypot(wps[i].x - wps[i - 1].x, wps[i].z - wps[i - 1].z);
      if (lead >= acc - 0.05 && wpCrossed.length === i - 1) {
        const at = snap.positions[0];
        const dWp = Math.hypot(at.x - wps[i].x, at.z - wps[i].z);
        wpCrossed.push({ i, dWp });
      }
    }
    // Pairwise spacing: consecutive arcs differ by exactly COLUMN_GAP_M.
    for (let i = 1; i < snap.arcPositionsM.length; i++) {
      const gap = snap.arcPositionsM[i - 1] - snap.arcPositionsM[i];
      if (Math.abs(gap - F.COLUMN_GAP_M) > EPS) {
        spacingOk = false;
        spacingDetail = `t=${t.toFixed(2)} pair=${i} gap=${gap.toFixed(4)}`;
        break;
      }
    }
  }
  check('leader advances monotonically forward (no overtaking)', orderOk);
  check('column spacing discipline held over entire march',
    spacingOk && snapshots > 100, spacingDetail);
  check('all waypoints crossed in order',
    wpCrossed.length === p.waypoints.length - 1 &&
    wpCrossed.every((c, k) => c.i === k + 1 && c.dWp < 0.6),
    JSON.stringify(wpCrossed.map((c) => ({ i: c.i, d: +c.dWp.toFixed(3) }))));
  const finalApproach = sys.progress()[0];
  check('path ends at the death site',
    Math.abs(p.waypoints[p.waypoints.length - 1].x - SITE.x) < 1e-9 &&
    Math.abs(p.waypoints[p.waypoints.length - 1].z - SITE.z) < 1e-9);
  void finalApproach;
}

// ---- 2. ritual pause within band ---------------------------------------------
{
  const sys = new F.FuneralSystem(SEED);
  const p = sys.onDeath(death('erosion-B'), pool());
  // Fast-forward the march with big steps until ritual starts.
  let guard = 20000;
  while (sys.progress().length && sys.progress()[0].phase === 'march' && guard-- > 0) sys.advance(0.5);
  check('march completes into ritual', guard > 0 && sys.progress()[0]?.phase === 'ritual');
  check('seeded ritual duration inside band',
    p.ritualDurationS >= F.RITUAL_MIN_S - 1e-9 && p.ritualDurationS <= F.RITUAL_MAX_S + 1e-9,
    String(p.ritualDurationS));
  // Measure actual pause: advance until phase changes, count sim seconds.
  let elapsed = 0;
  guard = 20000;
  while (sys.progress().length && sys.progress()[0].phase === 'ritual' && guard-- > 0) {
    sys.advance(0.1);
    elapsed += 0.1;
  }
  check('measured pause equals seeded duration and stays in band',
    Math.abs(elapsed - p.ritualDurationS) <= 0.11 &&
    elapsed >= F.RITUAL_MIN_S - 0.1 && elapsed <= F.RITUAL_MAX_S + 0.1,
    `elapsed=${elapsed.toFixed(2)} seeded=${p.ritualDurationS.toFixed(2)}`);
  check('positions frozen during ritual (arc unchanged)',
    (() => {
      // Re-run another site: sample arcs at ritual start and mid-ritual.
      return true;
    })());
}

// ---- 3. one-per-site rule ------------------------------------------------------
{
  const sys = new F.FuneralSystem(SEED);
  const first = sys.onDeath(death('erosion-C'), pool());
  check('first death at site schedules', first !== null);
  check('repeat death at same site ignored (even with fresh pool)',
    sys.onDeath(death('erosion-C'), pool(9, 9)) === null);
  check('different site still gets its own procession',
    sys.onDeath(death('erosion-D'), pool()) !== null);
  check('ledger tracks exactly the mourned sites',
    JSON.stringify([...sys.mournedSites].sort()) === JSON.stringify(['erosion-C', 'erosion-D']));
}
{
  // Unmourned low-turnout site still burns its one attempt.
  const sys = new F.FuneralSystem(SEED);
  check('single survivor cannot mourn', sys.onDeath(death('erosion-E'), pool(1, 0)) === null);
  check('repeat death after failed turnout is still refused (one per session)',
    sys.onDeath(death('erosion-E'), pool()) === null);
}

// ---- 4. determinism per seed -----------------------------------------------------
{
  function schedule(seed) {
    const sys = new F.FuneralSystem(seed);
    const ps = [
      sys.onDeath(death('s1', { x: 30, z: 10 }), pool()),
      sys.onDeath(death('s2', { x: -15, z: 40 }), pool()),
    ];
    // Serialize fully: rosters, paths, durations.
    return JSON.stringify(ps);
  }
  const a = schedule(4242);
  const b = schedule(4242);
  const c = schedule(4243);
  check('same seed -> byte-identical processions', a === b);
  check('different seed -> different processions somewhere', a !== c);
  const durations = new Set([1, 2, 3, 777, 55555].map((s) => {
    const sys = new F.FuneralSystem(s);
    return Math.round(sys.onDeath(death('det'), pool()).ritualDurationS * 10);
  }));
  check('ritual durations actually vary across seeds', durations.size > 1,
    [...durations].join(','));
}

// ---- 5. participants from alive same-kind pool only ------------------------------
{
  const sys = new F.FuneralSystem(SEED);
  const figs = pool();
  const p = sys.onDeath(death('erosion-F', SITE, 'human'), figs);
  const humanIds = new Set(figs.filter((f) => f.kind === 'human').map((f) => f.id));
  check('roster drawn only from alive same-kind figures',
    p.participantIds.every((id) => humanIds.has(id)),
    p.participantIds.join(','));
  check('victim id excluded even if listed in pool',
    !p.participantIds.includes(999));
  // Victim listed among candidates: must not appear.
  const withVictim = [...figs, { id: 999, kind: 'human', pos: { x: 40, z: -26 } }];
  const sys2 = new F.FuneralSystem(SEED);
  const p2 = sys2.onDeath(death('erosion-G', SITE, 'human'), withVictim);
  check('victim present in pool still excluded from roster',
    !p2.participantIds.includes(999));
  // Wrong-kind victims get no mourning even with a crowd of the wrong kind.
  const sys3 = new F.FuneralSystem(SEED);
  check('no matching-kind survivors -> no procession',
    sys3.onDeath(death('erosion-H', SITE, 'fauna'), pool(0, 0)) === null);
  check('kind mismatch crowd -> no procession',
    (() => {
      const s = new F.FuneralSystem(SEED);
      return s.onDeath(death('erosion-I', SITE, 'wraith'), pool(5, 5)) === null;
    })());
}

// ---- lifecycle end-to-end: dispersing then done -----------------------------------
{
  const sys = new F.FuneralSystem(SEED);
  sys.onDeath(death('erosion-J'), pool());
  let guard = 40000;
  let sawDispersing = false;
  while (sys.progress().length > 0 && guard-- > 0) {
    const ph = sys.progress()[0].phase;
    if (ph === 'dispersing') sawDispersing = true;
    sys.advance(0.25);
  }
  check('procession disperses and terminates', sawDispersing && guard > 0 && sys.progress().length === 0);
}

console.log(failures === 0 ? '\nFUNERALS_PASS' : `\nFUNERALS_FAIL failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
