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
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.weather['t'] = 9999;
});
await page.waitForTimeout(1200);
const after = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { s: g.mem.sampleAt(g.player.body.x, g.player.body.z), w: g.weather.describe() };
});
console.log('WX_BEFORE', JSON.stringify(before));
console.log('WX_AFTER ', JSON.stringify(after));

// entity spawns
const ent = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  const rngT = performance.now();
  g.spawnEntity('watcher');
  g.spawnEntity('wanderer');
  return { humans: g.humans.count, types: g.humans.figures.map((f) => f.type) };
});
console.log('ENTITIES', JSON.stringify(ent));

// helper dialogue
const dlg = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.humans.spawn('helper', g.player.body.x + 2, g.player.body.z, 42);
  return null;
});
await page.waitForTimeout(800);
const dlgState = await page.evaluate(() => {


