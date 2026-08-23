/* Node-level verification of src/ui/settings.ts: schema defaults, localStorage
 * persistence, validation/clamping, export/import, and change callbacks.
 * The TS module is transpiled in-memory via the repo's typescript package,
 * so this runs without DOM or a browser. */
import { readFileSync } from 'node:fs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'ui', 'settings.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tmpDir = mkdtempSync(join(tmpdir(), 'bmb-settings-'));
const modPath = join(tmpDir, 'settings.mjs');
writeFileSync(modPath, js);
const {
  SettingsManager,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_RANGES,
  validateSettings,
} = await import(modPath);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// --- storage stub mimicking localStorage ---
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}

// 1. defaults when storage is empty
{
  const s = new SettingsManager(new FakeStorage());
  const got = s.settings;
  const ok = Object.keys(DEFAULT_SETTINGS).every((k) => got[k] === DEFAULT_SETTINGS[k]);
  check('defaults-on-empty-storage', ok, JSON.stringify(got));
}

// 2. set() persists under 'bmb-settings' and reload restores
{
  const store = new FakeStorage();
  const s = new SettingsManager(store);
  s.set({ masterVolume: 0.25, fov: 110 });
  check('persist-key-is-bmb-settings', store.getItem(SETTINGS_KEY) !== null);
  const s2 = new SettingsManager(store);
  const got = s2.settings;
  check('roundtrip-reload', got.masterVolume === 0.25 && got.fov === 110, JSON.stringify(got));
}

// 3. missing fields in stored blob fall back to defaults
{
  const store = new FakeStorage();
  store.setItem(SETTINGS_KEY, JSON.stringify({ masterVolume: 0.5 }));
  const s = new SettingsManager(store);
  const got = s.settings;
  check('missing-fields-defaulted',
    got.masterVolume === 0.5 &&
    got.sensitivity === DEFAULT_SETTINGS.sensitivity &&
    got.quality === DEFAULT_SETTINGS.quality &&
    got.fov === DEFAULT_SETTINGS.fov &&
    got.subtitles === DEFAULT_SETTINGS.subtitles &&
    got.showMinimap === DEFAULT_SETTINGS.showMinimap,
    JSON.stringify(got));
}

// 4. clamping of out-of-range numbers + fallback for wrong types
{
  const store = new FakeStorage();
  store.setItem(SETTINGS_KEY, JSON.stringify({
    masterVolume: 7,          // > 1 -> clamp to 1
    sensitivity: -3,          // < 0.1 -> clamp to 0.1
    fov: 9999,                // > 120 -> clamp to 120
    quality: 'ULTRA',         // unknown preset -> default
    subtitles: 'yes',         // not boolean -> default
    showMinimap: 1,           // not boolean -> default
  }));
  const got = new SettingsManager(store).settings;
  check('clamp-volume-high', got.masterVolume === 1);
  check('clamp-sensitivity-low', Math.abs(got.sensitivity - SETTINGS_RANGES.sensitivity.min) < 1e-9);
  check('clamp-fov-high', got.fov === SETTINGS_RANGES.fov.max);
  check('invalid-quality-fallback', got.quality === DEFAULT_SETTINGS.quality);
  check('invalid-booleans-fallback',
    got.subtitles === DEFAULT_SETTINGS.subtitles && got.showMinimap === DEFAULT_SETTINGS.showMinimap);
}

// 4b. NaN / Infinity are rejected to defaults
{
  check('validate-nan-to-default', validateSettings({ fov: NaN }).fov === DEFAULT_SETTINGS.fov);
  check('validate-infinity-to-default', validateSettings({ masterVolume: Infinity }).masterVolume === DEFAULT_SETTINGS.masterVolume);
}

// 5. corrupt JSON falls back cleanly to all defaults
{
  const store = new FakeStorage();
  store.setItem(SETTINGS_KEY, '{not json!!');
  const got = new SettingsManager(store).settings;
  check('corrupt-json-defaults', got.fov === DEFAULT_SETTINGS.fov && got.quality === DEFAULT_SETTINGS.quality);
}

// 6. export/import round-trip
{
  const storeA = new FakeStorage(), storeB = new FakeStorage();
  const a = new SettingsManager(storeA), b = new SettingsManager(storeB);
  a.set({ masterVolume: 0.1, sensitivity: 2.5, quality: 'high', fov: 75, subtitles: false, showMinimap: false });
  const blob = a.exportSettings();
  check('export-is-json-string', typeof blob === 'string' && typeof JSON.parse(blob) === 'object');
  check('import-valid-true', b.importSettings(blob) === true);
  const same = Object.keys(DEFAULT_SETTINGS).every((k) => b.settings[k] === a.settings[k]);
  check('import-roundtrip-equal', same, JSON.stringify(b.settings));
  // imported settings must also be persisted
  check('import-persists', new SettingsManager(storeB).settings.masterVolume === 0.1);
}

// 7. import rejects garbage without touching current settings
{
  const s = new SettingsManager(new FakeStorage());
  s.set({ fov: 100 });
  check('import-bad-json-false', s.importSettings('{oops') === false);
  check('import-nonobject-false', s.importSettings('"just a string"') === false);
  check('import-empty-blob-false', s.importSettings('{}') === false);
  check('import-null-false', s.importSettings('null') === false);
  check('rejected-import-preserves-state', s.settings.fov === 100, JSON.stringify(s.settings));
}

// 8. change callbacks fire on set/reset/import, unsubscribe works
{
  const s = new SettingsManager(new FakeStorage());
  let calls = [];
  const off = s.onChange((snap) => calls.push({ ...snap }));
  s.set({ fov: 95 });
  check('callback-on-set', calls.length === 1 && calls[0].fov === 95);
  off();
  s.set({ fov: 80 });
  check('callback-unsubscribed', calls.length === 1);
  let importCalls = 0;
  s.onChange(() => importCalls++);
  s.importSettings(JSON.stringify({ masterVolume: 0.9 }));
  check('callback-on-import', importCalls === 1);
  s.reset();
  check('callback-on-reset-and-defaults-restored', importCalls === 2 && s.settings.fov === DEFAULT_SETTINGS.fov);
}

// 9. no-DOM guarantee: works with zero storage argument (memory fallback)
{
  const s = new SettingsManager();
  s.set({ sensitivity: 3 });
  check('no-dom-constructor', s.settings.sensitivity === 3);
}

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);


