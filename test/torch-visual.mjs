/* Verify the torch beam visibly lights geometry. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 250)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('torchvis'));
await page.waitForTimeout(1500);

// find a dark zone so the beam contrast is obvious
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  // force blackout-ish conditions: kill all pool lights by arming long blackout
  g.blackoutUntil = g.playtimeSec + 9999;
  g.flashlight.has = true;
  g.flashlight.on = true;
  g.flashlight.battery = 1;
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'shots/torch-on.png' });
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.on = false;
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'shots/torch-off.png' });
console.log('done');
await browser.close();


