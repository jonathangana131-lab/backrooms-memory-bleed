/**
 * Unit test for graffiti evolution (src/world/graffiti-evolution.ts).
 * Standalone (no browser): transpiles the module into a temp dir and drives
 * it with a fake clock + fake localStorage.
 * Run: node test/graffiti-evo-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-graffiti-evo-'));
const js = ts.transpileModule(
  fs.readFileSync(path.join(ROOT, 'src/world/graffiti-evolution.ts'), 'utf8'),
  { fileName: 'graffiti-evolution.ts', compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
fs.writeFileSync(path.join(tmp, 'graffiti-evolution.mjs'), js);
const mod = await import(pathToFileURL(path.join(tmp, 'graffiti-evolution.mjs')).href);
const { createGraffitiEvolution, evolveGraffiti, EVOLVED_GRAFFITI, GRAFFITI_AWAY_MS } = mod;

// --- fakes ---------------------------------------------------------------
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

const POOL = ['GET OUT', 'IT LEARNS', 'STILL HERE'];

{
  const storage = new FakeStorage();
  let t = 0;
  const geo = createGraffitiEvolution(() => t, storage);

  // stage 0 renders the untouched base text
  const first = geo.getText(POOL, '3,-2', 0);
  check('stage 0 returns a base text verbatim', POOL.includes(first), JSON.stringify(first));

  // deterministic selection: same slot -> same text, fresh instance too
  const again = createGraffitiEvolution(() => t, storage).getText(POOL, '3,-2', 0);
  check('same slot is deterministic across instances', first === again);

  // different slots pick from the pool without crashing
  const picks = new Set();
  for (let i = 0; i < 24; i++) picks.add(geo.getText(POOL, '7,1', i));
  check('slot variety stays inside the pool', [...picks].every(p => POOL.includes(p)), [...picks].join('|'));

  // empty pool is safe
  check('empty pool yields empty string', geo.getText([], '9,9', 0) === '');
}

{
  // visit-based advancement
  const storage = new FakeStorage();
  let t = 0;
  const geo = createGraffitiEvolution(() => t, storage);
  const text0 = geo.getText(POOL, '5,5', 0); // registers slot at stage 0

  t += 1000; // quick re-entry: no advance
  check('re-entry within window does not advance', geo.noteChunkEntry('5,5') === false);
  check('text unchanged after quick re-entry', geo.getText(POOL, '5,5', 0) === text0);

  t += GRAFFITI_AWAY_MS; // away >= 5 minutes
  const advanced = geo.noteChunkEntry('5,5') === true;
  check('return after 5+ min advances chunk', advanced);
  const text1 = geo.getText(POOL, '5,5', 0);
  check('text escalated to stage 1', text1 !== text0 && EVOLVED_GRAFFITI[text0][1] === text1, text0 + ' -> ' + text1);

  t += GRAFFITI_AWAY_MS;
  geo.noteChunkEntry('5,5');
  const text2 = geo.getText(POOL, '5,5', 0);
  check('second return reaches final stage', EVOLVED_GRAFFITI[text0][2] === text2, text2);

  t += GRAFFITI_AWAY_MS;
  geo.noteChunkEntry('5,5');
  check('terminal stage holds steady', geo.getText(POOL, '5,5', 0) === text2);
}

{
  // only the entered chunk escalates
  const storage = new FakeStorage();
  let t = 0;
  const geo = createGraffitiEvolution(() => t, storage);
  geo.noteChunkEntry('0,0'); // baseline visits
  geo.noteChunkEntry('1,0');
  const a0 = geo.getText(POOL, '0,0', 0);
  const b0 = geo.getText(POOL, '1,0', 0);
  t += GRAFFITI_AWAY_MS;
  geo.noteChunkEntry('0,0');
  check('other chunks untouched by entry elsewhere', geo.getText(POOL, '1,0', 0) === b0 && geo.getText(POOL, '0,0', 0) !== a0);
}

{
  // persistence through localStorage across instances
  const storage = new FakeStorage();
  let t = 0;
  let geo = createGraffitiEvolution(() => t, storage);
  geo.getText(POOL, '2,2', 3);
  geo.noteChunkEntry('2,2'); // baseline visit
  t += GRAFFITI_AWAY_MS;
  geo.noteChunkEntry('2,2');
  const persisted = createGraffitiEvolution(() => t, storage).getText(POOL, '2,2', 3);
  const raw = JSON.parse(storage.getItem('bmb-graffiti-stages'));
  check('stages persisted under bmb-graffiti-stages', !!raw && typeof raw.stages['2,2:3'] === 'number' && raw.stages['2,2:3'] >= 1, JSON.stringify(raw));
  const resumed = createGraffitiEvolution(() => t, storage);
  check('new instance resumes evolved state', resumed.getText(POOL, '2,2', 3) === persisted, persisted);
  check('resumed slot shows evolved text', persisted.split(' ').length > 1 || EVOLVED_GRAFFITI[persisted], persisted);
}

{
  // EVOLVED_GRAFFITI data shape
  const entries = Object.entries(EVOLVED_GRAFFITI);
  check('at least 6 base texts', entries.length >= 6, String(entries.length));
  check('every chain has 2-3 stages', entries.every(([, v]) => Array.isArray(v) && v.length >= 2 && v.length <= 3));
  check('stage 0 repeats the base verbatim', entries.every(([k, v]) => v[0] === k));
  check('chains escalate (last differs from first)', entries.every(([, v]) => v[v.length - 1] !== v[0]));
}

{
  // fallback escalation for unauthored texts + clamping
  check('unknown base stage 0 is identity', evolveGraffiti('SOME OTHER SCRAWL', 0) === 'SOME OTHER SCRAWL');
  check('unknown base stage 1 repeats once', evolveGraffiti('HUM', 1) === 'HUM HUM');
  check('unknown base clamps at 2 repeats', evolveGraffiti('HUM', 99) === 'HUM HUM HUM');
  check('negative stage clamps to identity', evolveGraffiti('GET OUT', -4) === 'GET OUT');
  check('known chain clamps to last entry', evolveGraffiti('GET OUT', 50) === 'TOO LATE');
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);


