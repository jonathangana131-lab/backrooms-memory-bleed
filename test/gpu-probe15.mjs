/* WORKING-NOTES HARNESS #15: isolate SpotLight contribution per backend.
 * All lights disabled except the torch; aim at floor; measure torch
 * enabled/disabled delta. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

async function centerBavg(page, shots = 6) {
  let acc = 0;
  for (let i = 0; i < shots; i++) {
    const png = PNG.sync.read(await page.screenshot());
    let sum = 0, n = 0;
    for (let y = Math.floor(png.height * .35); y < png.height * .65; y += 2) {
      for (let x = Math.floor(png.width * .35); x < png.width * .65; x += 2) {
        const idx = (png.width * y + x) << 2;
        sum += (png.data[idx] + png.data[idx + 1] + png.data[idx + 2]) / 3;
        n++;
      }
    }
    acc += sum / n;
    await page.waitForTimeout(120);
  }
  return acc / shots;
}

async function run(label, gpuFlags) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: [...gpuFlags, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(process.env.GAME_URL || 'http://localhost:5179/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  const engine = await page.evaluate(() => String((window).__BMB__.game.engine.isWebGPU));
  await page.evaluate(() => (window).__BMB__.startNew('probe15'));
  await page.waitForTimeout(20000);

  // aim straight down-forward at the floor right ahead
  const aim = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.camera.position.set(g.player.body.x, 1.62, g.player.body.z);
    const d0 = g.camera.getForwardRay().direction;
    const yaw = Math.atan2(d0.x, d0.z);
    g.camera.rotation.x = -0.55;
    void yaw;
    return { x: +g.camera.position.x.toFixed(1), z: +g.camera.position.z.toFixed(1) };
  });

  // kill every light except the torch spot
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    const s = g.scene;
    s.lights.forEach((l) => { if (!l.getClassName().includes('Spot')) l.setEnabled(false); });
    g.flashlight.has = true; g.flashlight.battery = 1; g.flashlight.on = true;
    g.flashlight.update(0.016, performance.now() / 1000, g.player.body.x, g.player.body.z, Math.atan2(g.camera.getForwardRay().direction.x, g.camera.getForwardRay().direction.z), -0.4, false);
  });
  await page.waitForTimeout(2500);
  const torchOn = await centerBavg(page);

  // now disable the torch itself -> true zero-light reference
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.scene.lights.forEach((l) => l.setEnabled(false));
  });
  await page.waitForTimeout(2000);
  const allOff = await centerBavg(page);

  console.log('RESULT', label, 'engine_isWebGPU=' + engine, JSON.stringify(aim),
    'torchOnly=' + torchOn.toFixed(2), 'allOff=' + allOff.toFixed(2),
    'spotDelta=' + (torchOn - allOff).toFixed(2));
  await browser.close();
}

await run('webgl', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
await run('webgpu', ['--enable-unsafe-webgpu', '--enable-webgpu']);
