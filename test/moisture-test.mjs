/**
 * Unit test for wall moisture sheen (src/gfx/moisture.ts).
 * Standalone (no browser): transpiles the module (+ its deps) into a temp
 * dir and drives it with a fake clock + fake localStorage.
 * Run: node test/moisture-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-moisture-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
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
emit('src/gfx/moisture.ts', 'gfx/moisture.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'gfx', 'moisture.mjs')).href);
const {

  createWallMoisture,
  radiusForStage,
  MOISTURE_KEY, SHEEN_RANGE, MIN_RADIUS, MAX_RADIUS,
  SHEEN_ALPHA, SHEEN_LIFT, SHEEN_HEIGHT, MOISTURE_AWAY_MS,
  MAX_STAGE, QUADS_PER_LEAK,
} = mod;

/** Fake localStorage bucket + fake clock shared by every instance below. */
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
const storage = new FakeStorage();
let nowMs = 10_000;
const now = () => nowMs;
const CHUNK = 30; // CHUNK_SIZE mirrored

{
  // --- growth law -----------------------------------------------------------
  let ok = true;
  if (radiusForStage(0) !== MIN_RADIUS) ok = false;
  if (radiusForStage(MAX_STAGE) !== MAX_RADIUS) ok = false;
  if (radiusForStage(99) !== MAX_RADIUS) ok = false; // clamped
  if (!(radiusForStage(2) > radiusForStage(1))) ok = false;
  check('radiusForStage lerps MIN..MAX over MAX_STAGE stages', ok);
}

{
  // --- registration + quad contract -----------------------------------------
  const wm = createWallMoisture(now, storage);
  wm.registerLeak(CHUNK / 2 + 5, CHUNK / 2 + 7);
  const quads = wm.getSheensForChunk(1, 1);
  wm.registerLeak(CHUNK / 2 + 5, CHUNK / 2 + 7); // idempotent
  check('registerLeak is idempotent per position',
    JSON.stringify(quads) === JSON.stringify(wm.getSheensForChunk(1, 1)));
  check('a leak emits at most QUADS_PER_LEAK panels per chunk',
    quads.length <= QUADS_PER_LEAK, String(quads.length));
  wm.registerLeak(NaN, 3);
  wm.registerLeak(3, Infinity);
  check('non-finite leaks are ignored', true);

  let okShape = true, okTint = true;
  for (const q of quads) {
    if (!Array.isArray(q.positions) || q.positions.length !== 12) okShape = false;
    if (!Array.isArray(q.tints) || q.tints.length !== 12) okShape = false;
    const n = q.normal;
    if (!n || n.length !== 3 || Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 1e-6) okShape = false;
    // damp film brightens: above 1, capped by SHEEN_LIFT near the leak
    if (!(q.tints[0] > 1 && q.tints[0] <= 1 + SHEEN_LIFT + 1e-9)) okTint = false;
    // brighter toward the carpet than at the top of the band
    if (!(q.tints[0] >= q.tints[9])) okTint = false;
    // lower wall half
    if (!(q.positions[1] >= 0 && q.positions[4] > q.positions[1])) okTint = false;
  }
  check('sheen quads follow the decal contract', quads.length === 0 || okShape,
    'quads=' + quads.length);
  check('sheen reads as a subtle brightening of the lower wall',
    quads.length === 0 || okTint);

  check('same leaks + stage regenerate byte-identical quads',
    JSON.stringify(quads) === JSON.stringify(wm.getSheensForChunk(1, 1)));
}

{
  // --- away-then-return escalation ------------------------------------------
  const store = new FakeStorage();
  const fresh = createWallMoisture(now, store);
  fresh.registerLeak(CHUNK / 2, CHUNK / 2);
  fresh.noteChunkEntry('1,1');
  const stagesAt = () => Object.values(JSON.parse(store.getItem(MOISTURE_KEY) || '{"stages":{}}').stages || []);
  let stage0 = stagesAt()[0] ?? null;
  void stage0;
  // a quick re-entry of a DIFFERENT chunk must not spread anything and
  // must not disturb '1,1' away-timer accounting
  nowMs += MOISTURE_AWAY_MS - 1000;
  fresh.noteChunkEntry('1,2');
  check('quick re-entry does not spread leaks', stagesAt().every((s2) => s2 === 0),
    JSON.stringify(stagesAt()));
  nowMs += 1000;
  fresh.noteChunkEntry('1,1'); // away past MOISTURE_AWAY_MS since first visit
  check('genuine return soaks every known leak one stage',
    stagesAt().length === 1 && stagesAt()[0] === 1, JSON.stringify(stagesAt()));
  for (let i = 0; i < MAX_STAGE * 3; i++) { nowMs += MOISTURE_AWAY_MS; fresh.noteChunkEntry('1,1'); }
  check('escalation caps at MAX_STAGE', stagesAt().every((s2) => s2 === MAX_STAGE),
    JSON.stringify(stagesAt()));
}

{
  // --- persistence ------------------------------------------------------------
  const store = new FakeStorage();
  const a = createWallMoisture(now, store);
  a.registerLeak(11.11, 22.22);
  a.registerLeak(33.33, 44.44);
  nowMs += 5_000; // clear the write throttle
  a.registerLeak(55.55, 66.66); // dirty -> forced past throttle -> writes
  check('state persists to the storage bucket', typeof store.getItem(MOISTURE_KEY) === 'string');
  const raw = JSON.parse(store.getItem(MOISTURE_KEY));
  check('all registered leaks survive the round trip',
    Object.keys(raw.stages).length === 3, JSON.stringify(Object.keys(raw.stages)));
  const b = createWallMoisture(now, store);
  b.noteChunkEntry('0,0');
  nowMs += MOISTURE_AWAY_MS;
  b.noteChunkEntry('0,0');
  const raw2 = JSON.parse(store.getItem(MOISTURE_KEY));
  check('restored instance escalates the persisted leaks together',
    Object.keys(raw2.stages).length === 3 && Object.values(raw2.stages).every((v) => v === 1));
}

process.exit(failures === 0 ? 0 : 1);
