/* PARITY TEST: minimal SpotLight-on-plane scene rendered by BOTH engines
 * (WebGL Engine vs WebGPUEngine) inside one page. Deterministic: no chunks,
 * no flicker, no post-processing. Pass when both backends light the plane
 * and their mean brightness agrees within tolerance. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const ROOT = '/@fs/Users/joey/Projects/backrooms-memory-bleed-recovered';

const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 500 } });
await page.goto(process.env.GAME_URL || 'http://localhost:5179/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

const results = await page.evaluate(async ({ root }) => {
  const M = async (p) => (await import(root + p));
  const { Engine } = await M('/node_modules/@babylonjs/core/Engines/engine.js');
  const { WebGPUEngine } = await M('/node_modules/@babylonjs/core/Engines/webgpuEngine.js');
  const { Scene } = await M('/node_modules/@babylonjs/core/scene.js');
  const { FreeCamera } = await M('/node_modules/@babylonjs/core/Cameras/freeCamera.js');
  const { Vector3 } = await M('/node_modules/@babylonjs/core/Maths/math.vector.js');
  const { Color3 } = await M('/node_modules/@babylonjs/core/Maths/math.color.js');
  const { MeshBuilder } = await M('/node_modules/@babylonjs/core/Meshes/meshBuilder.js');
  const { StandardMaterial } = await M('/node_modules/@babylonjs/core/Materials/standardMaterial.js');
  const { SpotLight } = await M('/node_modules/@babylonjs/core/Lights/spotLight.js');

  async function build(kind) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    canvas.style.cssText = 'width:128px;height:128px;background:#000;border:1px solid #444;margin:4px';
    document.body.appendChild(canvas);
    let engine;
    if (kind === 'webgpu') {
      engine = new WebGPUEngine(canvas, { antialias: false });
      await engine.initAsync();
    } else {
      engine = new Engine(canvas, false, { preserveDrawingBuffer: true });
    }
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);
    void Vector3;
    const cam = new FreeCamera('c', new Vector3(0, 0, 3), scene);
    cam.setTarget(Vector3.Zero());
    const mat = new StandardMaterial('m', scene);
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    const wall = MeshBuilder.CreatePlane('wall', { width: 10, height: 10 }, scene);
    wall.material = mat;
    wall.position.z = -1;
    // torch-like spotlight from the camera toward the wall
    const spot = new SpotLight('s', new Vector3(0, 0, 3), new Vector3(0, 0, -1), 0.9, 4, scene);
    spot.intensity = 15;
    spot.range = 28;
    spot.diffuse = new Color3(1, 1, 1);
    scene.render();
    await new Promise((r) => setTimeout(r, 300));
    scene.render();
    return { canvas, engine };
  }

  const out = {};
  for (const kind of ['webgl', 'webgpu']) {
    try {
      const { canvas } = await build(kind);
      out[kind] = { dataUrl: canvas.toDataURL('image/png') };
    } catch (e) {
      out[kind] = { error: String(e).slice(0, 200) };
    }
  }
  window.__parity = out;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.error ?? true]));
}, { root: ROOT });
console.log('BUILD', JSON.stringify(results));

for (const kind of ['webgl', 'webgpu']) {
  const el = await page.evaluateHandle((k) => {
    const canvases = document.querySelectorAll('canvas[style*="128px"]');
    return canvases[k === 'webgl' ? 0 : 1];
  }, kind);
  try {
    const shot = await el.screenshot();
    const png = PNG.sync.read(shot);
    let sum = 0, n = 0;
    for (let i = 0; i < png.data.length; i += 8) { sum += png.data[i]; n++; }
    console.log('PARITY', kind, 'meanR=' + (sum / n).toFixed(1));
  } catch (e) {
    console.log('PARITY', kind, 'SHOT_FAIL', String(e).slice(0, 120));
  }
}
await browser.close();
