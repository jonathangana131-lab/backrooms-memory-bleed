/* WORKING-NOTES HARNESS #9: isolate the post-process stage that blacks out
 * WebGPU output (with the light-budget fix active so the world renders). */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('probe9'));
await page.waitForTimeout(12000);
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.has = true; g.flashlight.battery = 1; g.flashlight.on = true;
});
await page.waitForTimeout(3000);

async function b(label) {
  const png = PNG.sync.read(await page.screenshot());
  let sum = 0, n = 0;
  for (let y = Math.floor(png.height * .3); y < png.height * .7; y += 2) {
    for (let x = Math.floor(png.width * .3); x < png.width * .7; x += 2) {
      const i = (png.width * y + x) << 2;
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n++;
    }
  }
  console.log('B', label, (sum / n).toFixed(2));
}

await b('baseline_all_on');

// toggle individual DefaultRenderingPipeline features
for (const knob of ['toneMappingEnabled', 'vignetteEnabled', 'bloomEnabled', 'fxaaEnabled', 'grainEnabled']) {
  await page.evaluate((k) => {
    const s = (window).__BMB__.game.scene;
    const mgr = s.postProcessRenderPipelineManager;
    for (const p of Object.values(mgr.pipelines ?? {})) {
      if (p.getClassName && p.getClassName() === 'DefaultRenderingPipeline') {
        if (k === 'grainEnabled') {
          p.scene.imageProcessingConfiguration.grainEnabled = false;
        } else if (p.imageProcessing && k in p.imageProcessing) {
          p.imageProcessing[k] = false;
        } else if (k in p) {
          p[k] = false;
        }
      }
    }
    // also scene-level grain
    if (k === 'grainEnabled') s.imageProcessingConfiguration.grainEnabled = false;
  }, knob);
  await page.waitForTimeout(1200);
  await b('off_' + knob);
}

// restore nothing; instead detach ALL post-processing entirely
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  if (g.postfx) try { g.postfx.dispose(); } catch {}
  const s = g.scene;
  const mgr = s.postProcessRenderPipelineManager;
  for (const p of Object.values(mgr.pipelines ?? {})) { try { p.dispose(); } catch {} }
  for (const cam of s.cameras) {
    try { while (cam._postProcesses && cam._postProcesses.some(Boolean)) cam.removePostProcess(cam._postProcesses.filter(Boolean)[0]); } catch {}
  }
});
await page.waitForTimeout(1500);
await b('all_post_detached');
await browser.close();
