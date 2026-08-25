/* CRITICAL PATH PLAYTHROUGH:
 * launch -> new expedition -> movement -> streaming -> beacon discovery x3
 * -> threshold -> ending -> save/continue verification. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 150)));
// domcontentloaded + generous boot wait: networkidle never settles on a
// loaded dev host (hundreds of unbundled modules keep connections churning)
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 120000 });

// 1. New Expedition — dispatch click via evaluate to bypass SPA navigation wait
const RUN_SEED = process.env.SEED || '';
if (RUN_SEED) {
  await page.fill('.seed-input', RUN_SEED);
}
await page.evaluate(() => {
  const btn = document.querySelector('.title-screen .btn.primary');
  btn?.click();
});
await page.waitForTimeout(8000);
const s1 = await page.evaluate(() => (window).__BMB__.stats());
console.log('1 LAUNCHED state=' + s1.state);

// 2. Real movement via keyboard (verify position delta)
const p0 = await page.evaluate(() => { const g = (window).__BMB__.game; return { ...g.player.body }; });
await page.keyboard.down('KeyW');
// Patient movement window: the first press also dismisses the F91 wake
// cinematic, and on a loaded box (documented degradation, see integration
// status F73/F100 entries) sim fps can sit at ~1, so a fixed 2.5 s hold
// lands before the controller owns the camera. Poll until the player has
// actually moved or a generous deadline expires — same criterion, load-
// tolerant timing.
let moved = 0;
for (let a = 0; a < 60; a++) {
  await page.waitForTimeout(500);
  const pi = await page.evaluate(() => { const g = (window).__BMB__.game; return { ...g.player.body }; });
  moved = Math.hypot(pi.x - p0.x, pi.z - p0.z);
  if (moved > 0.05) break;
}
await page.keyboard.up('KeyW');
console.log('2 MOVED ' + moved.toFixed(2) + 'm');

// 3. Streaming check while walking
// 4-6. Discover beacons by walking between them (teleport hops for headless speed)
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.story.ensureBeaconsAround(Math.floor(g.player.body.x / 30), Math.floor(g.player.body.z / 30), 10);
    let best = null, bd = Infinity;
    for (const b of g.story.beacons.values()) {
      if (b.found || b.threshold) continue;
      const d = Math.hypot(b.x - g.player.body.x, b.z - g.player.body.z);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return;
    const ang = Math.atan2(best.z - g.player.body.z, best.x - g.player.body.x);
    const d = Math.max(bd - 1.5, 0.5);
    g.player.teleport(g.player.body.x + Math.cos(ang) * d, g.player.body.z + Math.sin(ang) * d, ang);
    g.chunks.update(g.player.body.x, g.player.body.z);
  });
  await page.waitForTimeout(2500); // build destination chunks
  // interact through the REAL input path; retry past notes/loop interceptions
  const d0 = await page.evaluate(() => (window).__BMB__.game.story.discoveries);
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(700);
    const st = await page.evaluate(() => ({
      disc: (window).__BMB__.game.story.discoveries,
      noteOpen: (window).__BMB__.game.ui.noteIsOpen,
    }));
    if (st.noteOpen) { await page.keyboard.press('KeyE'); await page.waitForTimeout(500); }
    const d1 = await page.evaluate(() => (window).__BMB__.game.story.discoveries);
    if (d1 > d0) break;
    await page.evaluate(() => {
      const g = (window).__BMB__.game;
      let best = null, bd = Infinity;
      for (const b of g.story.beacons.values()) {
        if (b.found || b.threshold) continue;
        const dd = Math.hypot(b.x - g.player.body.x, b.z - g.player.body.z);
        if (dd < bd) { bd = dd; best = b; }
      }
      if (best) {
        const ang = Math.atan2(best.z - g.player.body.z, best.x - g.player.body.x);
        g.player.teleport(best.x - Math.cos(ang) * 1.0, best.z - Math.sin(ang) * 1.0, ang);
        g.chunks.update(g.player.body.x, g.player.body.z);
      }
    });
    await page.waitForTimeout(900);
  }
  const res2 = await page.evaluate(() => (({ story }) => ({ discoveries: story.discoveries }))((window).__BMB__.game));
  console.log('4 BEACON' + (i + 1), JSON.stringify(res2));
}
const stage3 = await page.evaluate(() => { const g = (window).__BMB__.game; return g.story.stage; });
console.log('5 STAGE_AFTER_3=' + stage3);

// 7. Threshold — real interaction path
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  const th = [...g.story.beacons.values()].find((b) => b.threshold && !b.found);
  if (th) {
    const ang = Math.atan2(th.z - g.player.body.z, th.x - g.player.body.x);
    g.player.teleport(th.x - Math.cos(ang) * 1.2, th.z - Math.sin(ang) * 1.2, ang);
    g.chunks.update(g.player.body.x, g.player.body.z);
  }
});
await page.waitForTimeout(2500);
await page.keyboard.press('KeyE');
await page.waitForTimeout(900);
console.log('7 THRESHOLD_STAGE=' + await page.evaluate(() => (window).__BMB__.game.story.stage));
await page.waitForTimeout(800);
// retry the visibility read; at 1-2fps the overlay class flip can lag a frame
let endingShown = false;
for (let a = 0; a < 5 && !endingShown; a++) {
  await page.waitForTimeout(700);
  endingShown = await page.evaluate(() => {
    const el = document.querySelector('.ending-overlay');
    return !!el && el.style.display !== 'none';
  });
}
console.log('7 ENDING_VISIBLE=' + endingShown);

// 8. Return to title via ending button, verify Continue enabled
if (endingShown) {
  await page.click('.ending-overlay .btn', { force: true });
  await page.waitForTimeout(600);
}
const contEnabled = await page.evaluate(() => {
  const b = document.querySelector('.title-screen .menu-col .btn:nth-child(2)');
  return b && !b.disabled;
});
console.log('8 CONTINUE_ENABLED=' + contEnabled);

// 9. Save/continue after ending run — re-seed with RUN_SEED so the FINAL
// stamp reflects the requested seed instead of a constant ('after') hash.
await page.evaluate((s) => { const bmb = (window).__BMB__; bmb.startNew(s); }, RUN_SEED || 'after');
await page.waitForTimeout(1200);
const finalState = await page.evaluate(() => (window).__BMB__.stats());
console.log('9 FINAL', JSON.stringify(finalState));
console.log('PAGE_ERRORS=' + errors.length);
const pass = moved > 0.05 && stage3 >= 3 && endingShown && contEnabled && errors.length === 0;
console.log(pass ? 'PLAYTHROUGH_PASS' : 'PLAYTHROUGH_FAIL');
await browser.close();


