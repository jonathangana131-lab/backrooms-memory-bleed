// WebGPU render-integrity gate.
// Boots `vite preview` on 127.0.0.1:4180 from <cwd>/dist, drives the real
// Chrome-for-Testing binary with WebGPU flags into a fresh game through the
// real title-screen entry, waits for world streaming, then asserts the three
// signals that actually identify the v1.0.0 black-screen failure class:
//
//   1. ENGINE      - Babylon booted the WebGPU backend (`engine.isWebGPU`).
//   2. PIPELINES   - ZERO WebGPU validation errors during boot + play. The
//                    v1.0.0 black screen was GPUValidationError "number of
//                    uniform buffers (19) in the Vertex stage exceeds the
//                    maximum per-stage limit (12)" (16 simultaneous lights +
//                    3 fixed bindings): every render-pipeline creation was
//                    rejected and only clear-color reached the canvas.
//   3. WORLD       - >100 enabled visible meshes streamed into the scene.
//
// Composite screenshot brightness is printed for information only: it is NOT
// a pass/fail signal. The scene is dark by design and DOM overlays (film
// grain, vignette) dominate it - during the v1.0.0 investigation a broken
// build measured BRIGHTER (5.3, grain-era overlay over a black world) than
// the healthy fixed-seed build (2.8). See test/GPU-FIX-NOTES.md.
// Exit 0 = all three signals healthy; exit 1 otherwise.
import { preview } from 'vite';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const PORT = 4180;
const URL = `http://127.0.0.1:${PORT}/`;
const EXEC = process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const MIN_ACTIVE_MESHES = 100;

function brightness(buf) {
  const p = PNG.sync.read(buf);
  let sum = 0, n = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    sum += (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
    n++;
  }
  return +(sum / n).toFixed(1);
}

const server = await preview({
  root: process.cwd(),
  preview: { port: PORT, host: '127.0.0.1', strictPort: true },
});
let code = 1;
try {
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  let gpuErrors = 0;
  page.on('console', (m) => {
    if (/GPUValidationError|uniform buffers.*exceeds/i.test(m.text())) gpuErrors++;
  });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.click('.title-screen .btn.primary');
  await page.waitForTimeout(9000);
  const st = await page.evaluate(() => {
    const g = window.__BMB__;
    if (!g || !g.game || !g.game.scene) return null;
    let active = 0;
    for (const m of g.game.scene.meshes) {
      if (m.isEnabled(false) && m.isVisible && m.visibility > 0) active++;
    }
    return { isWebGPU: g.game.engine.isWebGPU === true, active };
  });
  const shot = await page.screenshot();
  const b = brightness(shot);
  if (!st) {
    console.log(`webgpu-gate: NO_GAME_OBJECT brightness=${b} -> FAIL`);
  } else {
    const pass =
      st.isWebGPU && gpuErrors === 0 && st.active >= MIN_ACTIVE_MESHES;
    console.log(
      `webgpu-gate: engine=${st.isWebGPU ? 'webgpu' : 'NOT-WEBGPU'} ` +
        `gpuValidationErrors=${gpuErrors} activeMeshes=${st.active} ` +
        `(need isWebGPU && errors==0 && active>=${MIN_ACTIVE_MESHES}) ` +
        `brightness=${b} (info only) -> ${pass ? 'PASS' : 'FAIL'}`,
    );
    code = pass ? 0 : 1;
  }
  await browser.close();
} catch (e) {
  console.log('webgpu-gate: ERROR', String(e).slice(0, 300));
  code = 1;
} finally {
  await new Promise((res) => server.httpServer.close(res));
}
process.exit(code);
