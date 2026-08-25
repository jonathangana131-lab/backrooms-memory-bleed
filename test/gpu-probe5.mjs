/* WORKING-NOTES HARNESS #5: find the max safe enabled-light count under
 * WebGPU. Boot-time enforcement (before first material compile), binary scan.
 * Also measures flashlight-cone center crop brightness for the acceptance
 * criterion at the best threshold, plus a WebGL comparison run. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.GAME_URL || 'http://127.0.0.1:5178/';
fs.mkdirSync('/tmp/bmb-gpu', { recursive: true });

async function measure(keep, gpuFlags, label) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: [...gpuFlags, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/uncaptured error|exceeds the maximum/.test(t) && !errs.includes(t.slice(0, 160))) errs.push(t.slice(0, 160));
  });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

  // install a persistent per-frame light cap BEFORE any expedition renders:
  // priority hemi(0) -> spot/torch(1) -> rest; enforced on scene.onBeforeRenderObservable
  await page.evaluate((keep) => {
    const g = (window).__BMB__.game;
    const s = g.scene;
    const rank = (l) => l.getClassName().includes('Hemispheric') ? 0 : (l.getClassName().includes('Spot') ? 1 : 2);
    const apply = () => {
      [...s.lights].sort((a, b) => rank(a) - rank(b)).forEach((l, i) => l.setEnabled(i < keep));
    };
    apply();
    s.onBeforeRenderObservable.add(apply);
  }, keep);

  await page.evaluate(() => (window).__BMB__.startNew('probe5'));
  await page.waitForTimeout(12000);
  await page.evaluate(() => {
    const g = (window).__BMB__;
    g.game.flashlight.has = true; g.game.flashlight.battery = 1; g.game.flashlight.on = true;
    g.game.ui.torchOn = true;
  });
  await page.waitForTimeout(4000);

  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  let csum = 0, cn = 0, asum = 0, an = 0;
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const i = (png.width * y + x) << 2;
      const lum = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      asum += lum; an++;
      if (x >= png.width * .35 && x <= png.width * .65 && y >= png.height * .35 && y <= png.height * .65) { csum += lum; cn++; }
    }
  }
  fs.writeFileSync('/tmp/bmb-gpu/k' + keep + '_' + label + '.png', shot);
  console.log(label, 'keep=' + keep,
    'center=' + (csum / cn).toFixed(2), 'avg=' + (asum / an).toFixed(2),
    'valErrors=' + errs.length);
  await browser.close();
}

const GPU = ['--enable-unsafe-webgpu', '--enable-webgpu'];
const SW = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
for (const k of [8, 6, 5, 4, 3]) await measure(k, GPU, 'gpu');
await measure(99, SW, 'webgl');
