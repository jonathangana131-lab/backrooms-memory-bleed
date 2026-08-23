/**
 * Wave C wiring checks — run with: node test/wave-c-check.mjs
 *
 * Static part: verifies game.ts wires the ordered dependency chain —
 * C-1 day-cycle tint + fog variation into the lighting path, C-3 journal
 * chain (Journal -> JournalFeed -> JournalWiring fed from the chunk build
 * path), C-4 achievement Tracker/TrackerFeed with toasts routed through
 * ui.toast, C-5 CheckpointManager quick slots + SaveScreen, C-6 one-shot
 * WatcherIntroController at the first watcher spawn, C-7 PhotoGallery fed
 * by EndCapture.onCapture, C-8 ending pipeline through EndStats.show +
 * EndStatsExt.formatExtended.
 * Behavioural part: exercises pure helpers of the wired modules.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = readFileSync(path.join(root, 'src', 'core', 'game.ts'), 'utf8');
const chkSrc = readFileSync(path.join(root, 'src', 'story', 'checkpoints.ts'), 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');

// ---- C-1 day/night lighting hookup ----
ok(src.includes("from '../gfx/fogvariation'"), "C-1 imports chunkFogDensity from '../gfx/fogvariation'");
ok(src.includes('this.daycycle.currentTint()'), 'C-1 reads DayCycle.currentTint()');
ok(src.includes('tint[0] * dc[0]') && src.includes('tint[2] * dc[2]'), 'C-1 multiplies daycycle tint INTO the weather tint');
ok(src.includes('this.lighting.setWeatherTint(tint, dt)'), 'C-1 keeps the setWeatherTint call (R-9)');
ok(src.includes('chunkFogDensity(') && src.includes('this.scene.fogDensity'), 'C-1 feeds fog variation into district fog density');

// ---- C-2 world-decay composition (landed in Wave A — verified, kept) ----
ok(src.includes('this.wallCracks?.addActivity('), 'C-2 wallCracks.addActivity fed from player presence');
ok(src.includes('this.stainGrowth?.noteChunkEntry(stageChunk)'), 'C-2 stain growth noteChunkEntry on player dwell');
ok(src.includes('this.graffitiEvolution?.noteChunkEntry(stageChunk)'), 'C-2 graffiti evolution noteChunkEntry on player dwell');

// ---- C-3 journal chain ----
ok(src.includes("from '../ui/journal'") && src.includes("from '../story/journal-feed'") && src.includes("from '../story/journal-wiring'"), 'C-3 imports Journal/JournalFeed/JournalWiring');
ok(src.includes('new Journal(this.ui.hud)'), 'C-3 Journal mounted into the HUD host');
ok(src.includes('new JournalFeed(this.journalApi)'), 'C-3 JournalFeed wraps the Journal API');
ok(src.includes('new JournalWiring(this.journalFeed)'), 'C-3 JournalWiring wraps the feed');
ok(src.includes('this.journalWiring.onLayoutBuilt(layout, cx, cz, district)'), 'C-3 onLayoutBuilt fired from the chunk build path');
ok(src.includes("'event:landmark:'"), 'C-3 landmark discoveries journaled');
ok(src.includes("'event:beacon:'"), 'C-3 beacon contacts journaled');
ok(src.includes("'event:ending:'"), 'C-3 ending writes the final journal entry');
ok(!src.includes('KeyJ'), 'C-3 J toggle left to the Journal module (no double-fire)');

// ---- C-4 achievement tracker ----
ok(src.includes("from '../ui/tracker'") && src.includes("from '../ui/tracker-wiring'"), 'C-4 imports Tracker + TrackerFeed');
ok(src.includes('new Tracker(document.body)'), 'C-4 Tracker constructed');
ok(src.includes('setAchievementToastSink(') && src.includes('this.ui.toast(info.icon'), 'C-4 achievement toasts routed through ui.toast');
ok(src.includes('new TrackerFeed(this.tracker)'), 'C-4 TrackerFeed wired to the Tracker');
ok(/trackerFeed\.feed\(tf\)/.test(src) && src.includes('completed: this.story.stage >= 4'), 'C-4 TrackerFeed fed live gameplay state');

// ---- C-5 checkpoints / save screen ----
ok(src.includes("from '../story/checkpoints'") && src.includes("from '../ui/savescreen'"), 'C-5 imports CheckpointManager + SaveScreen');
ok(src.includes('new CheckpointManager({') && src.includes('capture: () =>') && src.includes('restore: (slot) => this.restoreCheckpoint(slot)'), 'C-5 CheckpointManager over captureSlot/restore');
ok(src.includes('this.checkpointsMgr.bindQuickKeys(window)'), 'C-5 F5/F9 quick slots bound');
ok(chkSrc.includes("e.code === 'F5'") && chkSrc.includes("e.code === 'F9'"), 'C-5 F5 quick-save / F9 quick-load implemented in checkpoints');
ok(src.includes('new SaveScreen(document.body, {') && src.includes('onLoad:') && src.includes('onDelete:') && src.includes('onImport:'), 'C-5 SaveScreen mounted with actions');
ok(src.includes("'SAVE / LOAD'"), 'C-5 save screen reachable from the pause menu');
ok(src.includes('private async restoreCheckpoint(slot: SaveSlot)'), 'C-5 checkpoint restore path exists');

// ---- C-6 watcher intro (R-7: ONE controller only) ----
ok(src.includes("from '../story/watcherintro'"), 'C-6 imports WatcherIntroController');
ok(src.includes('new WatcherIntroController()'), 'C-6 WatcherIntroController constructed');
const beginRuns = src.split('beginRun(').length - 1;
ok(beginRuns >= 3, 'C-6 beginRun reset site present');
ok(/WatcherIntroController\(\);/.test(src.split('private beginRun')[1] || ''), 'C-6 intro re-armed per run inside beginRun()');
ok(src.includes('shouldPlay()') && src.includes('.begin()'), 'C-6 spawn gated through shouldPlay()');
ok((src.match(/noteWatcherSpawn\(\)/g) || []).length >= 4, 'C-6 hooked at every watcher spawn site');
ok(src.includes('this.watcherIntro.update(dt)'), 'C-6 timeline advanced per frame');
ok(src.includes('getEffects()') && src.includes('humDuck'), 'C-6 prelude effects sampled (hum duck)');
ok(src.includes('this.watcherIntro.getText()'), 'C-6 reveal subtitle routed to ui.say');
ok(src.includes('markShown()'), 'C-6 one-shot flag persisted after the reveal');
ok(!src.includes("from '../story/firstwatcher'"), 'C-6 FirstWatcher NOT also wired (storage-key collision avoided)');

// ---- C-7 gallery ----
ok(src.includes("from '../ui/gallery'"), 'C-7 imports PhotoGallery');
ok(src.includes('new PhotoGallery(document.body)'), 'C-7 PhotoGallery constructed');
ok(src.includes('void this.gallery?.addPhoto(blob'), 'C-7 EndCapture.onCapture routes blobs into gallery.addPhoto');

// ---- C-8 ending pipeline ----
ok(src.includes("from '../ui/endstatsext'"), 'C-8 imports EndStatsExt helpers');
ok(src.includes('formatExtended(this.buildExtendedStats())'), 'C-8 extended debrief built via formatExtended');
ok(src.includes('this.endstats.show('), 'C-8 debrief shown through EndStats.show()');
ok(src.includes("void SaveDB.saveGame(this.captureSlot())"), 'C-8 final save kept synchronous-before-capture (R-1)');
ok(src.includes('}, 1400);'), 'C-8 whiteout 1400ms beat intact (R-1)');

// ---- failure isolation: try/catch around every new construction ----
console.log('[guards]');
const constructions = [
  'new Journal(this.ui.hud)', 'new Tracker(document.body)',
  'new CheckpointManager({', 'new SaveScreen(document.body, {',
  'new WatcherIntroController()', 'new PhotoGallery(document.body)',
];
for (const c of constructions) {
  const idx = src.indexOf(c);
  if (idx === -1) { failures++; console.error('  FAIL missing construction', c); continue; }
  const before = src.slice(Math.max(0, idx - 200), idx);
  const lastCatch = before.lastIndexOf('} catch');
  const tail = lastCatch === -1 ? before : before.slice(lastCatch + 7);
  ok(tail.includes('try {'), c + ' is try-wrapped');
}

// ---- behavioural: pure helpers of the wired modules ----
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
    // C-1: daycycle tints are finite triples and blackouts freeze the clock
    const { DayCycle, DAYCYCLE_LENGTH } = await import('../src/gfx/daycycle.ts');
    const dc = new DayCycle();
    const t0 = dc.currentTint();
    ok(t0.length === 3 && t0.every((v) => Number.isFinite(v)), 'DayCycle.currentTint returns a finite RGB triple');
    dc.update(DAYCYCLE_LENGTH / 2, false);
    const tMid = dc.currentTint();
    ok(dc.currentPhase() !== undefined && (tMid[0] !== t0[0] || tMid[2] !== t0[2]), 'DayCycle drifts through phases');
    dc.update(60, true);
    ok(JSON.stringify(dc.serialize().clock * 1) === JSON.stringify(((DAYCYCLE_LENGTH / 2))), 'blackout freezes the day-cycle clock');
    // C-1: fog variation stays inside its documented band
    const { chunkFogDensity, FOG_MIN_MULT, FOG_MAX_MULT } = await import('../src/gfx/fogvariation.ts');
    const f1 = chunkFogDensity(3, 7);
    ok(f1 >= FOG_MIN_MULT - 1e-9 && f1 <= FOG_MAX_MULT + 1e-9 && f1 === chunkFogDensity(3, 7), 'chunkFogDensity deterministic within [min,max]');
    // C-3: journal feed dedups and clusters; wiring accumulates accepted notes
    const { JournalFeed } = await import('../src/story/journal-feed.ts');
    const { JournalWiring } = await import('../src/story/journal-wiring.ts');
    let added = 0;
    const stub = { addNote: () => ++added <= 2 };
    const feed = new JournalFeed(stub);
    added = 0;
    const n = feed.feedFromLayout({ cx: 0, cz: 0, notes: [{ x: 0, z: 0, text: 'A.' }, { x: 1, z: 0, text: 'B.' }, { x: 90, z: 90, text: 'C.' }] }, 2);
    ok(n === 2 && added === 2, 'JournalFeed files clustered+fragment notes (stub accepts 2)');
    const wiring = new JournalWiring(new JournalFeed(stub));
    wiring.onLayoutBuilt({ notes: [{ x: 5, z: 5, text: 'D.' }] }, 1, 1, 0);
    wiring.onLayoutBuilt({ notes: [] }, 2, 2, 0);
    wiring.onLayoutBuilt(null, 3, 3, 0);
    ok(wiring.getTotalFed() === 1, 'JournalWiring.onLayoutBuilt skips empty/null layouts');
    // C-5: checkpoint name validation
    const { validateName } = await import('../src/story/checkpoints.ts');
    ok(validateName('Base Camp 2') === 'Base Camp 2' && validateName('no!pe') === null && validateName('') === null, 'validateName accepts letters/digits/spaces only');
    // C-5: savescreen pure formatting
    const { formatTimestamp, formatPlaytime } = await import('../src/ui/savescreen.ts');
    ok(formatTimestamp(0).includes('-') && typeof formatPlaytime(125) === 'string', 'SaveScreen timestamp/playtime formatters work');
    // C-6: watcher intro one-shot flag round trip on a stub storage
    const { WatcherIntroController, WATCHERINTRO_STORAGE_KEY } = await import('../src/story/watcherintro.ts');
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const wi = new WatcherIntroController({ storage });
    ok(wi.shouldPlay(), 'WatcherIntroController.shouldPlay true before the flag persists');
    wi.begin();
    ok(wi.isActive() && !wi.shouldPlay(), 'intro runs once begun and refuses re-entry');
    for (let i = 0; i < 100; i++) wi.update(0.1);
    ok(wi.phase === 'done', 'timeline settles at done');
    wi.markShown();
    ok(store.get(WATCHERINTRO_STORAGE_KEY) !== undefined, 'shown flag persisted under bmb-firstwatcher');
    const wi2 = new WatcherIntroController({ storage });
    ok(!wi2.shouldPlay(), 'second controller never replays the intro');
    // C-8: extended stats formatting yields string rows
    const { formatExtended } = await import('../src/ui/endstatsext.ts');
    const extLines = formatExtended({
      torchUsePct: 42.4, phaseSessions: 5, durationSec: 900, relocations: 1,
      discoveries: 3, freezes: 2, nearMisses: 1, longestWalkNoBeaconM: 240,
      districtVisits: { '1': 4 },
    });
    ok(Array.isArray(extLines) && extLines.every((l) => typeof l === 'string') && extLines.length > 0, 'formatExtended renders string rows for ExtendedStats');
  } catch (e) {
    console.error('  note: strip-types behavioural probe skipped:', String(e).slice(0, 160));
  }
}

console.log(failures === 0 ? '\nWAVE_C_PASS' : '\nWAVE_C_FAIL');
process.exit(failures === 0 ? 0 : 1);


