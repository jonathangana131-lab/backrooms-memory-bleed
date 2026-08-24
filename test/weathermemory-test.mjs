/**
 * Unit test for weather memory (src/world/weathermemory.ts, F52).
 * Standalone (no browser): transpiles the module + its rng dependency into
 * a temp dir and drives the injected-storage ledger directly.
 *
 * Acceptance:
 *   1. storage round-trip — save→load reproduces the ledger identically
 *      (cross-session), including arbitrary stable room keys
 *   2. exact exponential decay — residue is exactly intensity × decay^n
 *      across session counts, floored at zero / epsilon
 *   3. overwrite semantics — new rain overwrites keys it touches with a
 *      fresh session stamp; untouched keys keep decaying from old stamps
 *   4. determinism per seed — rollRoomDrip is identical across instances,
 *      varies with seed
 *   5. robustness — corrupt / foreign-version / malformed / throwing
 *      storage all degrade to an empty ledger; load never throws
 *
 * Run: node test/weathermemory-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-weathermemory-'));
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/world/weathermemory.ts', 'world/weathermemory.mjs');

const wm = await import(pathToFileURL(path.join(tmp, 'world', 'weathermemory.mjs')).href);
const {
  WEATHER_MEMORY_VERSION, WEATHER_MEMORY_STORAGE_KEY,
  DRIP_DECAY_PER_SESSION, RESIDUE_EPSILON,
  createWeatherMemory, validateWeatherMemory, loadWeatherMemory, saveWeatherMemory,
  recordRainDrips, decayResidue, roomDrip, rollRoomDrip,
} = wm;

/** In-memory storage pair mimicking localStorage semantics. */
function makeStorage() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v); },
    dump: () => map.get(WEATHER_MEMORY_STORAGE_KEY),
  };
}

/* ------------------------------------------------------------------ */
/* 1. Storage round-trip                                               */
/* ------------------------------------------------------------------ */
{
  const store = makeStorage();
  let mem = createWeatherMemory();
  mem = recordRainDrips(mem, [
    { roomKey: '3,-2', intensity: 0.9 },
    { roomKey: '10,4', intensity: 0.35 },
    { roomKey: '-7,0', intensity: 0.5 },
  ], 2);
  saveWeatherMemory(store, mem);

  // Cross-session: a fresh process would load from storage.
  const reloaded = loadWeatherMemory(store);
  check('round-trip deep-equal',
    JSON.stringify(reloaded) === JSON.stringify(mem),
    JSON.stringify(reloaded));

  check('round-trip version stamped', reloaded.version === WEATHER_MEMORY_VERSION);
  check('stable key 3,-2 present', roomDrip(reloaded, '3,-2', 2) === 0.9);
  check('stable key -7,0 present', roomDrip(reloaded, '-7,0', 2) === 0.5);

  // Round-trip through JSON-string storage (localStorage stores strings).
  const stringStore = makeStorage();
  stringStore.set(WEATHER_MEMORY_STORAGE_KEY, JSON.stringify(JSON.parse(JSON.stringify(mem))));
  const fromString = loadWeatherMemory(stringStore);
  check('string-storage round-trip',
    JSON.stringify(fromString.drips['3,-2']) === '{"intensity":0.9,"session":2}');

  // Missing key degrades to empty, not throw.
  check('missing storage -> empty',
    loadWeatherMemory(makeStorage()).drips &&
    Object.keys(loadWeatherMemory(makeStorage()).drips).length === 0);
}

/* ------------------------------------------------------------------ */
/* 2. Exact exponential decay                                          */
/* ------------------------------------------------------------------ */
{
  const mem = recordRainDrips(createWeatherMemory(), [{ roomKey: 'r', intensity: 0.8 }], 5);
  for (let since = 0; since <= 6; since++) {
    const want = 0.8 * Math.pow(DRIP_DECAY_PER_SESSION, since);
    const got = decayResidue(0.8, since);
    check(`exact decay n=${since}`, got === want, `got ${got}, want ${want}`);
    check(`roomDrip session ${5 + since}`,
      roomDrip(mem, 'r', 5 + since) === want);
  }
  // Custom decay factor.
  check('custom decay 0.25^3',
    decayResidue(0.64, 3, 0.25) === 0.64 * Math.pow(0.25, 3));
  // Floor at zero.
  check('floor zero intensity', decayResidue(-3, 0) === 0);
  check('floor NaN intensity', Number.isFinite(decayResidue(NaN, 0)) && decayResidue(NaN, 0) === 0);
  // Epsilon snap: sub-visible residue vanishes.
  const tiny = RESIDUE_EPSILON / 4;
  check('epsilon snap to zero', decayResidue(tiny, 10) === 0 && tiny > 0);
  // Future-stamped record replays at full intensity (sessionsSince clamps).
  check('future stamp clamps to full', roomDrip(mem, 'r', 2) === 0.8);
  // Missing room drips nothing.
  check('missing room -> 0', roomDrip(mem, 'nowhere', 99) === 0);
}

/* ------------------------------------------------------------------ */
/* 3. Overwrite semantics                                              */
/* ------------------------------------------------------------------ */
{
  let mem = recordRainDrips(createWeatherMemory(), [
    { roomKey: 'A', intensity: 0.9 },
    { roomKey: 'B', intensity: 0.6 },
  ], 0);
  // Session 3 rains again over A only.
  mem = recordRainDrips(mem, [{ roomKey: 'A', intensity: 0.4 }], 3);

  // A uses the fresh stamp: at session 5 it decays 2 steps from 0.4.
  check('touched key overwritten',
    roomDrip(mem, 'A', 5) === 0.4 * Math.pow(DRIP_DECAY_PER_SESSION, 2));
  // B keeps its session-0 stamp and keeps decaying.
  check('untouched key keeps old stamp',
    roomDrip(mem, 'B', 5) === 0.6 * Math.pow(DRIP_DECAY_PER_SESSION, 5));
  // Input untouched (pure).
  const before = recordRainDrips(createWeatherMemory(), [{ roomKey: 'A', intensity: 0.9 }], 0);
  const after = recordRainDrips(before, [{ roomKey: 'A', intensity: 0.4 }], 3);
  check('recordRainDrips pure', before.drips.A.intensity === 0.9 && after !== before);
  // Invalid entries skipped, invalid session no-op.
  const junked = recordRainDrips(createWeatherMemory(), [
    { roomKey: 'X', intensity: -1 },
    { roomKey: 'Y', intensity: NaN },
    { roomKey: 'Z', intensity: 0 },
  ], 1);
  check('invalid entries skipped', Object.keys(junked.drips).length === 0);
  const badSession = recordRainDrips(createWeatherMemory(), [{ roomKey: 'Q', intensity: 1 }], -2);
  check('negative session no-op', Object.keys(badSession.drips).length === 0);
}

/* ------------------------------------------------------------------ */
/* 4. Determinism per seed                                             */
/* ------------------------------------------------------------------ */
{
  const rooms = ['0,0', '1,2', '-3,4'];
  const a = rooms.map((r) => rollRoomDrip(r, 12345));
  const b = rooms.map((r) => rollRoomDrip(r, 12345));
  check('same seed identical', JSON.stringify(a) === JSON.stringify(b));
  check('intensities in [0,1)', a.every((v) => v >= 0 && v < 1));
  const c = rooms.map((r) => rollRoomDrip(r, 999));
  check('different seed varies', JSON.stringify(a) !== JSON.stringify(c));
  check('rooms vary within a seed',
    new Set(a).size === a.length || new Set(c).size === c.length);
}

/* ------------------------------------------------------------------ */
/* 5. Robustness: corrupt / foreign / throwing storage                 */
/* ------------------------------------------------------------------ */
{
  const cases = [
    ['corrupt json string', '{not json'],
    ['corrupt truncated object', '{"version":1,"drips":{"a":{"intens'],
    ['foreign version', JSON.stringify({ version: 99, drips: {} })],
    ['wrong type', 42],
    ['null payload', null],
    ['array payload', []],
    ['malformed records', JSON.stringify({ version: 1, drips: { a: { intensity: 'big', session: 0 } } })],
    ['negative session record', JSON.stringify({ version: 1, drips: { a: { intensity: 1, session: -1 } } })],
    ['zero intensity record', JSON.stringify({ version: 1, drips: { a: { intensity: 0, session: 0 } } })],
    ['non-integer session', JSON.stringify({ version: 1, drips: { a: { intensity: 1, session: 1.5 } } })],
  ];
  for (const [name, payload] of cases) {
    const store = makeStorage();
    store.set(WEATHER_MEMORY_STORAGE_KEY, payload);
    try {
      const m = loadWeatherMemory(store);
      const empty = Object.keys(m.drips ?? {}).length === 0 && m.version === WEATHER_MEMORY_VERSION;
      check(`robust: ${name}`, empty, JSON.stringify(m));
    } catch (e) {
      check(`robust: ${name}`, false, String(e));
    }
  }

  const throwingGet = { get() { throw new Error('boom'); }, set() {} };
  try {
    const m = loadWeatherMemory(throwingGet);
    check('robust: throwing get', Object.keys(m.drips).length === 0);
  } catch (e) {
    check('robust: throwing get', false, String(e));
  }
}

// Validator direct hits.
check('validate accepts good', validateWeatherMemory({ version: 1, drips: { a: { intensity: 1, session: 0 } } }) !== null);
check('validate rejects junk', validateWeatherMemory('x') === null);
check('save fails loud on set failure', (() => {
  try {
    saveWeatherMemory({ get: () => undefined, set() { throw new Error('disk'); } }, createWeatherMemory());
    return false;
  } catch {
    return true;
  }
})());

console.log(failures === 0 ? 'WEATHERMEMORY_PASS' : `WEATHERMEMORY_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
