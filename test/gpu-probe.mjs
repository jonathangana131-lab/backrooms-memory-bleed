/* WORKING-NOTES HARNESS: WebGPU black-screen diagnosis.
 * Boots the game under real Chrome WebGPU, starts an expedition, toggles
 * flashlight ON, then live-toggles suspect knobs, measuring canvas
 * brightness (center crop average, pngjs) after each toggle.
 *
 * Usage: node test/gpu-probe.mjs [phase]   phase: boot|toggles|all
 */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 200)); });
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

const gpu = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { isWebGPU: !!(g.engine && g.engine.isWebGPU), webglVersion: g.engine ? g.engine.webGLVersion : -1 };
});
console.log('ENGINE', JSON.stringify(gpu));

await page.evaluate(() => (window).__BMB__.startNew('gpuprobe'));
// let chunks stream in and a few frames render; slow headless fps needs patience
await page.waitForTimeout(12000);
await page.keyboard.press('KeyF'); // flashlight ON (may not be owned yet — force below)
await page.waitForTimeout(500);
// ensure flashlight owned+on regardless of pickup state
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.has = true;
  g.flashlight.battery = 1;
  g.flashlight.on = true;
});
await page.waitForTimeout(3000);

async function brightness(label) {
  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  // center crop: flashlight cone region
  const x0 = Math.floor(png.width * 0.35), x1 = Math.floor(png.width * 0.65);
  const y0 = Math.floor(png.height * 0.35), y1 = Math.floor(png.height * 0.65);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (png.width * y + x) << 2;
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n++;
    }
  }
  const avg = sum / n;
  console.log('BRIGHTNESS', label, avg.toFixed(2));
  return avg;
}

fs.mkdirSync('/tmp/bmb-gpu', { recursive: true });
const snap = async (label) => fs.writeFileSync('/tmp/bmb-gpu/' + label.replace(/\W+/g, '_') + '.png', await page.screenshot());

await snap('baseline_flash_on');
const bBase = await brightness('flash_on_baseline');

// ---- live toggle suspects ----
// (a) light intensity x10 across all sources
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.lights.forEach((l) => { l.intensity *= 10; });
});
await page.waitForTimeout(1500);
const bInt10 = await brightness('after_intensity_x10');
await snap('intensity_x10');

// undo
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.lights.forEach((l) => { l.intensity /= 10; });
});

// (b) dispose shadow generators
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.lights.forEach((l) => {
    const sg = l.getShadowGenerator && l.getShadowGenerator();
    if (sg) sg.dispose();
  });
});
await page.waitForTimeout(1500);
const bShadow = await brightness('after_shadow_dispose');
await snap('shadow_disposed');

// (c) emissive bump on all materials
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  for (const m of s.materials) {
    if (m.emissiveColor) m.emissiveColor.set(0.25, 0.23, 0.18);
    if (m.disableLighting !== undefined) m.disableLighting = false;
  }
});
await page.waitForTimeout(1500);
const bEmissive = await brightness('after_emissive_bump');
await snap('emissive_bumped');

// (d) disable lights one kind at a time: hemi only off / spots only off / points only off
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.lights.forEach((l) => {
    if (l.getClassName().includes('Hemispheric')) l.setEnabled(false);
  });
});
await page.waitForTimeout(1200);
const bNoHemi = await brightness('hemi_disabled');
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.lights.forEach((l) => l.setEnabled(true));
  // now kill everything except hemi: points + spots off
  s.lights.forEach((l) => {
    if (!l.getClassName().includes('Hemispheric')) l.setEnabled(false);
  });
});
await page.waitForTimeout(1200);
const bOnlyHemi = await brightness('only_hemi');
await snap('only_hemi');
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.lights.forEach((l) => l.setEnabled(true));
});

// (e) scene stats for context
const stats = await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  return {
    meshes: s.meshes.length, active: s.getActiveMeshes().length,
    lights: s.lights.length,
    lightKinds: s.lights.map((l) => l.getClassName()),
    matCount: s.materials.length,
    fogMode: s.fogMode, fogDensity: s.fogDensity,
    imageProc: !!s.imageProcessingConfiguration,
  };
});
console.log('SCENE_STATS', JSON.stringify(stats));
console.log('PAGE_ERRORS', JSON.stringify(errors.slice(0, 8)));

console.log('SUMMARY base=' + bBase.toFixed(2),
  'intx10=' + bInt10.toFixed(2),
  'noshadow=' + bShadow.toFixed(2),
  'emissive=' + bEmissive.toFixed(2),
  'nohemi=' + bNoHemi.toFixed(2),
  'onlyhemi=' + bOnlyHemi.toFixed(2));

await browser.close();
