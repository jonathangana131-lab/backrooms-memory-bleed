/* Toggle post/glow/fog systems to isolate darkness cause. */
import { chromium } from 'playwright-core';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('qa'));
await page.waitForTimeout(3500);

// baseline
await page.screenshot({ path: 'shots/fx-baseline.png' });

await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.scene.imageProcessingConfiguration.toneMappingEnabled = false;
  g.scene.imageProcessingConfiguration.contrast = 1;
  g.scene.imageProcessingConfiguration.exposure = 1;
  g.scene.imageProcessingConfiguration.vignetteEnabled = false;
  g.scene.imageProcessingConfiguration.grainEnabled = false;
});
await page.screenshot({ path: 'shots/fx-notone.png' });

await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.scene.fogMode = 0;
});
await page.screenshot({ path: 'shots/fx-nofog.png' });

// nuclear: dispose pipeline + glow
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  try { g.lighting['pipeline'].dispose(); } catch (e) {}
  try { const gl = g.scene['_effectLayers']; if (gl) gl.forEach((l) => l.dispose()); } catch (e) {}
});
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/fx-bare.png' });
console.log('done');
await browser.close();


