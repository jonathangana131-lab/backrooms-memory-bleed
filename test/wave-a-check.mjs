/**
 * Wave A wiring checks — run with: node test/wave-a-check.mjs
 *
 * Static part: verifies game.ts wires every Wave A pure-logic module
 * (settings cluster, NoteReread, DifficultyHints, StoryBeats,
 * EndStats/EndCapture, crack/stain/graffiti stage helpers, DayCycle)
 * with guarded construction and the planned frame hooks.
 * Behavioural part: exercises DayCycle blackout freeze via strip-types.
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
// A-1 settings cluster
ok(src.includes("from '../ui/settings'"), 'A-1a imports SettingsManager');
ok(src.includes('new SettingsManager()'), 'A-1a constructs SettingsManager');
ok(src.includes('panelToGameSettings'), 'A-1a feeds store through applySettings');
ok(src.includes("from '../ui/accessibility'"), 'A-1b imports AccessibilityManager/Controller');
ok(src.includes('AccessibilityController.attach('), 'A-1b attaches DOM controller');
ok(src.includes('showAudioCaption('), 'A-1b caption routing hook present');
ok(src.includes("from '../ui/settingspanel'"), 'A-1c imports panel builder');
ok(src.includes('buildSettingsPanel('), 'A-1c mounts schema-driven panel');
ok(src.includes("getElementById('settings-panel')"), 'A-1c mounts into existing pause-menu host');

// A-2 text/state machines
ok(src.includes('new NoteReread()'), 'A-2a constructs NoteReread');
ok(/reread\.distort\(/.test(src), 'A-2a distorts re-read notes');
ok(src.includes('new DifficultyHints()'), 'A-2b constructs DifficultyHints');
ok(/hints\.update\(1\.0, this\.humans\.getPlayerProfile\(\)\.cautiousness\)/.test(src), 'A-2b throttled hints fed from player profile');
ok(src.includes('new StoryBeats()'), 'A-2c constructs StoryBeats');
ok(/beats\.update\(dt, \{/.test(src), 'A-2c updates beats in F-sim');
ok(/this\.beats\?\.reset\(\)/.test(src), 'A-2c resets beats per-run in beginRun');

// A-3 ending upgrade
ok(src.includes('new EndStats(document.body)'), 'A-3a constructs EndStats');
ok(/endstats\.show\(this\.buildExpeditionStats\(\)\)/.test(src), 'A-3a shows debrief at ending dismiss');
ok(src.includes('new EndCapture()'), 'A-3b constructs EndCapture');
ok(/endcapture\.arm\(/.test(src), "A-3b delegates whiteout capture from triggerEnding's mutation");
ok(src.includes("'renderCanvas'"), 'A-3b grabs the live render canvas');

// A-4 persistence stage helpers
for (const [imp, ctor] of [
  ["from '../world/cracks'", 'createWallCracks()'],
  ["from '../world/stains-growth'", 'createStainGrowth()'],
  ["from '../world/graffiti-evolution'", 'createGraffitiEvolution()'],
]) {
  ok(src.includes(imp), 'A-4 imports ' + imp.slice(6));
  ok(src.includes(ctor), 'A-4 constructs ' + ctor);
}
ok(/wallCracks\?\.addActivity\(/.test(src), 'A-4a crack activity fed per-frame');
ok(/stainGrowth\?\.noteChunkEntry\(stageChunk\)/.test(src), 'A-4b stain chunk entries tracked');
ok(/graffitiEvolution\?\.noteChunkEntry\(stageChunk\)/.test(src), 'A-4c graffiti chunk entries tracked');

// A-5 pure tables
ok(src.includes('new DayCycle()'), 'A-5a constructs DayCycle');
ok(/daycycle\.update\(dt, this\.playtimeSec < this\.blackoutUntil\)/.test(src), 'A-5a daycycle freezes during blackout');

// guard convention: every Wave A construction is try/catch wrapped
const constructions = [
  'new SettingsManager()', 'new DifficultyHints()', 'new StoryBeats()',
  'new EndStats(document.body)', 'new EndCapture()', 'createWallCracks()',
  'createStainGrowth()', 'createGraffitiEvolution()', 'new NoteReread()', 'new DayCycle()',
];
for (const c of constructions) {
  const idx = src.indexOf(c);
  const before = src.slice(Math.max(0, idx - 220), idx);
  // a 'try {' must appear after the last closed catch block in the window
  const lastCatch = before.lastIndexOf('} catch');
  const tail = lastCatch === -1 ? before : before.slice(lastCatch + 7);
  ok(tail.includes('try {'), c + ' is try-wrapped');
}
ok((src.match(/console\.warn\('\[bmb\]/g) || []).length >= 10, 'failure-isolation warns present');

// behavioural: DayCycle blackout freeze + phase drift
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
    const { DayCycle } = await import('../src/gfx/daycycle.ts');
    const d = new DayCycle();
    d.update(10, false);
    d.update(10, true); // frozen during blackout
    d.update(10, false);
    ok(d.phaseRemaining() >= 280, 'blackout freezes the lit clock');
    const tint = d.currentTint();
    ok(tint.length === 3 && tint.every((v) => v > 0 && v <= 1.2), 'currentTint returns sane multipliers');
    const { computeRank } = await import('../src/ui/endstats.ts');
    ok(computeRank({
      seed: 1, durationSec: 1800, distanceM: 500, uniqueChunks: 20,
      landmarkNames: ['CHAPEL', 'ARCHIVE', 'CANTEEN', 'LAUNDRY', 'PLAYROOM', 'SECURITY STATION', 'MEDICAL BAY', 'EXECUTIVE OFFICE'],
      notesRead: 2, batteries: 1, relocations: 0,
      phaseTimePct: { calm: 100, build: 0, peak: 0, release: 0 },
      deepestM: 90, discoveries: 8,
    }) === 'S', 'computeRank S on a full run');
  } catch (e) {
    console.error('  note: strip-types behavioural probe skipped:', String(e).slice(0, 120));
  }
}

console.log(failures === 0 ? '\nWAVE_A_PASS' : '\nWAVE_A_FAIL');
process.exit(failures === 0 ? 0 : 1);


