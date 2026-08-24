/* F4 HARDWARE-GL QA SWEEP:
 * Same critical path as playthrough.mjs but on real GPU (ANGLE Metal,
 * never SwiftShader), 960x540, six evidence screenshots into shots/hwgl/.
 * Pass = full flow + zero page errors + WebGL context reports a real
 * vendor (not SwiftShader/llvmpipe). */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OUT = process.env.HOME + '/Projects/backrooms-memory-bleed-recovered/shots/hwgl';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

// GPU truth from inside the page
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : 'none');
  return String(renderer);
});
console.log('GPU_RENDERER=' + gpu);
const realGpu = !/swiftshader|llvmpipe|software/i.test(gpu);

let shot = 0;
async function snap(name) {
  await page.screenshot({ path: `${OUT}/${String(++shot).padStart(2, '0')}-${name}.png` });
  console.log(`SHOT ${shot} ${name}`);
}

// 1. title screen on hardware GL
await snap('title');
const RUN_SEED = process.env.SEED || '';
if (RUN_SEED) await page.fill('.seed-input', RUN_SEED);
await page.evaluate(() => { document.querySelector('.title-screen .btn.primary')?.click(); });
await page.waitForTimeout(8000);
const s1 = await page.evaluate(() => (window).__BMB__.stats());
console.log('1 LAUNCHED state=' + s1.state);

// 2. spawn render
await snap('spawn');

// 3. real movement + corridor render mid-stride
await page.keyboard.down('KeyW');
await page.waitForTimeout(2200);
await snap('corridor');
await page.keyboard.up('KeyW');
const p0 = await page.evaluate(() => ({ ...(window).__BMB__.game.player.body }));
await page.keyboard.down('KeyW');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
const p1 = await page.evaluate(() => ({ ...(window).__BMB__.game.player.body }));
const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
console.log('3 MOVED ' + moved.toFixed(2) + 'm');

// 4. flashlight beat in a darker pocket
await page.keyboard.press('KeyF');
await page.waitForTimeout(900);
await snap('flashlight');

// 5-6. beacons + threshold ending
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
  await page.waitForTimeout(2200);
  const d0 = await page.evaluate(() => (window).__BMB__.game.story.discoveries);
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(700);
    if (i === 1 && attempt === 0) await snap('beacon-note');
    const st = await page.evaluate(() => ({
      disc: (window).__BMB__.game.story.discoveries,
      noteOpen: (window).__BMB__.game.ui.noteIsOpen,
    }));
    if (st.noteOpen) { await page.keyboard.press('KeyE'); await page.waitForTimeout(500); }
    const d1 = await page.evaluate(() => (window).__BMB__.game.story.discoveries);
    if (d1 > d0) break;
  }
}
const stage3 = await page.evaluate(() => (window).__BMB__.game.story.stage);
console.log('5 STAGE_AFTER_3=' + stage3);
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
let endingShown = false;
for (let a = 0; a < 5 && !endingShown; a++) {
  await page.waitForTimeout(800);
  endingShown = await page.evaluate(() => {
    const el = document.querySelector('.ending-overlay');
    return !!el && el.style.display !== 'none';
  });
}
await snap('ending');
console.log('6 ENDING_VISIBLE=' + endingShown);
console.log('PAGE_ERRORS=' + errors.length);
if (errors.length) console.log('ERRORS:' + errors.join(' | '));
const pass = realGpu && moved > 0.05 && stage3 >= 3 && endingShown && shot >= 6 && errors.length === 0;
console.log(pass ? 'HWGL_QA_PASS' : 'HWGL_QA_FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
