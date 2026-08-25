/* WORKING-NOTES HARNESS #3: confirm the light-count hypothesis.
 * Progressively enables fewer lights under WebGPU and finds the threshold
 * where the world unblacks. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('console', (m) => {
  if (/uncaptured error|exceeds the maximum/.test(m.text())) errors.push(m.text().slice(0, 120));
});
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('gpuprobe3'));
await page.waitForTimeout(10000);

async function brightness(label) {
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
  const avg = sum / n;
  console.log('BRIGHTNESS', label, avg.toFixed(2));
  return avg;
}

// ensure some pool lights actually emit (fixtures near spawn) and torch on
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.has = true; g.flashlight.battery = 1; g.flashlight.on = true;
});

// baseline: everything enabled
await brightness('all_enabled_' + await page.evaluate(() => (window).__BMB__.game.scene.lights.filter((l) => l.isEnabled()).length));

// binary search by enabling subsets
for (const keep of [24, 16, 12, 10, 8, 6]) {
  await page.evaluate((keep) => {
    const s = (window).__BMB__.game.scene;
    // priority order: hemi first, spot (torch) second, then point lights
    const ordered = [...s.lights].sort((a, b) => {
      const rank = (l) => l.getClassName().includes('Hemispheric') ? 0 : (l.type === 2 || l.getClassName().includes('Spot') ? 1 : 2);
      return rank(a) - rank(b);
    });
    ordered.forEach((l, i) => l.setEnabled(i < keep));
  }, keep);
  await page.waitForTimeout(2000);
  const en = await page.evaluate(() => (window).__BMB__.game.scene.lights.filter((l) => l.isEnabled()).length);
  await brightness('keep_' + keep + '_enabled_' + en + '_errs_' + errors.length);
}

console.log('VALIDATION_ERRORS_TOTAL=' + errors.length);
await browser.close();
