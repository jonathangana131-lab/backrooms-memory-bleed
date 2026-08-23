/* Visual-effects regression shots.
 *
 * Captures BEFORE/AFTER screenshot pairs for each gfx effect into shots/:
 *   1. flashlight beam cone      -> beam-before.png / beam-after.png
 *   2. blackout fixture flicker  -> flicker-before.png / flicker-after.png
 *   3. district fog colour blend -> fog-maze.png / fog-blending.png / fog-storage.png
 *   4. screen-space CSS rain     -> rain-before.png / rain-on-subtle.png / rain-on-visible.png
 *
 * Requires the dev server on 127.0.0.1:5178 (pnpm dev).
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
mkdirSync(ROOT + 'shots', { recursive: true });
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 250)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('visualfx'));
await page.waitForTimeout(1800);

const shot = (name) => page.screenshot({ path: ROOT + 'shots/' + name });

// ---------------------------------------------------------------------
// 1. FLASHLIGHT BEAM CONE
// ---------------------------------------------------------------------
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.blackoutUntil = g.playtimeSec + 99999; // darkness so the cone reads clearly
  g.flashlight.has = true;
  g.flashlight.on = false;
});
await page.waitForTimeout(900);
await shot('beam-before.png');

await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.battery = 1;
  g.flashlight.on = true;
});
await page.waitForTimeout(700);
await shot('beam-after.png');
console.log('[1] beam cone shots done');

// ---------------------------------------------------------------------
// 2. BLACKOUT FIXTURE FLICKER SWAP
//    (already in forced blackout from step 1)
// ---------------------------------------------------------------------
await shot('flicker-before.png');
// hold the single-frame surge long enough to photograph
await page.evaluate(() => { const g = (window).__BMB__.game; g.lighting.flashHoldSec = 2; });
// NOTE: timer polling, not rAF - under swiftshader the render loop can stall
// for seconds, so rAF-driven polling never evaluates and would false-timeout.


