/**
 * Unit test for wall cracks (src/world/cracks.ts).
 * Standalone (no browser): transpiles the module (+ its deps) into a temp
 * dir and drives it with a fake clock + fake localStorage.
 * Run: node test/cracks-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-cracks-'));
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/world/cracks.ts', 'world/cracks.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'world', 'cracks.mjs')).href);
const {
  createWallCracks, buildCrackGeometry,
  CRACK_AWAY_MS, ACTIVITY_SECONDS_PER_CRACK, MAX_CRACKS_PER_CHUNK, MAX_STAGE,
} = mod;
const CS = 30; // CHUNK_SIZE metres, mirrored from src/world/constants.ts

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}



const HALF_PI = Math.PI / 2;
function inBounds(c, cx, cz) {
  return c.x >= cx * CS + 1.4 && c.x <= (cx + 1) * CS - 1.4 &&
         c.z >= cz * CS + 1.4 && c.z <= (cz + 1) * CS - 1.4;
}

{
  // --- determinism + instance shape ---------------------------------------
  const wc = createWallCracks(() => 0, new FakeStorage());
  const a = wc.generateForChunk(3, -2, 1234);
  const b = wc.generateForChunk(3, -2, 1234);
  check('same seed reproduces identical decals', JSON.stringify(a) === JSON.stringify(b));
  const c = wc.generateForChunk(3, -2, 999);
  check('different seed moves stress points', JSON.stringify(a) !== JSON.stringify(c));
  check('decals stay inside their chunk', a.every((k) => inBounds(k, 3, -2)), JSON.stringify(a));
  check('rotY snaps to quarter turns', a.every((k) => Math.abs(k.rotY / HALF_PI - Math.round(k.rotY / HALF_PI)) < 1e-9));
  check('stages start within 0..MAX_STAGE', a.every((k) => Number.isInteger(k.stage) && k.stage >= 0 && k.stage <= MAX_STAGE));
  check('instance carries exactly x,z,rotY,stage', a.every((k) => {
    return Object.keys(k).sort().join(',') === 'rotY,stage,x,z';
  }));
}

{
  // --- activity-driven placement ------------------------------------------
  const wc = createWallCracks(() => 0, new FakeStorage());
  const before = wc.getCracks(5, 5).length;
  const neighborBefore = wc.getCracks(6, 5).length;

  // one crack's worth of time -> at least one earned slot appears
  wc.addActivity(160, 160, ACTIVITY_SECONDS_PER_CRACK); // (160,160) is chunk (5,5)
  const mid = wc.getCracks(5, 5).length;
  check('dwell time earns extra cracks', mid > before, before + ' -> ' + mid);

  // maxed-out dwell saturates the chunk
  wc.addActivity(160, 160, ACTIVITY_SECONDS_PER_CRACK * MAX_CRACKS_PER_CHUNK);
  const full = wc.getCracks(5, 5).length;
  check('density scales up to the cap', full === MAX_CRACKS_PER_CHUNK, String(full));

  // preferential: neighbouring quiet chunk keeps its ambient-only set
  const neighborAfter = wc.getCracks(6, 5).length;
  check('quiet neighbour unaffected', neighborAfter === neighborBefore, neighborBefore + ' vs ' + neighborAfter);

  // degenerate dt is ignored
  wc.addActivity(160, 160, 0);
  wc.addActivity(160, 160, -3);
  wc.addActivity(NaN, NaN, 60);
  check('non-positive dt adds nothing', wc.getCracks(5, 5).length === full);

  // negative world coords bucket correctly ((-10,-10) lives in chunk (-1,-1))
  const wneg = createWallCracks(() => 0, new FakeStorage());
  wneg.addActivity(-10, -10, ACTIVITY_SECONDS_PER_CRACK * MAX_CRACKS_PER_CHUNK);
  check('negative coords accrue to their own chunk',
    wneg.getCracks(-1, -1).length === MAX_CRACKS_PER_CHUNK);
}

{
  // --- progressive growth across visits ------------------------------------
  let t = 0;
  const wc = createWallCracks(() => t, new FakeStorage());
  wc.addActivity(210, 210, ACTIVITY_SECONDS_PER_CRACK * MAX_CRACKS_PER_CHUNK);
  const v0 = wc.getCracks(7, 7);
  check('first visit registers stage 0', v0.length > 0 && v0.every((k) => k.stage === 0), JSON.stringify(v0.map((k) => k.stage)));

  t += 1000; // quick re-entry inside the away-window: no growth
  const vSame = wc.getCracks(7, 7);
  check('re-entry within window does not grow', vSame.every((k) => k.stage === 0));

  t += CRACK_AWAY_MS;
  const v1 = wc.getCracks(7, 7);
  check('return after 5 min reaches stage 1', v1.length > 0 && v1.every((k) => k.stage === 1));

  t += CRACK_AWAY_MS;
  const v2 = wc.getCracks(7, 7);
  check('second return reaches stage 2', v2.every((k) => k.stage === 2));

  t += CRACK_AWAY_MS;
  const v3 = wc.getCracks(7, 7);
  t += CRACK_AWAY_MS;
  const v4 = wc.getCracks(7, 7);
  check('growth clamps at terminal stage', v3.every((k) => k.stage === 3) && v4.every((k) => k.stage === 3));

  // only the revisited chunk grows
  const other = wc.getCracks(8, 7);
  check('other chunks keep stage 0', other.every((k) => k.stage === 0));
  void v0; void v1; void v2;
}

{
  // --- persistence through localStorage across instances -------------------
  const storage = new FakeStorage();
  let t = 0;
  let wc = createWallCracks(() => t, storage);
  wc.addActivity(40, 40, ACTIVITY_SECONDS_PER_CRACK * 3);
  wc.getCracks(1, 1); // register visit + slots
  t += CRACK_AWAY_MS + 10000; // past both the away-window and the save throttle
  wc.getCracks(1, 1); // grows to stage 1 and forces persistence

  const raw = JSON.parse(storage.getItem('bmb-crack-stages'));
  check('state persisted under bmb-crack-stages', !!raw && raw.v === 1, JSON.stringify(raw && Object.keys(raw)));
  check('dwell seconds persisted', (raw.activity['1,1'] ?? 0) >= ACTIVITY_SECONDS_PER_CRACK * 3, JSON.stringify(raw.activity));
  const anyStage1 = Object.values(raw.stages).some((s) => s >= 1);
  check('grown stages persisted', anyStage1, JSON.stringify(raw.stages));

  wc = createWallCracks(() => t, storage);
  const resumed = wc.getCracks(1, 1);
  check('new instance resumes dwell density', resumed.length >= 3, String(resumed.length));
  check('new instance resumes grown stages', resumed.every((k) => k.stage === 1), JSON.stringify(resumed.map((k) => k.stage)));
}

{
  // --- crack geometry: trunk + branches, taper, stage effects --------------
  const anchor = { x: 12.5, z: -44.2, rotY: HALF_PI, stage: 0 };
  const g0 = buildCrackGeometry(anchor, 77);
  const g0b = buildCrackGeometry(anchor, 77);
  check('geometry deterministic', JSON.stringify(g0) === JSON.stringify(g0b));
  check('trunk plus 2-3 branches present', g0.length >= 6 + 2 * 3, String(g0.length));
  check('every segment carries width and darkness',
    g0.every((s) => s.width > 0 && s.dark > 0 && s.dark <= 0.95 &&
      Number.isFinite(s.u0 + s.v0 + s.u1 + s.v1)));

  const widths = g0.map((s) => s.width);
  check('width tapers toward the tip', Math.max(...widths) > 2.5 * Math.min(...widths),
    JSON.stringify(widths));

  const grown = buildCrackGeometry({ ...anchor, stage: MAX_STAGE }, 77);
  const len = (g) => g.reduce((acc, s) => acc + Math.hypot(s.u1 - s.u0, s.v1 - s.v0), 0);
  check('higher stage stretches the crack', len(grown) > len(g0), len(g0).toFixed(2) + ' vs ' + len(grown).toFixed(2));
  check('higher stage darkens the crack', grown[0].dark > g0[0].dark, g0[0].dark + ' vs ' + grown[0].dark);

  // negative-stage and over-stage inputs clamp instead of exploding
  const neg = buildCrackGeometry({ ...anchor, stage: -5 }, 77);
  const over = buildCrackGeometry({ ...anchor, stage: 99 }, 77);
  check('stage inputs clamp safely',
    JSON.stringify(neg) === JSON.stringify(g0) && JSON.stringify(over) === JSON.stringify(grown));
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);


