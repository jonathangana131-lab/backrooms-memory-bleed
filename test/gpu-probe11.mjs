/* WORKING-NOTES HARNESS #11: A/B the same protocol on WebGPU vs WebGL
 * (swiftshader), long settle, flashlight ON, rich pixel statistics. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

async function run(label, gpuFlags) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: [...gpuFlags, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  console.log('ENGINE_IS', label, await page.evaluate(() => String((window).__BMB__.game.engine.isWebGPU)));
  await page.evaluate(() => (window).__BMB__.startNew('abtest'));
  await page.waitForTimeout(25000); // long settle: chunks fully stream in
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.flashlight.has = true; g.flashlight.battery = 1;
  });
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(500);
  await page.evaluate(() => { const f = (window).__BMB__.game.flashlight; if (!f.on) f.on = true; });
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    return {
      drawCalls: g.engine.drawCalls ? g.engine.drawCalls.count : -1,
      activeMeshes: g.scene.getActiveMeshes().length,
      torchOn: g.flashlight.on, torchIntensity: g.flashlight.light.intensity,
      camPos: { x: +g.camera.position.x.toFixed(1), z: +g.camera.position.z.toFixed(1) },
    };
  });

  const png = PNG.sync.read(await page.screenshot());
  const vals = [];
  let cSum = 0, cN = 0;
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const i = (png.width * y + x) << 2;
      const lum = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      vals.push(lum);
      if (x >= png.width * .35 && x <= png.width * .65 && y >= png.height * .35 && y <= png.height * .65) { cSum += lum; cN++; }
    }
  }
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.floor(vals.length * p)].toFixed(1);
  console.log('RUN', label, JSON.stringify({
    ...info,
    avgFull: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
    centerAvg: (cSum / cN).toFixed(2),
    p50: q(.5), p90: q(.9), p99: q(.99), max: vals[vals.length - 1].toFixed(1),
  }));
  await browser.close();
}

await run('webgpu', ['--enable-unsafe-webgpu', '--enable-webgpu']);
await run('webgl_swiftshader', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
