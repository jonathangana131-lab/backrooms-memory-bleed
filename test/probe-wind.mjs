/* Look down via player.pitch (persists across frames). */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('qa'));
await page.waitForTimeout(3000);

await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.player.pitch = 1.5;
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/down-cull.png' });

await page.evaluate(() => {
  const g = (window).__BMB__.game;
  for (const m of g.scene.meshes) if (m.material && m.material.backFaceCulling !== undefined) m.material.backFaceCulling = false;
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/down-nocull.png' });

// look up too
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.player.pitch = -1.5;
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/up-cull.png' });
console.log('ok');
await browser.close();


