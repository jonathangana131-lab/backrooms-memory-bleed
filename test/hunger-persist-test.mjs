/* F73 persistence round-trip through the live game: the hunger pang clock
 * rides the save slot, so a continued expedition resumes its elapsed-hunger
 * pacing (restored clockMin ~= playtimeSec/60, no instant-fire storm) while
 * legacy fields keep passing. Requires the dev server on :5178.
 * Run: node test/hunger-persist-test.mjs  (prints HUNGER_PERSIST_PASS)
 */
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

// session 1: fresh run aged to 45 minutes of session clock so the pang
// schedule is well past its 10-minute grace period.
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.startNew('hunger-persist');
});
await page.waitForTimeout(800);
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.playtimeSec = 45 * 60; // the frame loop feeds hunger.update(playtimeSec / 60)
});
await page.waitForTimeout(500);

const before = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return {
    clock: g.hunger?.serialize?.().clockMin ?? null,
    nextPang: g.hunger?.serialize?.().nextPangAtMin ?? null,
    slotHasHunger: !!g.captureSlot().hunger,
    slotClock: g.captureSlot().hunger?.clockMin ?? null,
  };
});
console.log('BEFORE', JSON.stringify(before));
await page.evaluate(() => (window).__BMB__.game.saveNow());

// reload page entirely, then continue from the slot
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.game.continueGame());
await page.waitForTimeout(1500);

const after = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  const s = g.hunger?.serialize?.() ?? {};
  return {
    clock: s.clockMin ?? null,
    nextPang: s.nextPangAtMin ?? null,
    playtimeMin: g.playtimeSec / 60,
  };
});
console.log('AFTER ', JSON.stringify(after));

const checks = {
  capturedClockAged: before.clock !== null && Math.abs(before.clock - 45) < 2,
  slotCarriesHunger: before.slotHasHunger && Math.abs(before.slotClock - 45) < 2,
  resumedClockContinues: after.clock !== null && after.clock >= 45 - 2,
  noInstantFireStorm: after.nextPang === null || after.nextPang >= after.clock - 0.5,
};
console.log('CHECKS', JSON.stringify(checks));
const allOk = Object.values(checks).every(Boolean);
console.log(allOk ? 'HUNGER_PERSIST_PASS' : 'HUNGER_PERSIST_FAIL');
process.exit(allOk ? 0 : 1);
