/* WORKING-NOTES HARNESS #2: isolate WHERE rendering dies under WebGPU.
 * Checks frame advancement, draw-call counters, RT sizes, then peels
 * pipeline layers live (glow, lighting pipeline, postfx, image processing,
 * fog) and drops a fresh unlit test box in front of the camera. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /shader|compil|pipeline|error/i.test(t)) errors.push('[' + m.type() + '] ' + t.slice(0, 300));
});
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

await page.evaluate(() => (window).__BMB__.startNew('gpuprobe2'));
await page.waitForTimeout(10000);

async function brightness(label) {
  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  let sum = 0, n = 0;
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const i = (png.width * y + x) << 2;
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n++;
    }
  }
  const avg = sum / n;
  console.log('BRIGHTNESS', label, avg.toFixed(2));
  return avg;
}

const frames = await page.evaluate(async () => {
  const g = (window).__BMB__.game;
  const e = g.engine;
  let endFrames = 0;
  const obs = e.onEndFrameObservable.add(() => { endFrames++; });
  await new Promise((r) => setTimeout(r, 3000));
  e.onEndFrameObservable.remove(obs);
  return {
    endFrames3s: endFrames,
    rtW: e.getRenderWidth(true), rtH: e.getRenderHeight(true),
    hwScaling: e.getHardwareScalingLevel(),
    fps: Math.round(e.getFps()),
  };
});
console.log('FRAMES', JSON.stringify(frames));

await brightness('baseline');

// peel 1: dispose glow layers
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  for (const key of Object.keys(s)) {
    // no public registry; GlowLayer registers on scene.effectLayers? try both
  }
  if (s.effectLayers) for (const l of s.effectLayers.slice()) l.dispose();
});
await page.waitForTimeout(1500);
await brightness('no_glow');

// peel 2: dispose render pipelines (DefaultRenderingPipeline + PostFX)
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  if (s.postProcessRenderPipelineManager) {
    const mgr = s.postProcessRenderPipelineManager;
    for (const p of mgr.pipelines ? Object.values(mgr.pipelines) : []) p.dispose();
  }
  for (const cam of s.cameras) cam._postProcesses = []; // eslint-disable-line
});
await page.waitForTimeout(1500);
await brightness('no_pipelines');

// peel 3: image processing off at scene level
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.imageProcessingEnabled = false;
});
await page.waitForTimeout(1000);
await brightness('no_imageproc');

// peel 4: fog off
await page.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  s.fogMode = 0; // FOGMODE_NONE
});
await page.waitForTimeout(1000);
await brightness('no_fog');

// probe: drop an unlit emissive box right in front of the camera (Vite /@fs
// module URLs so the browser-side dynamic import resolves real Babylon ESM)
const ROOT = '/Users/joey/Projects/backrooms-memory-bleed-recovered';
const box = await page.evaluate(async ({ root }) => {
  const g = (window).__BMB__.game;
  const s = g.scene;
  const { MeshBuilder } = await import(root + '/node_modules/@babylonjs/core/Meshes/meshBuilder.js');
  const { StandardMaterial } = await import(root + '/node_modules/@babylonjs/core/Materials/standardMaterial.js');
  const { Color3 } = await import(root + '/node_modules/@babylonjs/core/Maths/math.color.js');
  const m = MeshBuilder.CreateBox('probeBox', { size: 1 }, s);
  const mat = new StandardMaterial('probeMat', s);
  mat.emissiveColor = new Color3(1, 1, 1);
  mat.disableLighting = true;
  m.material = mat;
  const fwd = g.camera.getForwardRay().direction;
  m.position.copyFrom(g.camera.position).addInPlace(fwd.scale(3));
  return 'placed';
}, { root: '/@fs' + ROOT });
console.log('PROBE_BOX', box);
await page.waitForTimeout(1200);
await brightness('with_probe_box');

console.log('CONSOLE_ERRORS', JSON.stringify(errors.slice(0, 12)));
await browser.close();
