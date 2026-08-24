/**
 * Player-movement diagnostic: finds a collision-clear standing cell near
 * spawn, then walks W/S/A/D from it and reports per-direction displacement.
 * Exits 1 when no clear cell exists or any direction fails to move.
 *
 * Head rebuilt (recovery truncation): launch preamble + clear-cell scan via
 * chunks.collidersAround; the walk-test tail survived the harvest intact.
 *
 *   node test/stuck-diag2.mjs   (dev server on 127.0.0.1:5178)
 */
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
await page.evaluate(() => (window).__BMB__.startNew('stuck'));
await page.waitForTimeout(4000);

// clear-cell scan: first point around spawn with >=0.5 m collider clearance
const clear = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  const px = g.player.body.x, pz = g.player.body.z;
  const blocked = (x, z) => {
    for (const b of g.chunks.collidersAround(x, z)) {
      if (x > b.minX - 0.5 && x < b.maxX + 0.5 && z > b.minZ - 0.5 && z < b.maxZ + 0.5) return true;
    }
    return false;
  };
  for (let r = 0; r <= 12; r += 0.75) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      if (!blocked(x, z)) return { x, z };
    }
  }
  return null;
});
console.log('CLEAR_CELL', JSON.stringify(clear));
if (!clear) process.exit(1);

// walk-test from the clear cell in all 4 directions
let minMove = Infinity;
for (const dir of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
  // adapted: fragment referenced a bare `g` that was never in scope here
  await page.evaluate((c) => ((window).__BMB__.game).player.teleport(c.x, c.z, 0), clear);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => { const g = (window).__BMB__.game; return { x: g.player.body.x, z: g.player.body.z }; });
  await page.keyboard.down(dir);
  await page.waitForTimeout(1600);
  await page.keyboard.up(dir);
  const after = await page.evaluate(() => { const g = (window).__BMB__.game; return { x: +g.player.body.x.toFixed(1), z: +g.player.body.z.toFixed(1) }; });
  const d = Math.hypot(after.x - before.x, after.z - before.z);
  if (d < minMove) minMove = d;
  console.log(dir, 'moved=' + d.toFixed(1));
}
await browser.close();

// verdict so the exit status honestly reflects the target: all four
// directions must displace the player (threshold well under a walk step)
if (minMove < 0.25) {
  console.error('STUCK: weakest direction moved only ' + minMove.toFixed(2) + 'm');
  process.exit(1);
}
console.log('stuck-diag2: PASS');
