/* Persistence stress: rapid save/load cycles must not corrupt state. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
let pageErrs = 0;
page.on('pageerror', () => pageErrs++);
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.startNew('stress-save');
});
await page.waitForTimeout(1500);

// rapid-fire save/load cycles with distinct state each round
let allOk = true;
for (let round = 1; round <= 5; round++) {
  await page.evaluate((r2) => {
    const g = (window).__BMB__.game;
    g.player.teleport(r2 * 10, -r2 * 5, r2 * 0.5);
    g.flashlight.has = true;
    g.flashlight.battery = r2 / 10;
    g.consumedBatteries.add('9:9:' + r2);
    g.seenLandmarks.add('CHAPEL');
    void r2;
  }, round);
  // fire multiple saves back-to-back without awaiting
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.saveNow(); g.saveNow(); g.saveNow();
  });
  await page.waitForTimeout(1400);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  await page.evaluate(() => (window).__BMB__.game.continueGame());
  await page.waitForTimeout(1200);

(Showing lines 1-40 of 56. Use offset=41 to continue.)

