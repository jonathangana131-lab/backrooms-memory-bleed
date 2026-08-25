/* WORKING-NOTES HARNESS #14: deterministic flashlight-cone measurement v2.
 * Ray-cast down-forward onto the floor (predicate => true), aim camera at
 * the hit point from ~2.5 m, average 5 screenshots per state (torch off/on).
 * Runs WebGL control + WebGPU. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

async function centerBavg(page, shots = 5) {
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
  await page.goto(process.env.GAME_URL || 'http://localhost:5179/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  const engine = await page.evaluate(() => String((window).__BMB__.game.engine.isWebGPU));
  await page.evaluate(() => (window).__BMB__.startNew('probe14'));
  await page.waitForTimeout(20000);

  // cast down-forward rays; stand 2.5 m back along one that hits floor close
  const aim = await page.evaluate(async () => {
    const g = (window).__BMB__.game;
    const s = g.scene;
    const { Ray } = await import('/@fs/Users/joey/Projects/backrooms-memory-bleed-recovered/node_modules/@babylonjs/core/Culling/ray.js');
    const { Vector3 } = await import('/@fs/Users/joey/Projects/backrooms-memory-bleed-recovered/node_modules/@babylonjs/core/Maths/math.vector.js');
    void Ray;
    const origin = g.camera.position.clone();
    const d0 = g.camera.getForwardRay().direction;
    const yaw = Math.atan2(d0.x, d0.z);
    for (let off = 0; off <= 6.28; off += 0.2) {
      const dx = Math.sin(yaw + off), dz = Math.cos(yaw + off);
      for (const pitch of [-0.25, -0.45, -0.65]) {
        const dir = new Vector3(dx * Math.cos(pitch), Math.sin(pitch), dz * Math.cos(pitch));
        const info = s.pickWithRay(new Ray(origin.clone(), dir, 9), () => true);
        if (info && info.hit && info.distance > 1.6 && info.distance < 8 && info.pickedPoint) {
          const p = info.pickedPoint;
          const sx = p.x - dx * 2.2, sz = p.z - dz * 2.2;
          g.player.teleport(sx, sz, yaw + off);
          g.camera.position.set(sx, 1.62, sz);
          // aim camera straight at the hit point
          const target = p.subtract(g.camera.position).normalize();
          g.camera.rotation.x = Math.asin(target.y);
          g.camera.rotation.y = Math.atan2(target.x, target.z);
          return { ok: true, dist: +info.distance.toFixed(2), mesh: info.pickedMesh ? info.pickedMesh.name.slice(0, 24) : '' };
        }
      }
    }
    return { ok: false };
  });
  console.log('AIM', label, JSON.stringify(aim));
  await page.waitForTimeout(2500);

  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.flashlight.has = true; g.flashlight.battery = 1; g.flashlight.on = false;
  });
  await page.waitForTimeout(1500);
  const off = await centerBavg(page);

  await page.keyboard.press('KeyF');
  await page.waitForTimeout(400);
  await page.evaluate(() => { const f = (window).__BMB__.game.flashlight; if (!f.on) f.on = true; });
  await page.waitForTimeout(2500);
  const on = await centerBavg(page);

  console.log('RESULT', label, 'engine_isWebGPU=' + engine,
    'off=' + off.toFixed(2), 'on=' + on.toFixed(2), 'delta=' + (on - off).toFixed(2),
    (on >= 15 && on > off * 1.3) ? 'CONE_PASS' : 'cone_under');
  await browser.close();
}

await run('webgl', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
await run('webgpu', ['--enable-unsafe-webgpu', '--enable-webgpu']);
