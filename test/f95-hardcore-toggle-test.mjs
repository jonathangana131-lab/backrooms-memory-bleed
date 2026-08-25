/**
 * F95 hardcore flicker battery — settings/a11y schema toggle tests (v1.1
 * debt payoff). Pure Node, no GPU. Verifies the whole chain:
 *   schema      DEFAULT_SETTINGS.hardcoreBattery === false, validateSettings
 *               round-trips booleans and falls back on junk;
 *   panel store settingsStoreAdapter claims/routes the new key into the
 *               SettingsManager (validation included) and defaultSections()
 *               renders it as a HARDCORE BATTERY toggle row;
 *   battery     FlickerBattery.setHardcore flips hudSuppressed, frames go
 *               identity while off, deterministic per (tick, seed) while on,
 *               and the critical band actually sputters (mixed on/off);
 *   torch       Flashlight honours the F95 external drive under NullEngine:
 *               cut parks the light exactly like torch-off, dim scales the
 *               normal intensity math, identity values change nothing;
 *   wiring      game.ts routes the store change -> applyHardcoreBattery,
 *               re-applies the persisted mode in beginRun, samples the
 *               seeded drive every playing frame, and suppresses the HUD
 *               battery readout while the mode is on.
 * Run: node test/f95-hardcore-toggle-test.mjs  (prints ALL PASS, exits 0)
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; }
  else { failures++; console.error('FAIL:', msg); }
};

const here = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------- schema --- */

const {
  DEFAULT_SETTINGS,
  validateSettings,
  SettingsManager,
} = await import('../src/ui/settings.ts');

ok(DEFAULT_SETTINGS.hardcoreBattery === false, 'default hardcoreBattery is false');
const rt = validateSettings({ hardcoreBattery: true });
ok(rt.hardcoreBattery === true, 'validateSettings keeps explicit true');
const junk = validateSettings({ hardcoreBattery: 'yes' });
ok(junk.hardcoreBattery === false, 'non-boolean hardcoreBattery falls back to default');
const missing = validateSettings({});
ok(missing.hardcoreBattery === false, 'missing hardcoreBattery falls back to default');
ok(validateSettings(null).hardcoreBattery === false, 'null payload falls back to default');

/* -------------------------------------------------------- panel store --- */

const { settingsStoreAdapter, defaultSections } =
  await import('../src/ui/settingspanel.ts');

const mgr = new SettingsManager();
const store = settingsStoreAdapter(mgr);
ok(store.owns('hardcoreBattery') === true, 'adapter claims the hardcoreBattery key');
ok(store.get('hardcoreBattery') === false, 'adapter reads the default');
store.set({ hardcoreBattery: true });
ok(mgr.settings.hardcoreBattery === true, 'adapter write reaches the manager');
store.resetKeys(['hardcoreBattery']);
ok(mgr.settings.hardcoreBattery === false, 'section reset restores the default');

const visuals = defaultSections().find((s) => s.id === 'visuals');
ok(visuals !== undefined, 'VISUALS section exists');
const rowSpec = visuals.controls.find((c) => c.key === 'hardcoreBattery');
ok(rowSpec !== undefined && rowSpec.kind === 'toggle', 'HARDCORE BATTERY renders as a toggle row');
ok(visuals.controls.filter((c) => c.key === 'hardcoreBattery').length === 1,
  'toggle appears exactly once in the schema');

/* ----------------------------------------------------------- battery ---- */

const { FlickerBattery, STEADY_MIN_CHARGE } =
  await import('../src/player/flickerbattery.ts');

const fb = new FlickerBattery(0x5eed);
ok(fb.hardcore === false && fb.hudSuppressed === false, 'battery boots softcore');
fb.setHardcore(true);
ok(fb.hudSuppressed === true, 'setHardcore(true) suppresses the HUD readout');
ok(fb.hardcore === true, 'setHardcore(true) latches the flag');
fb.setHardcore(false);
ok(fb.hudSuppressed === false, 'opt-out clears suppression');
ok(JSON.stringify(fb.frame(0.1, 7)) === JSON.stringify({ on: true, dim: 1 }),
  'softcore frames are identity even in the critical band');

fb.setHardcore(true);
ok(JSON.stringify(fb.frame(0.9, 123)) === JSON.stringify({ on: true, dim: 1 }),
  'steady band stays rock solid');
ok(STEADY_MIN_CHARGE === 0.5, 'steady threshold unchanged');
const f1 = fb.frame(0.05, 42);
const f2 = fb.frame(0.05, 42);
ok(f1.on === f2.on && f1.dim === f2.dim, 'frames are deterministic per (tick, seed)');
let ons = 0; let offs = 0; let dimsOk = true;
for (let t = 0; t < 600; t++) {
  const fr = fb.frame(0.05, t);
  if (fr.on) { ons++; if (fr.dim !== 1 && !(fr.dim >= 0.15 && fr.dim <= 1)) dimsOk = false; }
  else offs++;
}
ok(ons > 0 && offs > 0, 'critical band sputters (mixed on/off over 600 ticks)');
ok(dimsOk, 'surviving critical dims stay in the documented range');
fb.setHardcore(false);

/* ------------------------------------------------------------- torch ---- */

// Flashlight pulls Babylon; NullEngine keeps it headless. Loaded AFTER the
// pure-schema checks so any loader trouble cannot mask logic results.
try {
  // Flashlight's Babylon imports are bundler-style (extensionless), so load
  // it through Vite's SSR resolver against a headless NullEngine.
  const { createServer } = await import('vite');
  const root = path.resolve(here, '..');
  const server = await createServer({
    root,
    logLevel: 'error',
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const B = await server.ssrLoadModule('@babylonjs/core');
    const { Flashlight } = await server.ssrLoadModule('/src/player/flashlight.ts');
    const engine = new B.NullEngine();
    const scene = new B.Scene(engine);
    const fl = new Flashlight(scene);
    fl.has = true; fl.on = true; fl.battery = 0.6;

    fl.flickerCut = true; fl.flickerDim = 0;
    fl.update(0.016, 1.0, 0, 0, 0, 0, false);
    ok(fl.light.intensity === 0, 'F95 cut parks the beam (intensity 0)');
    ok(fl.light.position.y === -50, 'F95 cut parks the light off-stage');

    fl.flickerCut = false; fl.flickerDim = 0.5;
    fl.update(0.016, 1.1, 0, 0, 0, 0, false);
    ok(Math.abs(fl.light.intensity - 7.5) < 1e-6,
      'dim scales the normal drive (15 * 0.5 at healthy charge)');

    fl.flickerCut = false; fl.flickerDim = 1;
    fl.update(0.016, 1.2, 0, 0, 0, 0, false);
    ok(Math.abs(fl.light.intensity - 15) < 1e-6, 'identity drive leaves the beam untouched');

    // junk dim clamps, never NaNs the pipeline (junk reads as full)
    fl.flickerDim = Number.NaN;
    fl.update(0.016, 1.3, 0, 0, 0, 0, false);
    ok(Number.isFinite(fl.light.intensity) && fl.light.intensity === 15,
      'NaN dim falls back to identity brightness instead of poisoning the light');
    try { scene.dispose(); engine.dispose(); } catch { /* headless teardown */ }
  } finally {
    await server.close();
  }
} catch (e) {
  failures++;
  console.error('FAIL: NullEngine torch stage threw:', e && e.message);
}

/* ----------------------------------------------------------- wiring ----- */

const gameSrc = readFileSync(path.join(here, '../src/core/game.ts'), 'utf8');
ok(gameSrc.includes('this.applyHardcoreBattery(gs);'),
  'settings-change callback routes the toggle to the battery');
ok(/applyHardcoreBattery\(gs\?: GameSettings\)/.test(gameSrc),
  'helper reads the canonical store');
ok(/this\.flickerBattery = new FlickerBattery\([\s\S]{0,120}this\.applyHardcoreBattery\(\);/.test(gameSrc),
  'beginRun re-applies the persisted mode onto the fresh battery');
ok(/flickerCut = false;\s*\n\s*this\.flashlight\.flickerDim = 1;/.test(gameSrc),
  'beginRun resets the torch drive to identity');
ok(gameSrc.includes('this.flickerBattery.frame('),
  'frame loop samples the seeded drive every playing frame');
ok(/!hardcoreHud && this\.flashlight\.has \? this\.flashlight\.battery : null/.test(gameSrc),
  'HUD battery readout suppressed while hardcore is on');

/* ------------------------------------------------------------ report ---- */

console.log(`f95-hardcore-toggle-test: ${passes}/${passes + failures}` +
  (failures === 0 ? ' ALL PASS' : ` ${failures} FAILURES`));
process.exitCode = failures === 0 ? 0 : 1;
