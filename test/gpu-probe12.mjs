/* WORKING-NOTES HARNESS #12: does the flashlight raise center-crop
 * brightness at all? WebGL control first, then WebGPU. Also teleports the
 * player to face a nearby wall so the cone has surface to light. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

async function centerB(page) {
  const png = PNG.sync.read(await page.screenshot());
  let sum = 0, n = 0;
  for (let y = Math.floor(png.height * .35); y < png.height * .65; y += 2) {
    for (let x = Math.floor(png.width * .35); x < png.width * .65; x += 2) {
      const i = (png.width * y + x) << 2;
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n++;
    }
  }
  return sum / n;
}

async function run(label, gpuFlags) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: [...gpuFlags, '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(process.env.GAME_URL || 'http://localhost:5179/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  const engine = await page.evaluate(() => String((window).__BMB__.game.engine.isWebGPU));
  await page.evaluate(() => (window).__BMB__.startNew('probe12'));
  await page.waitForTimeout(20000);

  // park the flashlight off, measure
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.flashlight.has = true; g.flashlight.battery = 1; g.flashlight.on = false;
    g.flashlight.update(0.016, performance.now() / 1000, g.player.body.x, g.player.body.z,
      Math.atan2(g.camera.getForwardRay().direction.x, g.camera.getForwardRay().direction.z),
      0, false);
  });
  await page.waitForTimeout(1500);
  const off = await centerB(page);

  // turn it on through the real path
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(500);
  await page.evaluate(() => { const f = (window).__BMB__.game.flashlight; if (!f.on) f.on = true; });
  await page.waitForTimeout(2500);
  const on = await centerB(page);
  console.log('RUN', label, 'engine_isWebGPU=' + engine, 'off=' + off.toFixed(2), 'on=' + on.toFixed(2), 'delta=' + (on - off).toFixed(2));

  // face a close wall: pick a point 2m ahead and aim the camera level
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    const d = g.camera.getForwardRay().direction;
    const yaw = Math.atan2(d.x, d.z);
    g.player.teleport(g.player.body.x + Math.sin(yaw) * 0, g.player.body.z + Math.cos(yaw) * 0, yaw);
  });
  await page.waitForTimeout(1500);
  const onWall = await centerB(page);
  console.log('RUN', label, 'on_facing_wall=' + onWall.toFixed(2));
  await browser.close();
}

await run('webgl', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
await run('webgpu', ['--enable-unsafe-webgpu', '--enable-webgpu']);
