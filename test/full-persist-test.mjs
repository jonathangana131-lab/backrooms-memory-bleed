/* Full persistence round-trip: every new system survives save->continue. */
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

// session 1: set up distinctive state
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.startNew('persist-all');
});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.has = true;
  g.flashlight.battery = 0.66;
  g.consumedBatteries.add('5:5:1234:5678');
  g.seenLandmarks.add('CHAPEL');
  g.seenLandmarks.add('ARCHIVE');
  g.player.teleport(-222, -111, 2.5);
});

const before = await page.evaluate(async () => {
  const g = (window).__BMB__.game;
  await g.saveNow();
  return {
    has: g.flashlight.has,
    battery: +g.flashlight.battery.toFixed(2),
    consumed: [...g.consumedBatteries],
    landmarks: [...g.seenLandmarks],
    pos: [+g.player.body.x.toFixed(0), +g.player.body.z.toFixed(0)],
    discoveries: g.story.discoveries,
    stage: g.story.stage,
  };
});
console.log('BEFORE', JSON.stringify(before));

// reload page entirely
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.game.continueGame());
await page.waitForTimeout(2500);

const after = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return {
    has: g.flashlight.has,
    battery: +g.flashlight.battery.toFixed(2),
    consumed: [...g.consumedBatteries],
    landmarks: [...g.seenLandmarks],
    pos: [+g.player.body.x.toFixed(0), +g.player.body.z.toFixed(0)],
    discoveries: g.story.discoveries,
    stage: g.story.stage,
    pathEchoLen: g.pastSessionPath?.length ?? 'MISSING',
    zoneAmbientActive: g.audio.activeZone !== null || true,
  };
});
console.log('AFTER ', JSON.stringify(after));

const checks = {
  torchOwnership: after.has === before.has && after.has === true,
  batteryLevel: Math.abs(after.battery - before.battery) < 0.02,
  consumedBatteries: JSON.stringify(after.consumed) === JSON.stringify(before.consumed),
  seenLandmarks: JSON.stringify(after.landmarks.sort()) === JSON.stringify(before.landmarks.sort()),
  position: Math.abs(after.pos[0] - before.pos[0]) < 2 && Math.abs(after.pos[1] - before.pos[1]) < 2,
};
console.log('CHECKS', JSON.stringify(checks));
const allOk = Object.values(checks).every(Boolean);
console.log(allOk ? 'PERSIST_ALL_PASS' : 'PERSIST_ALL_FAIL');
await browser.close();


