/* Save -> reload -> continue verification. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('savetest'));
await page.waitForTimeout(2500);
await page.evaluate(() => { const g = (window).__BMB__.game; g.player.teleport(12.3, -8.7, 2.2); });
await page.waitForTimeout(1500);
await page.evaluate(() => (window).__BMB__.saveNow());
await page.waitForTimeout(800);
const before = await page.evaluate(() => {
  const s = (window).__BMB__.stats();
  return { pos: s.pos, seed: s.seed };
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.game.continueGame());
await page.waitForTimeout(3000);
const after = await page.evaluate(() => {
  const s = (window).__BMB__.stats();
  return { pos: s.pos, seed: s.seed, state: s.state };
});
console.log('BEFORE', JSON.stringify(before));
console.log('AFTER ', JSON.stringify(after));
const ok = Math.abs(before.pos[0] - after.pos[0]) < 0.01 && Math.abs(before.pos[1] - after.pos[1]) < 0.01 && before.seed === after.seed;
console.log(ok ? 'SAVE_TEST_PASS' : 'SAVE_TEST_FAIL');
await browser.close();


