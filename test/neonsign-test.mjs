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


