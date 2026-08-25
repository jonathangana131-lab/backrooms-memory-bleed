/* WORKING-NOTES HARNESS #13: deterministic flashlight-cone measurement.
 * Ray-picks a nearby surface, aims the camera straight at it from 2.5 m,
 * measures center crop with flashlight OFF then ON. Both backends. */
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
  await page.evaluate(() => (window).__BMB__.startNew('probe13'));
  await page.waitForTimeout(20000);

  // find a nearby surface with a center-screen ray; back off to 2.5 m facing it
  const aim = await page.evaluate(async () => {
    const g = (window).__BMB__.game;
    const s = g.scene;
    const { Ray } = await import('/@fs/Users/joey/Projects/backrooms-memory-bleed-recovered/node_modules/@babylonjs/core/Culling/ray.js');
    const origin = g.camera.position.clone();
    const d0 = g.camera.getForwardRay().direction;
    const yaw = Math.atan2(d0.x, d0.z);
    for (let off = 0; off <= 6.28; off += 0.25) {
      const dx = Math.sin(yaw + off), dz = Math.cos(yaw + off);
      const ray = new Ray(origin.add(new (d0.constructor)(dx * 0.2, 0, dz * 0.2)), new (d0.constructor)(dx, 0, dz), 12);
      const info = s.pickWithRay(ray, (m) => m.isPickable && m.isVisible && m.name !== 'probeBox');
      if (info && info.hit && info.distance > 1.8 && info.distance < 11 && info.pickedPoint) {
        // stand 2.5 m from the hit point along the ray, face it
        const p = info.pickedPoint;
        const sx = p.x - dx * 2.5, sz = p.z - dz * 2.5;
        g.player.teleport(sx, sz, yaw + off);
        g.camera.position.set(sx, 1.62, sz);
        return { ok: true, dist: +info.distance.toFixed(2), mesh: info.pickedMesh && info.pickedMesh.name };
      }
    }
    return { ok: false };
  });
  console.log('AIM', label, JSON.stringify(aim));
  await page.waitForTimeout(2000);

  // flashlight OFF
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.flashlight.has = true; g.flashlight.battery = 1; g.flashlight.on = false;
  });
  await page.waitForTimeout(1500);
  const off = await centerB(page);
  // flashlight ON
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(400);
  await page.evaluate(() => { const f = (window).__BMB__.game.flashlight; if (!f.on) f.on = true; });
  await page.waitForTimeout(2500);
  const on = await centerB(page);
  console.log('RESULT', label, 'engine_isWebGPU=' + engine,
    'off=' + off.toFixed(2), 'on=' + on.toFixed(2), 'delta=' + (on - off).toFixed(2));
  await browser.close();
}

await run('webgl', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
await run('webgpu', ['--enable-unsafe-webgpu', '--enable-webgpu']);
