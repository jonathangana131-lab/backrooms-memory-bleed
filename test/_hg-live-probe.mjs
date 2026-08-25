import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({ executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 180)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__BMB__, null, { timeout: 120000 });
await page.evaluate(() => window.__BMB__.startNew('hg-live'));
await page.waitForTimeout(800);
await page.evaluate(() => window.__BMB__.game.audio.unlock());
await page.waitForTimeout(500);
const restLevel = await page.evaluate(() => window.__BMB__.game.audio.hearingMulLevel);
// inject a real near-miss dump; the GAME's own frame loop must now raise
// the multiplier and feed the ambience bus end-to-end
await page.evaluate(() => {
  const g = window.__BMB__.game;
  g.adrenaline.update(0.016);
  if (!g.adrenaline.pushNearMiss({ severity: 1 })) throw new Error('dump refused');
});
await page.waitForTimeout(450); // past the 0.3s attack: envelope near peak
const peak = await page.evaluate(() => {
  const a = window.__BMB__.game.audio;
  return { level: a.hearingMulLevel, busGain: a.ambienceBus.gain.value, masterGain: a.masterBus.gain.value };
});
await page.waitForTimeout(5200); // attack+decay fully expired
const settled = await page.evaluate(() => {
  const a = window.__BMB__.game.audio;
  return { level: a.hearingMulLevel, busGain: a.ambienceBus.gain.value };
});
console.log(JSON.stringify({ restLevel, peak, settled }));
console.log('PAGE_ERRORS', errors.length, errors.join('|').slice(0, 200));
await browser.close();
