/**
 * Roach domestication tests (src/entities/roachtame.ts, F67).
 * Standalone (no browser): transpiles rng.ts + roachtame.ts into a temp
 * dir and drives the feeding model directly, same idiom as
 * crawlspaces-test.
 *
 * Acceptance:
 *   1. aggregation thresholds exact - drops on dead cells are ignored;
 *      N-1 fresh drops gather without leading; the Nth triggers 'leading'
 *      toward the NEAREST battery; stale drops outside the window stop
 *      counting and an expired gathering swarm decays back to idle
 *   2. lead-path reliability - over 200 seeded trials with batteries
 *      10-40 m away, the swarm reaches battery vicinity in >=95% of runs
 *   3. strafe abort - a lead disperses the moment the player leaves
 *      PLAYER_FOLLOW_RADIUS_M, clearing the target
 *   4. bounded lead - an unreachable battery ends in 'dispersed' at the
 *      duration bound instead of walking forever
 *   5. determinism - same seed replays the trail exactly; other seeds
 *      decorrelate
 *
 * Run: node test/roachtame-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-roachtame-'));
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
emit('src/entities/roachtame.ts', 'src/entities/roachtame.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const rt = await import(pathToFileURL(path.join(tmp, 'src/entities/roachtame.mjs')).href);

// ---- fixtures -----------------------------------------------------------------

const aliveEverywhere = { populationAt: () => 50 };
const deadEverywhere = { populationAt: () => 0.5 };
const B = (id, x, z) => ({ id, x, z });
function make(colony, batteries, seed) {
  return new rt.RoachDomestication({ colony, batteries, seed });
}
/** Feed N qualifying drops at one cell, 1 s apart starting at t0. */
function feed(m, cell, n, t0 = 0) {
  for (let i = 0; i < n; i++) m.dropFood({ cell, timeSec: t0 + i });
}

// ---- 1. exact aggregation thresholds -------------------------------------------
{
  const m = make(deadEverywhere, [B('bat-a', 30, 0)], 1234);
  let counted = false;
  for (let i = 0; i < rt.FEED_EVENTS_NEEDED + 2; i++) {
    if (m.dropFood({ cell: { x: 0, z: 0 }, timeSec: i })) counted = true;
  }
  check('drops on presence-free cells are ignored entirely', !counted && m.state === 'idle' && m.fedCount(rt.FEED_EVENTS_NEEDED + 1) === 0);
}
{
  const m = make(aliveEverywhere, [B('bat-far', 40, 0)], 77);
  feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED - 1);
  check(`N-1 fresh drops stay gathering (state=${m.state})`,
    m.state === 'gathering' && m.fedCount(rt.FEED_EVENTS_NEEDED) === rt.FEED_EVENTS_NEEDED - 1 && m.target === null);
  m.dropFood({ cell: { x: 0, z: 0 }, timeSec: rt.FEED_EVENTS_NEEDED - 1 });
  check('Nth fresh drop flips to leading immediately', m.state === 'leading' && !!m.target && m.target.id === 'bat-far');
}
{
  // Sliding window: old crumbs rot; a lone late drop cannot resurrect them.
  const m = make(aliveEverywhere, [B('bat-x', 25, 0)], 78);
  feed(m, { x: 0, z: 0 }, 3, 0); // t=0,1,2
  m.doTick(rt.FEED_WINDOW_SEC + 5, { x: 0, z: 0 }); // everything stales out
  check('expired gathering swarm decays back to idle', m.state === 'idle' && m.fedCount(rt.FEED_WINDOW_SEC + 5) === 0);
  feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED - 1, rt.FEED_WINDOW_SEC + 5);
  check('fresh drops needed again after full staleness', m.state === 'gathering');
}
{
  // Partial staleness inside the window counts what remains.
  const m = make(aliveEverywhere, [B('bat-y', 25, 0)], 79);
  m.dropFood({ cell: { x: 0, z: 0 }, timeSec: 0 });
  feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED - 1, rt.FEED_WINDOW_SEC + 1); // first drop now stale
  check('stale drop excluded, remaining fresh ones still short of N',
    m.state === 'gathering' && m.fedCount(rt.FEED_WINDOW_SEC + 1) === rt.FEED_EVENTS_NEEDED - 1);
}
{
  // Nearest battery wins when several are visible.
  const m = make(aliveEverywhere, [B('far', 90, 0), B('near', 12, 0), B('mid', 45, 3)], 80);
  feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED);
  check('leading targets the nearest injected battery', m.target !== null && m.target.id === 'near');
}
{
  // No batteries anywhere: the swarm refuses to lead and keeps gathering.
  const m = make(aliveEverywhere, [], 81);
  feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED);
  check('empty battery list blocks leading', m.state === 'gathering' && m.target === null);
}

// ---- 2. lead-path reliability over 200 seeded trials ----------------------------
{
  const TRIALS = 200;
  let delivered = 0;
  const DT = 0.25;
  const MAXT = 45;
  for (let trial = 0; trial < TRIALS; trial++) {
    // Seeded placement: battery 10-40 m away on a seeded bearing.
    const prng = (() => { let s = (trial * 2654435761) >>> 0 || 1; return () => { s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0; return (s >>> 8) / 16777216; }; })();
    const dist = 10 + prng() * 30;
    const bearing = prng() * Math.PI * 2;
    const bat = B(`bat-${trial}`, Math.cos(bearing) * dist, Math.sin(bearing) * dist);
    const m = make(aliveEverywhere, [bat], 9000 + trial);
    feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED);
    let t = 0;
    while (m.state === 'leading' && t <= MAXT) {
      t += DT;
      m.doTick(t, m.position); // handler walks right with the swarm
    }
    if (m.state === 'delivered' && m.deliveredBatteryId === `bat-${trial}`) delivered++;
  }
  const rate = delivered / TRIALS;
  check(`lead-path reliability: ${delivered}/${TRIALS} delivered (${(rate * 100).toFixed(1)}%)`, rate >= 0.95);
}

// ---- 3. strafe abort ------------------------------------------------------------
{
  const m = make(aliveEverywhere, [B('bat-s', 30, 0)], 555);
  feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED);
  let t = 0;
  for (let i = 0; i < 5; i++) {
    t += 0.5;
    m.doTick(t, { x: 1, z: 1 }); // player close by
  }
  const midState = m.state;
  const midDist = Math.hypot(m.position.x, m.position.z);
  m.doTick(t + 0.5, { x: 500, z: 500 }); // player bolts far outside follow radius
  check(`strafe mid-lead disperses instantly (${midState} @${midDist.toFixed(1)}m)`,
    midState === 'leading' && m.state === 'dispersed' && m.target === null && m.deliveredBatteryId === null);
  // A dispersed swarm does not resume from stale crumbs.
  m.doTick(t + 1, { x: 0, z: 0 });
  check('dispersed swarm stays dispersed', m.state === 'dispersed');
}

// ---- 4. bounded lead ------------------------------------------------------------
{
  const m = make(aliveEverywhere, [B('unreachable', 200, 0)], 42);
  feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED);
  let t = 0;
  const DT = 0.5;
  while (m.state === 'leading' && t < 120) {
    t += DT;
    m.doTick(t, m.position);
  }
  check(`unreachable battery gives up at the duration bound (t=${t})`,
    m.state === 'dispersed' && t >= rt.LEAD_DURATION_SEC - DT / 2 && t < rt.LEAD_DURATION_SEC + 2 * DT);
}

// ---- 5. determinism --------------------------------------------------------------
{
  function runTrail(seed) {
    const bat = B('det-bat', 33, 21);
    const m = make(aliveEverywhere, [bat], seed);
    feed(m, { x: 0, z: 0 }, rt.FEED_EVENTS_NEEDED);
    const trail = [];
    let t = 0;
    while (m.state === 'leading' && t < 40) {
      t += 0.25;
      m.doTick(t, m.position);
      trail.push(`${m.position.x.toFixed(6)},${m.position.z.toFixed(6)}`);
    }
    return { trail: trail.join(';'), end: m.state };
  }
  const a = runTrail(20250824);
  const b = runTrail(20250824);
  const c = runTrail(20250825);
  check('same seed replays the lead trail byte-identically', a.trail === b.trail && a.end === b.end && a.end === 'delivered');
  check('different seed decorrelates the wander path', a.trail !== c.trail);
}

console.log(failures === 0 ? 'ROACHTAME_PASS' : `ROACHTAME_FAIL failures=${failures}`);
process.exit(failures === 0 ? 0 : 1);
