/* Weather + entity systems probe. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 250)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('wx'));
await page.waitForTimeout(2000);

const before = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { s: g.mem.sampleAt(g.player.body.x, g.player.body.z), w: g.weather.describe() };
});

// fast-forward weather until front changes
const seqBefore = await page.evaluate(() => (window).__BMB__.game.weather['seq']);
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.weather['t'] = 9999;
});
await page.waitForTimeout(1200);
const seqAfter = await page.evaluate(() => (window).__BMB__.game.weather['seq']);
const after = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { s: g.mem.sampleAt(g.player.body.x, g.player.body.z), w: g.weather.describe() };
});
console.log('WX_BEFORE', JSON.stringify(before));
console.log('WX_AFTER ', JSON.stringify(after));

// entity spawns
const ent = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  // adapted: retry each kind until present — spawnEntity is a silent no-op at
  // the humans.count >= 4 cap, so a single call could be swallowed
  for (let i = 0; i < 6 && !g.humans.figures.some((f) => f.type === 'watcher'); i++) g.spawnEntity('watcher');
  for (let i = 0; i < 6 && !g.humans.figures.some((f) => f.type === 'wanderer'); i++) g.spawnEntity('wanderer');
  return { humans: g.humans.count, types: [...new Set(g.humans.figures.map((f) => f.type))] };
});
console.log('ENTITIES', JSON.stringify(ent));

// helper dialogue
const dlg = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.humans.spawn('helper', g.player.body.x + 2, g.player.body.z, 42);
  return null;
});
void dlg;
await page.waitForTimeout(800);
const dlgState = await page.evaluate(() => {
  // tail rebuilt (recovery truncation): helperDialogue() sets figure.said on
  // the nearest helper within 7 m each playing frame
  const g = (window).__BMB__.game;
  const h = g.humans.nearestOf(g.player.body.x, g.player.body.z, ['helper']);
  return { helpers: g.humans.figures.filter((f) => f.type === 'helper').length, said: !!h && h.said };
});
console.log('DLG', JSON.stringify(dlgState));

// verdicts
const fails = [];
if (!before.s || typeof before.s.intensity !== 'number') fails.push('mem sample missing');
if (!(seqAfter > seqBefore) || after.w === before.w) fails.push('weather front did not roll (' + before.w + ' -> ' + after.w + ')');
if (!(ent.humans >= 1)) fails.push('no figures after spawnEntity');
for (const t of ent.types) {
  if (!['watcher', 'wanderer', 'helper', 'incomplete', 'believer', 'double'].includes(t)) fails.push('bad figure type ' + t);
}
if (!ent.types.includes('watcher')) fails.push('watcher not spawned');
if (!ent.types.includes('wanderer')) fails.push('wanderer not spawned');
if (!(dlgState.helpers >= 1)) fails.push('helper spawn failed');
if (!dlgState.said) fails.push('helper did not speak');
if (fails.length) { console.error('FAIL:', fails.join(', ')); process.exitCode = 1; }
else console.log('probe-weather: PASS');

await browser.close();
