/**
 * Tour guide tests (src/entities/tourguide.ts, F68).
 * Standalone (no browser): transpiles rng.ts + tourguide.ts into a temp dir
 * and drives the escort directly, same idiom as funerals-test.
 *
 * Acceptance:
 *   1. abandonment timing - across 200 seeded runs with varied walk
 *      profiles, abandonment fires ONLY after the player passes the commit
 *      node AND overtakes the guide at their deepest progress; every
 *      not-yet-committed run never abandons;
 *   2. pacing - before commitment the guide always waits: outside the
 *      leash it stands still (arc frozen) and trust decays; inside it
 *      advances at ESCORT_SPEED_MPS with each step clamped so its endpoint
 *      never breaches the leash radius, even for huge dt, and trust builds
 *      monotonically while it moves;
 *   3. departure - after firing, the guide departs at MAX_ESCORT_SPEED_MPS
 *      toward the claimed exit and reaches 'gone';
 *   4. single fire - advancing long past abandonment never re-fires;
 *   5. determinism - same seed + identical inputs replay byte-identical
 *      timelines; different seeds decorrelate (trust rates differ);
 *   6. fail-loud - unknown node ids or unreachable exits throw.
 *
 * Run: node test/tourguide-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-tourguide-'));
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
emit('src/entities/tourguide.ts', 'src/entities/tourguide.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const tg = await import(pathToFileURL(path.join(tmp, 'src/entities/tourguide.mjs')).href);

const DT = 0.05;

// ---- fixture: colinear route along +x so test-side path math is trivial ----
// n0(0) .. n6(90), commit node n4 at 60 m, exit claim n6 at 90 m.
function makeGraph() {
  const nodes = [];
  for (let i = 0; i <= 6; i++) nodes.push({ id: 'n' + i, pos: { x: i * 15, z: 0 } });
  const edges = [];
  for (let i = 0; i < 6; i++) edges.push({ from: 'n' + i, to: 'n' + (i + 1) });
  return {
    graph: { nodes, edges },
    startNodeId: 'n0',
    commitNodeId: 'n4',
    exitClaim: { nodeId: 'n6', label: 'STAIRWELL B — I saw daylight there once' },
  };
}

/** Deterministic per-seed LCG for scripted walk profiles (test-side only). */
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 8) & 0xffffff) / 0x1000000;
  };
}

/** Walk the player along the route at profile speed; returns snapshots. */
function simulate(seed, playerSpeedMps, stopBeforeCommit = false, maxS = 240) {
  const base = makeGraph();
  const guide = new tg.TourGuide({ seed, ...base });
  const totalM = 90;
  const commitM = 60;
  let px = 0;
  const snaps = [];
  for (let t = 0; t < maxS; t += DT) {
    if (!stopBeforeCommit || px < commitM - 12) px = Math.min(totalM, px + playerSpeedMps * DT);
    snaps.push({ t: +t.toFixed(4), ...guide.advance(DT, { x: px, z: 0 }) });
    if (snaps[snaps.length - 1].phase === 'gone') break;
  }
  return { guide, snaps, totalM, commitM };
}

// ---- 1. abandonment timing across 200 seeded runs ---------------------------
{
  let firedOnlyAfterCommit = true;
  let firedAtAll = 0;
  let singleFireEverywhere = true;
  let departedAtMax = true;
  let reachedGone = 0;
  for (let run = 0; run < 200; run++) {
    const rr = lcg(run * 7919 + 13);
    const speed = 1.8 + rr() * 1.7; // strictly faster than the escort
    const { guide, snaps, commitM, totalM } = simulate(run, speed);
    const fireIdx = snaps.findIndex((s) => s.abandoned);
    if (fireIdx === -1) { firedOnlyAfterCommit = false; break; }
    firedAtAll++;
    // Fire condition held exactly at fireIdx and never earlier.
    const f = snaps[fireIdx];
    if (!(f.committed && f.playerDeepestArcM >= commitM - 1e-6)) firedOnlyAfterCommit = false;
    for (let i = 0; i < fireIdx; i++) {
      const s = snaps[i];
      if (s.abandoned || (s.committed && s.playerArcM >= s.arcM && s.playerDeepestArcM >= commitM)) {
        firedOnlyAfterCommit = false;
      }
    }
    // Exactly one transition into abandoned across the whole tail.
    let transitions = 0;
    for (let i = 1; i < snaps.length; i++) {
      if (snaps[i].abandoned && !snaps[i - 1].abandoned) transitions++;
    }
    if (transitions !== 1) singleFireEverywhere = false;
    // Departure leg moves at MAX_ESCORT_SPEED_MPS until gone.
    let seenDeparting = false;
    for (let i = fireIdx; i < snaps.length; i++) {
      if (snaps[i].phase === 'departing') {
        seenDeparting = true;
        if (i > fireIdx) {
          const dArc = snaps[i].arcM - snaps[i - 1].arcM;
          if (dArc > tg.MAX_ESCORT_SPEED_MPS * DT + 1e-6) departedAtMax = false;
          if (dArc < tg.MAX_ESCORT_SPEED_MPS * DT - 1e-3) departedAtMax = false;
        }
      }
    }
    if (!seenDeparting) departedAtMax = false;
    if (snaps.length && snaps[snaps.length - 1].phase === 'gone' &&
        Math.abs(snaps[snaps.length - 1].arcM - totalM) < 1e-6) reachedGone++;
  }
  check('F68 timing: 200/200 seeded runs abandon only after commit-node overtaking',
    firedOnlyAfterCommit && firedAtAll === 200, `fired=${firedAtAll}`);
  check('F68 timing: exactly one abandonment transition per run (single fire)',
    singleFireEverywhere);
  check('F68 departure: departing leg runs at MAX_ESCORT_SPEED_MPS and ends gone at exit',
    departedAtMax && reachedGone === 200, `gone=${reachedGone}`);
}
{
  // Uncommitted runs: player stops short of the commit node forever.
  let clean = true;
  for (let run = 0; run < 50; run++) {
    const rr = lcg(run * 104729 + 7);
    const speed = 0.8 + rr() * 2.4;
    const { snaps } = simulate(run, speed, true, 120);
    const last = snaps[snaps.length - 1];
    if (last.abandoned || last.committed) { clean = false; break; }
    if (snaps.some((s) => s.abandoned)) { clean = false; break; }
  }
  check('F68 timing: uncommitted players are never abandoned (guide waits forever)',
    clean);
}

// ---- 2. pacing / leash / trust ---------------------------------------------
{
  const base = makeGraph();
  const guide = new tg.TourGuide({ seed: 4242, ...base });
  // Player stands still at spawn: guide must wait inside leash, then freeze
  // beyond it once it walks out of range... it can't leave the player: leash
  // keeps it within LEASH_RADIUS_M of the spawn point.
  let maxGuideDist = 0;
  let trustRose = false;
  let prev = null;
  for (let i = 0; i < 400; i++) {
    const p = guide.advance(DT, { x: 0.5, z: 0 });
    maxGuideDist = Math.max(maxGuideDist, Math.hypot(p.pos.x - 0.5, p.pos.z));
    if (prev && !p.waitingForPlayer && p.trust > prev.trust) trustRose = true;
    if (!p.waitingForPlayer && prev && p.arcM < prev.arcM - 1e-12) {
      check('F68 pacing: guide arc never regresses', false, 'regressed');
      break;
    }
    if (p.abandoned || p.committed) { check('F68 pacing: idle player never triggers commitment', false); break; }
    prev = p;
  }
  check('F68 pacing: guide stays leashed near an idle player (never abandons)',
    maxGuideDist <= tg.LEASH_RADIUS_M + 1e-6 && !guide.progress().abandoned,
    `maxDist=${maxGuideDist.toFixed(2)}`);
  check('F68 pacing: trust builds while the player keeps up', trustRose);

  // Player walks then stops: the clamped escort carries the leashed guide
  // only as far as the leash allows, and once the stopped player leaves the
  // guide nothing pulls it forward - it freezes and trust decays.
  const g2 = new tg.TourGuide({ seed: 99, ...makeGraph() });
  let frozeWhenWaiting = true;
  let decayed = false;
  let prevArc = 0;
  let prevTrust = 0;
  let sawWaiting = false;
  let px = 0;
  for (let i = 0; i < 1200; i++) {
    if (i < 300) px += 0.35 * DT; // walk for a while, then stand still and lag
    const p = g2.advance(DT, { x: px, z: 0 });
    if (p.waitingForPlayer) {
      sawWaiting = true;
      if (p.arcM !== prevArc) frozeWhenWaiting = false;
      if (p.trust < prevTrust - 1e-12) decayed = true;
    }
    prevArc = p.arcM;
    prevTrust = p.trust;
  }
  check('F68 pacing: waiting guide freezes in place (waypoint pacing)',
    sawWaiting && frozeWhenWaiting, `sawWaiting=${sawWaiting}`);
  check('F68 pacing: trust decays once the player stops keeping up', decayed);
  check('F68 pacing: slow walker never abandoned (pre-commitment wait law)',
    !g2.progress().abandoned && !g2.progress().committed);
}

// ---- 2b. leash overshoot clamp under large dt -------------------------------
{
  // 5 s frames => 8 m escort steps; a rejected-step implementation would
  // freeze at spawn, a clamped one creeps exactly to the leash boundary and
  // never a centimetre past it.
  const g3 = new tg.TourGuide({ seed: 31337, ...makeGraph() });
  let maxDist = 0;
  let reachedBoundary = false;
  for (let i = 0; i < 40 && !reachedBoundary; i++) {
    const p = g3.advance(5, { x: 0.5, z: 0 });
    maxDist = Math.max(maxDist, Math.hypot(p.pos.x - 0.5, p.pos.z));
    if (maxDist >= tg.LEASH_RADIUS_M - 0.05) reachedBoundary = true;
  }
  check('F68 pacing: large-dt steps clamp inside the leash radius (no overshoot)',
    maxDist <= tg.LEASH_RADIUS_M + 1e-6, `maxDist=${maxDist.toFixed(4)}`);
  check('F68 pacing: clamped steps creep to the leash boundary instead of freezing',
    reachedBoundary, `maxDist=${maxDist.toFixed(4)}`);

  // Same law across 50 seeds with random huge dt values.
  let clean = true;
  outer: for (let run = 0; run < 50; run++) {
    const rr = lcg(run * 65537 + 3);
    const g = new tg.TourGuide({ seed: run, ...makeGraph() });
    let prevArc = 0;
    for (let i = 0; i < 30; i++) {
      const dt = 0.5 + rr() * 20; // up to ~20 s per escort step
      const pPos = { x: rr() * 4, z: rr() * 2 };
      const p = g.advance(dt, pPos);
      const pd = Math.hypot(p.pos.x - pPos.x, p.pos.z - pPos.z);
      if (p.waitingForPlayer) {
        // A waiting guide never moves.
        if (p.arcM !== prevArc) { clean = false; break outer; }
      } else if (pd > tg.LEASH_RADIUS_M + 1e-6) {
        // A moving guide's endpoint must respect the leash.
        clean = false; break outer;
      }
      prevArc = p.arcM;
      if (p.abandoned || p.committed) { clean = false; break outer; }
    }
  }
  check('F68 pacing: 50 seeded large-dt runs never breach the leash while uncommitted',
    clean);
}

// ---- 3. determinism ---------------------------------------------------------
{
  const a = simulate(777, 2.3);
  const b = simulate(777, 2.3);
  const ja = JSON.stringify(a.snaps);
  const jb = JSON.stringify(b.snaps);
  check('F68 determinism: same seed + inputs replay byte-identical timeline', ja === jb);

  const rates = new Set();
  for (let seed = 0; seed < 40; seed++) {
    const g = new tg.TourGuide({ seed, ...makeGraph() });
    let prevT = 0;
    let rate = -1;
    for (let i = 0; i < 100; i++) {
      const p = g.advance(DT, { x: 0.2, z: 0 });
      if (p.trust > prevT) { rate = +(p.trust / DT).toFixed(4); break; }
      prevT = p.trust;
    }
    rates.add(rate);
  }
  check('F68 determinism: seeds decorrelate (trust rates spread across runs)',
    rates.size > 10, `distinct=${rates.size}`);
}

// ---- 4. fail-loud injection validation --------------------------------------
{
  let threw = 0;
  try { new tg.TourGuide({ seed: 1, ...makeGraph(), startNodeId: 'nope' }); } catch { threw++; }
  try {
    const b = makeGraph();
    new tg.TourGuide({ seed: 1, ...b, exitClaim: { nodeId: 'ghost', label: 'x' } });
  } catch { threw++; }
  try {
    const b = makeGraph();
    b.graph.edges.pop(); // sever n5->n6: exit unreachable
    new tg.TourGuide({ seed: 1, ...b });
  } catch { threw++; }
  check('F68 fail-loud: unknown ids and unreachable exits throw at construction',
    threw === 3, `threw=${threw}`);
}

console.log(failures === 0 ? 'TOURGUIDE_PASS' : `TOURGUIDE_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
