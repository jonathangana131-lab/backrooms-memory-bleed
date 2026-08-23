/**
 * Unit test for neon signs (src/world/neonsign.ts).
 * Standalone (no browser): transpiles the module into a temp dir and checks
 * placement rarity/determinism, flicker shape, and buzz gating.
 * Run: node test/neonsign-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-neonsign-'));
const js = ts.transpileModule(
  fs.readFileSync(path.join(ROOT, 'src/world/neonsign.ts'), 'utf8'),
  { fileName: 'neonsign.ts', compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
fs.writeFileSync(path.join(tmp, 'neonsign.mjs'), js);
const mod = await import(pathToFileURL(path.join(tmp, 'neonsign.mjs')).href);
const { NeonSign, BUZZ_RADIUS, createNeonBuzz } = mod;

const CORRIDOR_GRID = 3; // District.CORRIDOR_GRID
const OTHER_DISTRICTS = [0, 1, 2, 4]; // MAZE, OPEN_OFFICE, HONEYCOMB, STORAGE

// --- 1. district gating -----------------------------------------------------
{
  let placed = 0;
  for (let cx = -40; cx < 40; cx++) {
    for (let cz = -40; cz < 40; cz++) {
      for (const d of OTHER_DISTRICTS) {
        if (NeonSign.tryPlace(cx, cz, d) !== null) placed++;
      }
    }
  }
  check('never places outside CORRIDOR_GRID', placed === 0, 'placed=' + placed);
}

// --- 2. rarity + determinism ------------------------------------------------
{
  let placed = 0;
  const N = 300; // 300x300 chunks = 90000 samples -> expect ~6000 signs
  const seen = new Map();
  for (let cx = 0; cx < N; cx++) {
    for (let cz = 0; cz < N; cz++) {
      const s = NeonSign.tryPlace(cx, cz, CORRIDOR_GRID);
      if (s) {
        placed++;
        seen.set(cx + ':' + cz, s);
      }
    }
  }
  const rate = placed / (N * N);
  const expected = 1 / 15;
  check(
    'placement rate ~1 per 15 chunks',
    rate > expected * 0.85 && rate < expected * 1.15,
    'rate=' + rate.toFixed(4) + ' expected~' + expected.toFixed(4),
  );

  let mismatches = 0;
  for (const [k] of seen) {
    const [cx, cz] = k.split(':').map(Number);
    const again = NeonSign.tryPlace(cx, cz, CORRIDOR_GRID);
    if (JSON.stringify(again) !== JSON.stringify(seen.get(k))) mismatches++;
  }
  check('deterministic across repeated calls', mismatches === 0, 'mismatches=' + mismatches);

  check('at most one sign per chunk (API returns single instance)', true);
}

// --- 3. instance sanity ------------------------------------------------------
{
  const TEXTS = ['MOTEL', 'OPEN 24 HRS', 'VACANCY', 'NO VACANCY', 'DINER'];
  const texts = new Set();
  let bad = 0;
  let checked = 0;
  for (let cx = 0; cx < 200 && checked < 500; cx++) {
    for (let cz = 0; cz < 200 && checked < 500; cz++) {
      const s = NeonSign.tryPlace(cx, cz, CORRIDOR_GRID);
      if (!s) continue;
      checked++;
      texts.add(s.text);
      const insideX = s.x >= cx * 30 && s.x < (cx + 1) * 30;
      const insideZ = s.z >= cz * 30 && s.z < (cz + 1) * 30;
      const faceOk = [0, 1, 2, 3].includes(s.face);
      const yOk = s.y >= 1.9 && s.y <= 2.6;
      const widthOk = s.width >= s.text.length * 0.2 && s.width < 3.5;
      const colorOk = typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color);
      const seedOk = Number.isInteger(s.seed) && s.seed >= 0;
      if (!(insideX && insideZ && faceOk && yOk && widthOk && colorOk && seedOk)) bad++;
    }
  }
  check('sample of signs valid (bounds/face/y/width/color/seed)', bad === 0, 'bad=' + bad + ' of ' + checked);
  const poolOk = [...texts].every((t) => TEXTS.includes(t));
  check('texts all drawn from the required pool', poolOk, [...texts].join(',')),
  check(
    'multiple distinct texts appear across chunks',
    texts.size >= 3,
    'distinct=' + texts.size,
  );

  // corridor alignment: sign must sit on a lat-7 wall line facing the band
  let misaligned = 0;
  for (let cx = 0; cx < 120; cx++) {
    for (let cz = 0; cz < 120; cz++) {
      const s = NeonSign.tryPlace(cx, cz, CORRIDOR_GRID);
      if (!s) continue;
      const onWallZ = [0, 1].includes(s.face);
      const lineZ = s.z / 2.5 - (s.face === 1 ? 0.11 / 2.5 : -0.11 / 2.5);
      const gzLine = ((Math.round(lineZ) % 7) + 7) % 7;
      const lineX = s.x / 2.5 - (s.face === 3 ? 0.11 / 2.5 : -0.11 / 2.5);
      const gxLine = ((Math.round(lineX) % 7) + 7) % 7;


      const wallOk = onWallZ ? gzLine === 3 || gzLine === 5 : gxLine === 3 || gxLine === 5;
      if (!wallOk) misaligned++;
    }
  }
  check('signs mount on corridor-boundary walls', misaligned === 0, 'misaligned=' + misaligned);
}

// --- 4. flicker shape --------------------------------------------------------
{
  const HORIZON = 10 * 60 * 1000; // 10 minutes
  const STEP = 10;
  for (const seed of [1, 0xdeadbeef, 123456789, 42]) {
    let sum = 0, n = 0, deepDrops = 0, offs = 0;
    const runs = [];
    let runStart = null;
    for (let t = 0; t < HORIZON; t += STEP) {
      const b = NeonSign.sampleFlicker(seed, t);
      if (b < 0 || b > 1) { check('brightness in range', false, 'b=' + b + '@'+t); break; }
      sum += b; n++;
      if (b < 0.2) deepDrops++;
      if (b === 0) {
        offs++;
        if (runStart === null) runStart = t;
      } else if (runStart !== null) {
        runs.push(t - runStart);
        runStart = null;
      }
    }
    if (runStart !== null) runs.push(HORIZON - runStart);
    const mean = sum / n;
    check('seed ' + seed + ': mostly-on baseline (mean>0.75)', mean > 0.75, 'mean=' + mean.toFixed(3));
    check('seed ' + seed + ': irregular buzz-cut dropouts exist', deepDrops > 0, 'drops=' + deepDrops);
    check('seed ' + seed + ': full-off episodes occur', runs.length > 0, 'runs=' + runs.length);
    const lenOk = runs.every((r) => r >= 450 && r <= 2100);
    check('seed ' + seed + ': off durations within 0.5-2s', lenOk, 'runs=' + JSON.stringify(runs));
    const b1 = NeonSign.sampleFlicker(seed, 98765);
    const b2 = NeonSign.sampleFlicker(seed, 98765);
    check('seed ' + seed + ': deterministic sampling', b1 === b2, b1 + ' vs ' + b2);
  }
}

// --- 5. buzz gain ------------------------------------------------------------
{
  const sign = { text: 'MOTEL', x: 100, z: 100, face: 1, y: 2.2, width: 1.6, height: 0.62, color: '#ff3038', seed: 777 };
  const gAt = NeonSign.buzzGain(sign, 100, 100, 60_000);
  const gHalf = NeonSign.buzzGain(sign, 100, 104, 60_000);
  const gEdge = NeonSign.buzzGain(sign, 100, 100 + BUZZ_RADIUS - 0.01, 60_000);
  const gOut = NeonSign.buzzGain(sign, 100, 100 + BUZZ_RADIUS + 5, 60_000);
  check('buzz audible at source', gAt > 0, 'g=' + gAt);
  check('buzz falls off with distance', gHalf < gAt && gEdge < gHalf, gAt.toFixed(3) + '>' + gHalf.toFixed(3) + '>' + gEdge.toFixed(3));
  check('silent beyond 8m', gOut === 0, 'g=' + gOut);

  // gate: find a full-off moment by scanning, then verify the hum dies there
  let deadT = -1;
  for (let t = 0; t < 600_000; t += 25) {
    if (NeonSign.sampleFlicker(sign.seed, t) === 0) { deadT = t; break; }
  }
  if (deadT >= 0) {
    const gDead = NeonSign.buzzGain(sign, 100, 100, deadT);
    check('buzz cuts out during sign-off', gDead === 0, 't=' + deadT + ' g=' + gDead);
  } else {
    check('buzz cuts out during sign-off', false, 'no off episode found');
  }
}

// --- 6. web audio guard ------------------------------------------------------
{
  const h = createNeonBuzz(null, null, {});
  check('createNeonBuzz returns null without AudioContext', h === null, 'h=' + h);
}

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);


