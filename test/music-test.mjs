/* Functional check for the procedural ambient score (DynamicScore).
   Drives a real AudioContext in-browser and measures output energy:
   drone presence per zone key, click-free crossfade, tension cluster
   swell, melody pacing at peak tension, and clean stop.
   Tolerates Vite full-reloads caused by concurrent edits. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 180)));

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle', timeout: 60000 });

async function evalStable(fn, arg) {
  for (let i = 0; i < 6; i++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (e) {
      if (!/context was destroyed|Target closed|navigation/i.test(String(e))) throw e;
      console.log('(page reloaded mid-test, retrying)');
      await page.waitForTimeout(2500);
    }
  }
  throw new Error('page kept reloading');
}

const results = {};
let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  (' + detail + ')' : ''));
};

// plucks read as several consecutive above-threshold frames; >= 3 frames means
// at least one transient event landed inside the 8 s observation window
function transientLanded(n) { return n >= 3; }

try {
  // build the score in-page against its own AudioContext
  const api = await evalStable(async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch {} }
    const mod = await import('/src/audio/music.ts');
    const tap = ctx.createGain();
    tap.connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    tap.connect(analyser);
    const score = new mod.DynamicScore(ctx, tap);
    // pump the score's frame tick like the game loop would (~30 fps)
    setInterval(() => { if (window.__scoreTest && !window.__scoreTest.stopped) score.update(0.033); }, 33);
    window.__scoreTest = { ctx, analyser, score, buf: new Float32Array(analyser.fftSize), stopped: false };
    return typeof score.setState + ',' + typeof score.update + ',' + typeof score.stop;
  });
  results.api = api;
  check('api surface', api === 'function,function,function', api);

  // RMS/peak sampler on the shared analyser
  const rms = async (ms) => evalStable(async (msArg) => {
    const t = window.__scoreTest;
    const t0 = performance.now();
    let sum = 0, n = 0;
    while (performance.now() - t0 < msArg) {
      t.analyser.getFloatTimeDomainData(t.buf);
      for (let i = 0; i < t.buf.length; i++) sum += t.buf[i] * t.buf[i];
      n += t.buf.length;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    return Math.sqrt(sum / n);
  }, ms);

  // 1. zone-1 drone fades in and is audible after the ~3 s crossfade
  await evalStable(() => { window.__scoreTest.score.setState(1, 0); });
  await page.waitForTimeout(3400);


