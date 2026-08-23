/* Flashlight acquisition, toggle, drain, recharge verification. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('fl'));
await page.waitForTimeout(2000);

// grant + verify toggle and drain
const r = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.has = true;
  g.flashlight.battery = 1;
  return { on0: g.flashlight.on };
});
// toggle via real F key
await page.keyboard.press('KeyF');
await page.waitForTimeout(1500);
const mid = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { on: g.flashlight.on, battery: +g.flashlight.battery.toFixed(3), intensity: g.flashlight.light.intensity > 0 };
});
console.log('MID', JSON.stringify(mid));
await page.waitForTimeout(2500);
const drained = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { battery: +g.flashlight.battery.toFixed(3) };
});
console.log('DRAINED', JSON.stringify(drained));
// toggle off -> recharges near lit light
await page.keyboard.press('KeyF');
await page.waitForTimeout(3000);
const charged = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { battery: +g.flashlight.battery.toFixed(3), on: g.flashlight.on };
});
console.log('CHARGED', JSON.stringify(charged));
const pass = mid.on === true && mid.intensity === true && drained.battery < mid.battery && charged.battery > drained.battery;
console.log(pass ? 'FLASHLIGHT_PASS' : 'FLASHLIGHT_FAIL');
await browser.close();


