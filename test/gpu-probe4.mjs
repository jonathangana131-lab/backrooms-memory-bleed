/* WORKING-NOTES HARNESS #4: boot-time variant matrix under WebGPU.
 * Sticky pipeline caching defeats live toggles, so each variant boots the
 * page fresh with a knob disabled BEFORE the first expedition renders.
 * Variants: control | noglow | nopipelines | nolights(few) | combo */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.GAME_URL || 'http://127.0.0.1:5178/';

async function measure(variant) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/uncaptured error|exceeds the maximum/.test(t)) {
      if (!errs.some((e) => e === t.slice(0, 160))) errs.push(t.slice(0, 160));
    }
  });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

  // apply variant knobs BEFORE starting an expedition
  await page.evaluate((variant) => {
    const g = (window).__BMB__.game;
    const s = g.scene;
    if (variant === 'noglow' || variant === 'combo') {
      if (s.effectLayers) for (const l of s.effectLayers.slice()) l.dispose();
    }
    if (variant === 'nopipelines' || variant === 'combo') {
      if (g.postfx) { try { g.postfx.dispose(); } catch {} }
      const mgr = s.postProcessRenderPipelineManager;
      if (mgr && mgr.pipelines) for (const p of Object.values(mgr.pipelines)) p.dispose();
      for (const cam of s.cameras) { try { cam.detachPostProcess(); } catch {} }
    }
    if (variant === 'nolights' || variant === 'combo') {
      // keep hemi + torch spot only
      const rank = (l) => l.getClassName().includes('Hemispheric') ? 0 : (l.getClassName().includes('Spot') ? 1 : 2);
      [...s.lights].sort((a, b) => rank(a) - rank(b)).forEach((l, i) => l.setEnabled(i < 2));
    }
  }, variant);

  await page.evaluate(() => (window).__BMB__.startNew('probe4'));
  await page.waitForTimeout(12000);
  await page.evaluate(() => {
    const g = (window).__BMB__;
    g.game.flashlight.has = true; g.game.flashlight.battery = 1; g.game.flashlight.on = true;
  });
  await page.waitForTimeout(3000);

  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  let sum = 0, n = 0;
  for (let y = Math.floor(png.height * .35); y < png.height * .65; y += 2) {
    for (let x = Math.floor(png.width * .35); x < png.width * .65; x += 2) {
      const i = (png.width * y + x) << 2;
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n++;
    }
  }
  console.log('VARIANT', variant, 'BRIGHTNESS', (sum / n).toFixed(2), 'UNIQUE_VAL_ERRORS', errs.length);
  if (errs.length) console.log('  FIRST:', errs[0]);
  require_fs_write: {
    fs.writeFileSync('/tmp/bmb-gpu/v_' + variant + '.png', shot);
  }
  await browser.close();
}

import fs from 'node:fs';
fs.mkdirSync('/tmp/bmb-gpu', { recursive: true });
for (const v of ['control', 'noglow', 'nopipelines', 'nolights', 'combo']) {
  await measure(v);
}
