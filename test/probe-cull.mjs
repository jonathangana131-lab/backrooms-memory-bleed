/* Toggle backface culling to diagnose winding. */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 300)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('qa'));
await page.waitForTimeout(3500);

const setProp = async (on) => {
  await page.evaluate((v) => {
    const g = (window).__BMB__.game;
    for (const m of g.scene.meshes) {
      if (m.material && m.material.backFaceCulling !== undefined) m.material.backFaceCulling = v;
    }
    g.lighting['hemi'].intensity = v ? 1.2 : 0.36;
  }, on);
};
await setProp(false);
await page.screenshot({ path: 'shots/nocull.png' });
await setProp(true);
await page.screenshot({ path: 'shots/cull.png' });

// also dump one mesh's data sanity
const info = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  const m = g.scene.meshes.find((mm) => mm.name.startsWith('floor'));
  return {
    name: m?.name,
    totalVertices: m?.getTotalVertices(),
    isReady: m?.isReady(),
    matMaxLights: m?.material?.maxSimultaneousLights,
    camPos: g.camera.position.asArray(),
    camRot: g.camera.rotation.asArray(),
    activeMeshes: g.scene.getActiveMeshes().length,
  };
});
console.log(JSON.stringify(info));
await browser.close();


