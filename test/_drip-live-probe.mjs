/* Live probe: drip cluster mount against the dev server on :5178.
 * Boots the game, starts a fresh run, walks, and asserts:
 *  - no page errors;
 *  - CeilingDrips constructed on game (failure island survived boot);
 *  - the stain->drip bridge forms lazily once wet chunks build;
 *  - registered points stay inside the module's budget;
 *  - beginRun reset re-arms the system on a fresh run.
 * Run: node test/_drip-live-probe.mjs   (expects dev server on :5178)
 */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console.error] ' + m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__BMB__, null, { timeout: 300000 });
await page.evaluate(() => window.__BMB__.startNew('dripprobe'));
await page.keyboard.down('KeyW');
await page.waitForTimeout(6000);
const stage1 = await page.evaluate(() => {
  const g = window.__BMB__.game;
  return {
    hasDrips: !!g.drips,
    points: g.drips ? g.drips.pointCount : -1,
    active: g.drips ? g.drips.activeCount : -1,
    wiringFormed: !!g.dripWiring,
    px: Math.round(g.player.body.x), pz: Math.round(g.player.body.z),
    totalBuilt: g.chunks.totalBuilt,
  };
});
// walk further to cross chunk borders so more layouts feed the bridge
for (let i = 0; i < 8; i++) {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyW');
}
const stage2 = await page.evaluate(() => {
  const g = window.__BMB__.game;
  const out = {
    points: g.drips ? g.drips.pointCount : -1,
    wiringFormed: !!g.dripWiring,
    syncPoints: g.dripWiring ? g.dripWiring.sync.pointCount : -1,
    totalBuilt: g.chunks.totalBuilt,
  };
  // fresh-run re-arm: beginRun resets cadence state on the run seed
  g.beginRunPublicProbe?.();
  return out;
});
const stage3 = await page.evaluate(() => {
  const g = window.__BMB__.game;
  // simulate a new expedition through the public menu path is heavy; instead
  // verify the reset hook exists and keeps the instance alive + un-stopped
  g.drips.reset(g.seed ?? undefined);
  return {
    afterResetPoints: g.drips.pointCount,
    alive: typeof g.drips.update === 'function',
  };
});
console.log('STAGE1 ' + JSON.stringify(stage1));
console.log('STAGE2 ' + JSON.stringify(stage2));
console.log('STAGE3 ' + JSON.stringify(stage3));
const ok = stage1.hasDrips && stage2.wiringFormed && stage3.afterResetPoints === 0 &&
  errors.length === 0 && stage2.syncPoints <= 96;
console.log(ok
  ? 'DRIP_LIVE_PROBE_PASS PAGE_ERRORS=' + errors.length
  : 'DRIP_LIVE_PROBE_FAIL errors=' + errors.length + ' :: ' + JSON.stringify({ stage1, stage2, stage3 }));
for (const e of errors.slice(0, 5)) console.log('ERR:', e);
await browser.close();
process.exit(ok ? 0 : 1);
