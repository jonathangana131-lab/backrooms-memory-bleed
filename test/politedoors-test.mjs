/**
 * Polite doors tests (src/world/politedoors.ts, F69).
 * Standalone (no browser): transpiles rng.ts + politedoors.ts into a temp
 * dir and drives the courtesy coordinator directly, same idiom as
 * tourguide-test.
 *
 * Acceptance:
 *   1. timeline exactness - a toward-walking player inside the radius
 *      triggers one clean open-hold-close curve: openness stays 0 until
 *      the trigger, rises over OPEN_TIME_S exactly matching the smoothstep
 *      ease at every sample, holds at exactly 1 until the player is
 *      PASS_BEHIND_M beyond the far side, falls over CLOSE_TIME_S matching
 *      the mirrored ease, and lands shut;
 *   2. cooldown - a door that just began closing refuses to reopen for
 *      CLOSE_TIME_S plus its seeded cooldown, then works again;
 *   3. away-motion inert - moving away, standing still, or crossing
 *      laterally inside the radius never triggers, ever;
 *   4. determinism - same seed + inputs replay byte-identical sampled
 *      timelines; different seeds decorrelate cooldown draws;
 *   5. fail-loud - duplicate ids and unknown ids throw.
 *
 * Run: node test/politedoors-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-politedoors-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/politedoors.ts', 'src/world/politedoors.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const pd = await import(pathToFileURL(path.join(tmp, 'src/world/politedoors.mjs')).href);

const DT = 0.05;
const EPS = 1e-9;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/** Drive one scripted walk; sample (t, phase, openness) every step. */
function run(seed, doorSpecs, moves) {
  const sim = new pd.PoliteDoors({ seed, doors: doorSpecs });
  const samples = [];
  let t = 0;
  for (const [pos, steps] of moves) {
    for (let i = 0; i < steps; i++) {
      sim.advance(DT, pos);
      t += DT;
      const st = sim.state(doorSpecs[0].id);
      samples.push({ t: Math.round(t * 1000) / 1000, phase: st.phase, openness: st.openness });
    }
  }
  return { sim, samples };
}

// ---- AC 1: sampled open-hold-close timeline is exact --------------------
{
  const door = { id: 'main', pos: { x: 10, z: 0 } };
  // Walk +x at 3 m/s from x=2: enter radius at x<=4 boundary, trigger,
  // blow through the door, end well past PASS_BEHIND_M.
  const moves = [];
  for (let i = 0; i <= 120; i++) moves.push([{ x: 2 + 3 * i * DT, z: 0 }, 1]);
  const { samples } = run(777, [door], moves);

  const firstMoveIdx = samples.findIndex((s) => s.phase !== 'closed');
  check('F69 timing: door stays shut until the approach trigger',
    firstMoveIdx > 0 && samples.slice(0, firstMoveIdx).every((s) => s.phase === 'closed' && s.openness === 0),
    `firstMoveIdx=${firstMoveIdx}`);

  const seg = (phase) => {
    const start = samples.findIndex((s, i) => i >= firstMoveIdx && s.phase === phase);
    let end = start;
    while (end + 1 < samples.length && samples[end + 1].phase === phase) end++;
    return [start, end];
  };
  const [o0, o1] = seg('opening');
  const nOpen = o1 - o0 + 1;
  check('F69 timing: opening spans exactly OPEN_TIME_S',
    Math.abs(nOpen * DT - pd.OPEN_TIME_S) < EPS,
    `nOpen=${nOpen} expected=${pd.OPEN_TIME_S / DT}`);
  let riseOk = true;
  for (let j = 0; j < nOpen; j++) {
    // Sample j reflects j eased steps after the trigger frame.
    const want = smoothstep(Math.min(1, (j * DT) / pd.OPEN_TIME_S));
    if (Math.abs(samples[o0 + j].openness - want) > 1e-12) { riseOk = false; break; }
  }
  check('F69 timing: opening ease matches smoothstep at every sample', riseOk);

  const [h0, h1] = seg('open');
  check('F69 timing: hold keeps openness at exactly 1',
    h0 === o1 + 1 && samples.slice(h0, h1 + 1).every((s) => s.openness === 1),
    `h0=${h0} h1=${h1}`);

  // Hold must persist while the player is short of PASS_BEHIND_M past the
  // far side (x < 12), and no longer than reaching it.
  const holdEndT = samples[h1].t;
  const reachPastT = (12 - 2) / 3; // x(t)=2+3t crosses x=12 here
  check('F69 timing: hold releases only after the player passes +2 m behind',
    Math.abs(holdEndT - reachPastT) < DT + EPS && holdEndT >= reachPastT - DT,
    `holdEndT=${holdEndT} reachPastT=${reachPastT}`);

  const [c0, c1] = seg('closing');
  const nClose = c1 - c0 + 1;
  check('F69 timing: closing spans exactly CLOSE_TIME_S',
    Math.abs(nClose * DT - pd.CLOSE_TIME_S) < EPS,
    `nClose=${nClose} expected=${pd.CLOSE_TIME_S / DT}`);
  // Same snapshot convention: closing sample j reflects j eased steps; the
  // exact-zero landing lands on the transition into 'closed'.
  let fallOk = true;
  for (let j = 0; j < nClose; j++) {
    const want = 1 - smoothstep(Math.min(1, (j * DT) / pd.CLOSE_TIME_S));
    if (Math.abs(samples[c0 + j].openness - want) > 1e-12) { fallOk = false; break; }
  }
  check('F69 timing: closing ease mirrors smoothstep at every sample', fallOk);
  check('F69 timing: door lands fully shut after the close',
    samples[c1 + 1] && samples[c1 + 1].phase === 'closed' && samples[c1 + 1].openness === 0 &&
    samples.slice(c1 + 1).every((s) => s.openness === 0));
  check('F69 timing: whole curve has exactly one open-hold-close episode',
    samples.filter((s) => s.phase === 'opening').length === nOpen &&
    samples.filter((s) => s.phase === 'open').length === h1 - h0 + 1 &&
    samples.filter((s) => s.phase === 'closing').length === nClose);
}

// ---- AC 2: per-door cooldown prevents flapping --------------------------
{
  const door = { id: 'gate', pos: { x: 10, z: 0 } };
  // Probe: walk through once to learn close-start time and the seeded
  // cooldown; determinism makes both reproduce exactly in the full runs.
  const probeWalk = [];
  for (let i = 0; i <= 80; i++) probeWalk.push([{ x: 2 + 3 * i * DT, z: 0 }, 1]);
  const probe = run(42, [door], probeWalk);
  const closeStartT = probe.samples.find((s) => s.phase === 'closing').t;
  const seededCd = probe.sim.state('gate').cooldownRemainingS;
  check('F69 cooldown: seeded cooldown visible at close-start',
    seededCd >= pd.COOLDOWN_MIN_S && seededCd <= pd.COOLDOWN_MAX_S,
    `cd=${seededCd}`);
  const eligibleAt = closeStartT + pd.CLOSE_TIME_S + seededCd;

  // Full run: walk through (arms the cooldown at close-start), idle past
  // the door until waitUntilS, then walk back toward it for walkSteps.
  function fullRun(waitUntilS, walkSteps) {
    const standSteps = Math.max(0, Math.round((waitUntilS - 80 * DT) / DT));
    const moves = [];
    for (let i = 0; i <= 80; i++) moves.push([{ x: 2 + 3 * i * DT, z: 0 }, 1]);
    moves.push([{ x: 14, z: 0 }, standSteps]);
    for (let i = 1; i <= walkSteps; i++) moves.push([{ x: 14 - 3 * i * DT, z: 0 }, 1]);
    return run(42, [door], moves);
  }

  // Early: begin the return half a second before eligibility and stop well
  // short of it. The scripted walkthrough contributes exactly one episode;
  // the toward-walk inside the radius before expiry must add none.
  const early = fullRun(eligibleAt - 0.5, 5);
  const earlyEpisodes = early.samples.filter(
    (s, i) => s.phase === 'opening' && (i === 0 || early.samples[i - 1].phase !== 'opening'),
  ).length;
  check('F69 cooldown: toward-walk inside the radius before expiry stays inert',
    earlyEpisodes === 1,
    `episodes=${earlyEpisodes} eligibleAt=${eligibleAt}`);

  // Late: wait past eligibility, then walk toward -> the door reopens.
  const late = fullRun(eligibleAt + 0.5, 60);
  check('F69 cooldown: the same door reopens once its cooldown expires',
    late.samples.some((s) => s.phase !== 'closed'),
    `eligibleAt=${eligibleAt}`);
}

// ---- AC 3: away-motion is inert -----------------------------------------
{
  const door = { id: 'quiet', pos: { x: 10, z: 0 } };
  // Walk AWAY from the door starting inside the radius: begin at x=8
  // (2 m from the door) and move -x, so the velocity points away.
  const away = run(9, [door], Array.from({ length: 61 }, (_, i) => [{ x: 8 - 3 * i * DT, z: 0 }, 1]));
  check('F69 inert: walking away inside the radius never opens',
    away.samples.every((s) => s.openness === 0));

  // Stand still inside the radius.
  const idle = run(9, [door], [[{ x: 8, z: 0 }, 60]]);
  check('F69 inert: standing still inside the radius never opens',
    idle.samples.every((s) => s.openness === 0));

  // Cross laterally: any straight line through the radius has an approaching
  // leg, so hold a constant range instead - orbiting at r=5 keeps every
  // velocity tangential (zero toward-component) while staying inside the
  // radius for over one full revolution.
  const lateral = run(9, [door], Array.from({ length: 48 }, (_, i) => {
    const phi = i * 0.15;
    return [{ x: door.pos.x + 5 * Math.cos(phi), z: 5 * Math.sin(phi) }, 1];
  }));
  check('F69 inert: lateral crossing inside the radius never opens',
    lateral.samples.every((s) => s.openness === 0));
}

// ---- AC 4: determinism per seed -----------------------------------------
{
  const door = { id: 'det', pos: { x: 10, z: 0 } };
  const moves = Array.from({ length: 121 }, (_, i) => [{ x: 2 + 3 * i * DT, z: 0 }, 1]);
  const a = run(2024, [door], moves);
  const b = run(2024, [door], moves);
  check('F69 determinism: same seed replays byte-identical sampled timeline',
    JSON.stringify(a.samples) === JSON.stringify(b.samples));

  // Cross-seed: cooldown draws decorrelate across many seeds.
  const cds = new Set();
  for (let seed = 1000; seed < 1040; seed++) {
    const r = run(seed, [door], moves);
    cds.add(r.sim.state('det').cooldownRemainingS.toFixed(9));
  }
  check('F69 determinism: seeds decorrelate (cooldown draws spread)', cds.size >= 4,
    `distinct=${cds.size}`);
}

// ---- AC 5: fail-loud ------------------------------------------------------
{
  let threwDup = false;
  try {
    new pd.PoliteDoors({
      seed: 1,
      doors: [{ id: 'x', pos: { x: 0, z: 0 } }, { id: 'x', pos: { x: 5, z: 0 } }],
    });
  } catch { threwDup = true; }
  check('F69 fail-loud: duplicate door ids throw at construction', threwDup);

  let threwUnknown = false;
  try {
    new pd.PoliteDoors({ seed: 1, doors: [{ id: 'ok', pos: { x: 0, z: 0 } }] }).state('nope');
  } catch { threwUnknown = true; }
  check('F69 fail-loud: unknown id in state() throws', threwUnknown);
}

console.log(failures === 0 ? 'POLITEDOORS_PASS' : `POLITEDOORS_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
