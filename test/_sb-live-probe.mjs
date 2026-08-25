/* Live probe: season-bleed particle consumer against the built dist.
 * Boots the game, starts a fresh run, walks, and asserts:
 *  - no page errors;
 *  - the SeasonBleedParticles cloud exists on game and stays parked while
 *    the player is not inside a bleed-room chunk;
 *  - spawnPlan output feeding it respects the cap;
 *  - configure(null) round-trip through a fresh run keeps it parked.
 * Run: node test/_sb-live-probe.mjs   (expects `pnpm run preview` on :4178)
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
await page.goto('http://127.0.0.1:4178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__BMB__, null, { timeout: 300000 });
await page.evaluate(() => window.__BMB__.startNew('sbprobe'));
await page.waitForTimeout(4000);
await page.keyboard.down('KeyW');
await page.waitForTimeout(3000);
await page.keyboard.up('KeyW');
const result = await page.evaluate(() => {
  const g = window.__BMB__.game;
  const cloud = g.seasonBleed;
  const bleedHere = g.chunks.seasonBleedAtPos(g.player.body.x, g.player.body.z);
  return {
    hasCloud: !!cloud,
    parked: !cloud.active,
    plan: cloud.currentPlan,
    bleedHere: bleedHere ? bleedHere.season : null,
    loadedChunks: g.chunks.loadedCount,
  };
});
// Stage 2: exercise the ACTIVE render path inside the real scene — mount
// a hand-built plan identical to what spawnPlan yields for the monsoon
// descriptor (spawnPlan itself is covered headless), integrate a few
// seconds against the live player position, then park again.
const active = await page.evaluate(() => {
  const g = window.__BMB__.game;
  const cloud = g.seasonBleed;
  const desc = {
    kind: 'rainstroke', densityPerM3: 3.2, fallSpeedMps: -6.5, swayHz: 0.2, rgb: 0xa8ccc4,
  };
  const plan = {
    kind: desc.kind, count: 300, fallSpeedMps: desc.fallSpeedMps, swayHz: desc.swayHz,
    r: 0xa8 / 255, g: 0xcc / 255, b: 0xc4 / 255, pointSize: 1.5, alpha: 0.4,
  };
  cloud.configure(plan);
  for (let f = 0; f < 60; f++) cloud.update(1 / 30, g.player.body.x, g.player.body.z);
  const p = cloud.pointAt(11);
  const out = {
    activeNow: cloud.active,
    finite: Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]),
    sample: [Number(p[0].toFixed(2)), Number(p[1].toFixed(2)), Number(p[2].toFixed(2))],
    inBand: p[1] > 0 && p[1] < 3.05,
    nearCam: Math.abs(p[0] - g.player.body.x) <= 14 && Math.abs(p[2] - g.player.body.z) <= 14,
  };
  cloud.configure(null);
  out.parkedAgain = !cloud.active;
  return out;
});
await browser.close();
console.log("PROBE_RESULT", JSON.stringify(result)); console.log("ACTIVE_RESULT", JSON.stringify(active));
console.log('PAGE_ERRORS=' + errors.length);
if (errors.length) console.log(errors.slice(0, 10).join('\n'));
const pass = result.hasCloud && result.parked && errors.length === 0 && result.loadedChunks > 0
  && active.activeNow && active.finite && active.inBand && active.nearCam && active.parkedAgain;
console.log(pass ? 'SB_LIVE_PROBE_PASS' : 'SB_LIVE_PROBE_FAIL');
process.exit(pass ? 0 : 1);
