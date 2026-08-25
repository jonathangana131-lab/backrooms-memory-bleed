import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({ executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('probe10'));
await page.waitForTimeout(12000);
async function b(label) {
  const png = PNG.sync.read(await page.screenshot());
  let sum = 0, n = 0;
  for (let y = Math.floor(png.height*.3); y < png.height*.7; y += 2)
    for (let x = Math.floor(png.width*.3); x < png.width*.7; x += 2) {
      const i = (png.width*y+x)<<2; sum += (png.data[i]+png.data[i+1]+png.data[i+2])/3; n++;
    }
  console.log('B', label, (sum/n).toFixed(2));
}
await b('baseline');
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  if (s.effectLayers) for (const l of s.effectLayers.slice()) l.dispose();
});
await page.waitForTimeout(1500);
await b('glow_disposed');
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  const mgr = s.postProcessRenderPipelineManager;
  for (const p of Object.values(mgr.pipelines ?? {})) { try { p.dispose(); } catch {} }
  for (const cam of s.cameras) { try { cam._postProcesses = []; } catch {} }
});
await page.waitForTimeout(1500);
await b('glow_disposed_post_detached');
await browser.close();
