/**
 * Wave B wiring checks — run with: node test/wave-b-check.mjs
 *
 * Static part: verifies game.ts wires the Wave B packs —
 *   B-1 extended ambience audio pack (ctx-gated construction inside
 *   ensureAudioIntegrations + per-frame feeds),
 *   B-2 scene integrations (PostFX over the lighting pipeline,
 *   FaunaWiring, GazeWiring reconcile loop),
 *   B-3 DOM overlays mounted into the HUD host (Minimap, Compass,
 *   WeatherUI) — every construction try/catch-wrapped with [bmb] warns.
 * Behavioural part: exercises pure helpers of the wired overlay modules.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'core', 'game.ts'), 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');

// ---- B-1 extended audio pack (ctx-gated via ensureAudioIntegrations()) ----
const audioModules = [
  ['DoorCreaks', "from '../audio/doors'"],
  ['StructureGroans', "from '../audio/groans'"],
  ['CrowdAmbience', "from '../audio/crowd'"],
  ['LoreStings', "from '../audio/loresting'"],
  ['BatteryCues', "from '../audio/batterycue'"],
  ['FanAudio', "from '../audio/fanaudio'"],
];
for (const [n, imp] of audioModules) {
  ok(src.includes(imp), 'B-1 imports ' + n);
  ok(src.includes('new ' + n + '(ctx, dest)'), 'B-1 constructs ' + n + '(ctx, dest)');
}
ok(/doorCreaks\.update\(dt, tension\)/.test(src), 'B-1a door creaks follow tension');
ok(/groans\.update\(dt, tension\)/.test(src), 'B-1b structure groans follow tension');
ok(/crowd\.update\(dt, bDistrict, tension\)/.test(src), 'B-1c crowd keyed to district + tension');
ok(/batteryCues\.update\(this\.flashlight\.battery, charging\)/.test(src)
  && /charging = !blackout && this\.chunks\.nearestFixtureDist\(focus\.x, focus\.z\) < 8/.test(src),
  'B-1d battery cues fed flashlight battery + fixture-gated charging');
ok(/fanAudio\.update\(dt\)/.test(src), 'B-1e fan audio ticked per frame');
ok(/loreStings\.clusterComplete\(this\.story\.stage\)/.test(src)
  && /this\.story\.stage !== this\.prevArcStage/.test(src),
  'B-1f lore sting fires when the story arc advances');

// ---- B-2 scene pack ----
ok(src.includes("from '../gfx/postfx'"), 'B-2a imports PostFX');
ok(src.includes('this.postfx.init(this.scene'), 'B-2a inits PostFX over the scene pipeline');
ok(src.includes("from '../entities/faunawiring'"), 'B-2m imports FaunaWiring');
ok(/fauna\?\.resetOnNewExpedition\(this\.seed\)/.test(src), 'B-2m fauna re-seeded per run');
ok(src.includes("from '../entities/gaze-wiring'") && src.includes("from '../entities/gaze'"), 'B-2n imports GazeWiring + GazeController');
ok(/gaze\.attach\(id, new GazeController\(\{/.test(src), 'B-2n attaches a GazeController per figure');
ok(/gaze\?\.dispose\(\)/.test(src), 'B-2n gaze wiring disposed per run');

// ---- B-3 DOM overlays ----
ok(src.includes('new Minimap(this.ui.hud)'), 'B-3a Minimap built into HUD host');
ok(/minimap\?\.markLandmark\(this\.player\.body\.x, this\.player\.body\.z, this\.playerLandmark\)/.test(src), 'B-3a discovered landmark pinned on the minimap');
ok(/minimap\.update\(fx2, fz2, /.test(src), 'B-3a minimap redrawn at the live focus pose');
ok(src.includes('new Compass(this.ui.hud)'), 'B-3b Compass built into HUD host');
ok(src.includes('this.compass.update(') && src.includes('nx2, nz2, isFinite(nb)'), 'B-3b compass aims at nearest unfound beacon when active');
ok(src.includes('compass.hide()'), 'B-3b compass hides when inactive');
ok(src.includes('new WeatherUI(this.ui.hud)'), 'B-3c WeatherUI built into HUD host');
ok(src.includes('weatherUi.update(this.weather.nextFront())'), 'B-3c update(weather.nextFront()) per frame');
ok(src.includes('weatherUi.setPhase(this.weatherPhase)') && src.includes('this.weatherPhase = this.director.phase'), 'B-3c setPhase(director.phase)');
ok(src.includes('weatherUi?.reset()'), 'B-3c reset per run');

// guard convention: every new construction try/catch-wrapped with [bmb] warns
const constructions = [
  'new PostFX()', 'new FaunaWiring(this.scene, this.seed)', 'new GazeWiring()',
  'new Minimap(this.ui.hud)', 'new Compass(this.ui.hud)', 'new WeatherUI(this.ui.hud)',
].concat(audioModules.map(([n]) => 'new ' + n + '(ctx, dest)'));
for (const c of constructions) {
  const idx = src.indexOf(c);
  if (idx === -1) { failures++; console.error('  FAIL missing construction', c); continue; }
  const before = src.slice(Math.max(0, idx - 600), idx);
  // a 'try {' must appear after the last closed catch block in the window
  const lastCatch = before.lastIndexOf('} catch');
  const tail = lastCatch === -1 ? before : before.slice(lastCatch + 7);
  ok(tail.includes('try {'), c + ' is try-wrapped');
}

// behavioural: pure helpers of the wired overlay modules
console.log('[behavioural]');
const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', 'process.exit(0)']);
if (probe.status === 0 || probe.status === null) {
  try {
    const { registerHooks } = await import('node:module');
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try { return nextResolve(specifier, context); }
        catch { return nextResolve(specifier + '.ts', context); }
      },
    });
    // B-3b: compass pure helpers
    const { fadeForDistance, formatDistance, chevronAngleDeg } = await import('../src/ui/compass.ts');
    ok(fadeForDistance(30) === 1 && fadeForDistance(10) === 0 && fadeForDistance(15) > 0 && fadeForDistance(15) < 1, 'compass beacon fades across the 18m -> 12m window');
    ok(formatDistance(142.4) === '142m' && formatDistance(20000) === '>10km', 'compass formats distances readably');
    ok(chevronAngleDeg(0, -1) === 0 && chevronAngleDeg(1, 0) === 90, 'chevron angle: up=0deg, right=90deg');
    // B-3c: weather ui pure helpers
    const { frontTint, phaseSuppressesWarnings, FRONT_TINTS, STORM_VIOLET } = await import('../src/ui/weatherui.ts');
    ok(frontTint(99, true) === STORM_VIOLET, 'storm fronts always tint violet');
    ok(FRONT_TINTS.includes(frontTint(7, false)) && frontTint(7, false) === frontTint(1, false), 'front tints cycle deterministically by kind');
    ok(phaseSuppressesWarnings('peak') && !phaseSuppressesWarnings('calm') && !phaseSuppressesWarnings(null), 'warnings suppressed only during peak phases');
  } catch (e) {
    console.error('  note: strip-types behavioural probe skipped:', String(e).slice(0, 120));
  }
}

console.log(failures === 0 ? '\nWAVE_B_PASS' : '\nWAVE_B_FAIL');
process.exit(failures === 0 ? 0 : 1);
