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


  null, { timeout: 20000 },
);
await shot('flicker-after.png');
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.lighting.flashHoldSec = 0;
  g.mats.fixtureDead.emissiveColor.set(0, 0, 0);
  g.blackoutUntil = g.playtimeSec; // lights come back
});
console.log('[2] flicker swap shots done');

// ---------------------------------------------------------------------
// 3. DISTRICT FOG COLOUR BLEND
// ---------------------------------------------------------------------
const d0 = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  const d = g.chunks.districtAtPos(g.player.body.x, g.player.body.z);
  // settle the blend fully on the CURRENT district (baseline)
  for (let i = 0; i < 60; i++) {
    g.lighting.setDistrictFog(d ?? 0, 1);
    g.lighting.setWeatherTint([1, 1, 1], 1);
  }
  return d ?? 0;
});
await page.waitForTimeout(400);
console.log('[3] baseline district:', d0);
await shot('fog-maze.png'); // whatever the local district is, fully settled

// cross into STORAGE (dark industrial brown): catch the blend mid-flight...
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.lighting.setDistrictFog(4, 0.5); // one boundary-crossing tick
  g.lighting.setWeatherTint([1, 1, 1], 0.5);
});
await shot('fog-blending.png');
// ...then settle it fully
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  for (let i = 0; i < 60; i++) {
    g.lighting.setDistrictFog(4, 1);
    g.lighting.setWeatherTint([1, 1, 1], 1);
  }
});
await page.waitForTimeout(250);
await shot('fog-storage.png');
console.log('[3] district fog shots done');

// ---------------------------------------------------------------------
// 4. SCREEN-SPACE RAIN OVERLAY (CSS)
// ---------------------------------------------------------------------
await page.evaluate(() => { const g = (window).__BMB__.game; g.lighting.setWetZone(false); });
await page.waitForTimeout(300);
await shot('rain-before.png');

await page.evaluate(() => { const g = (window).__BMB__.game; g.lighting.setWetZone(true); });
await page.waitForTimeout(500); // let keyframes animate drops into frame
await shot('rain-on-subtle.png'); // faithful production look (opacity 0.03)

// amplified variant so the geometry of the streaks is inspectable
await page.evaluate(() => {
  document.getElementById('bmb-rain-overlay').style.opacity = '0.6';
});
await shot('rain-on-visible.png');
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  document.getElementById('bmb-rain-overlay').style.opacity = '0.03';
  g.lighting.setWetZone(false);
});
console.log('[4] rain overlay shots done');

await browser.close();
console.log('visual-effects: all shots saved to shots/');


