/* Frame-time breakdown harness: sim (chunks.update) vs render (scene.render).
 * 30 teleport hops, JSON report lines every 10 hops + final SUMMARY. */
import { chromium } from 'playwright-core';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const GAME_URL = process.env.GAME_URL || 'http://127.0.0.1:5178/';
const HOPS = parseInt(process.env.HOPS || '30', 10);
const REPORT_EVERY = 10;

let browser;
try {
  browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (e) {
  console.log('SERVER_DOWN');
  console.log('SUMMARY', JSON.stringify({ avgSimMs: null, avgRenderMs: null, maxHeapMB: null, pass: false }));
  process.exit(0);
}

try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(String(e).slice(0, 200)); console.log('[PAGEERROR]', String(e).slice(0, 200)); });

  try {
    await page.goto(GAME_URL, { waitUntil: 'networkidle', timeout: 15000 });
  } catch (e) {
    console.log('SERVER_DOWN');
    console.log('SUMMARY', JSON.stringify({ avgSimMs: null, avgRenderMs: null, maxHeapMB: null, pass: false }));
    process.exit(0);
  }
  // __BMB__ is assigned asynchronously; wait for a fully-formed API.
  await page.waitForFunction(
    () => !!(window).__BMB__ && (window).__BMB__.game &&
          typeof (window).__BMB__.startNew === 'function' &&
          (window).__BMB__.game.chunks && typeof (window).__BMB__.game.chunks.update === 'function' &&
          (window).__BMB__.game.scene && typeof (window).__BMB__.game.scene.render === 'function',
    null, { timeout: 60000 });

  // Start the run FIRST so we patch the live instances created by startNew.
  let started = false;
  for (let i = 0; i < 10 && !started; i++) {
    try {
      await page.evaluate(() => (window).__BMB__.startNew('perf'));
      started = true;
    } catch {
      await page.waitForTimeout(1000); // __BMB__ may be re-assigned during boot; retry
    }
  }
  if (!started) throw new Error('could not startNew after 10 attempts');
  await page.waitForTimeout(2500);
  if (!(await page.evaluate(() => !!(window).__BMB__ && (window).__BMB__.game))) throw new Error('__BMB__.game missing after startNew');

  // Install perf instrumentation on the live game objects.
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    window.__PERF__ = { simMs: 0, renderMs: 0, frames: 0 };

    const cu = g.chunks.update.bind(g.chunks);
    g.chunks.update = function (x, z) {
      const t = performance.now();
      cu(x, z);
      window.__PERF__.simMs += performance.now() - t;
    };

    const sr = g.scene.render.bind(g.scene);
    g.scene.render = function (...a) {
      const t = performance.now();
      sr(...a);
      window.__PERF__.renderMs += performance.now() - t;
      window.__PERF__.frames++;
    };
  });

  const samples = [];
  for (let hop = 1; hop <= HOPS; hop++) {
    await page.evaluate((hop) => {
      const g = (window).__BMB__.game;
      g.player.teleport(8 + hop * 35, Math.sin(hop * 0.9) * 120, 0.3);
    }, hop);
    await page.waitForTimeout(900); // allow budgeted builds

    const s = await page.evaluate(() => {
      const g = (window).__BMB__.game;
      const p = window.__PERF__;
      const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
      return {
        hop: null, // filled by host
        fps: Math.round(g.engine.getFps()),
        simMsPerFrame: p.frames > 0 ? +(p.simMs / p.frames).toFixed(3) : 0,
        renderMsPerFrame: p.frames > 0 ? +(p.renderMs / p.frames).toFixed(3) : 0,
        chunksLoaded: g.chunks.loadedCount,
        heapMB: heap ? Math.round(heap / 1048576) : null,
        frames: p.frames,
      };
    });
    s.hop = hop;

    // reset accumulators so each report window is independent
    await page.evaluate(() => {
      window.__PERF__.simMs = 0; window.__PERF__.renderMs = 0; window.__PERF__.frames = 0;
    });

    samples.push(s);
    if (hop % REPORT_EVERY === 0 || hop === HOPS) console.log(JSON.stringify(s));
  }

  // Aggregate over all windows.
  const totalFrames = samples.reduce((a, s) => a + s.frames, 0);
  const weightedSim = samples.reduce((a, s) => a + s.simMsPerFrame * s.frames, 0) / (totalFrames || 1);
  const weightedRender = samples.reduce((a, s) => a + s.renderMsPerFrame * s.frames, 0) / (totalFrames || 1);
  const maxHeapMB = Math.max(...samples.map((s) => s.heapMB ?? 0));
  const finite = samples.every((s) =>
    Number.isFinite(s.fps) && Number.isFinite(s.simMsPerFrame) &&
    Number.isFinite(s.renderMsPerFrame) && Number.isFinite(s.heapMB ?? NaN));
  // SwiftShader software GL inflates per-frame sim (each frame absorbs budgeted
  // chunk builds); the real 60fps budget is 16.6ms TOTAL. Gate at 14ms sim.
  const pass = errors.length === 0 && finite && weightedSim < 14;

  console.log('SUMMARY', JSON.stringify({
    avgSimMs: +weightedSim.toFixed(3),
    avgRenderMs: +weightedRender.toFixed(3),
    maxHeapMB: Number.isFinite(maxHeapMB) ? maxHeapMB : null,
    pass,
    pageErrors: errors.length,
  }));
} finally {
  await browser.close();
}


