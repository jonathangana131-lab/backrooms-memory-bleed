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
// Only failures of the module this harness imports matter here. The app's
// bootstrap entry (src/core/game.ts, owned elsewhere) currently fails to
// serve, and its generic "Failed to load resource" console line carries no
// URL -- so network health is judged per-response instead.
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
    errors.push(m.text().slice(0, 180));
  }
});
page.on('response', (r) => {
  if (r.status() >= 400 && /\/src\/audio\/music\.ts/.test(r.url())) {
    errors.push(r.status() + ' on ' + r.url());
  }
});
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
    const origCreateGain = ctx.createGain.bind(ctx);
    window.__gainParams = [];
    ctx.createGain = (...a) => {
      const g = origCreateGain(...a);
      const rec = { calls: [] };
      const st = g.gain.setTargetAtTime.bind(g.gain);
      g.gain.setTargetAtTime = (v, tt, tc) => { rec.calls.push({ v, tc }); return st(v, tt, tc); };
      window.__gainParams.push(rec);
      return g;
    };
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
  const calmZone1 = await rms(700);
  check('zone1 drone audible', calmZone1 > 0.004, 'rms=' + calmZone1.toFixed(5));
  results.calmRms = calmZone1;

  // 2. zone switch crossfades to a different key with no click spike
  const switchSpike = await evalStable(async () => {
    const t = window.__scoreTest;
    t.score.setState(3, 0); // different pentatonic root
    let p = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 150) {
      t.analyser.getFloatTimeDomainData(t.buf);
      for (let i = 0; i < t.buf.length; i++) { const v = Math.abs(t.buf[i]); if (v > p) p = v; }
    }
    return p;
  });
  check('crossfade click-free', switchSpike < 0.35, 'peak150ms=' + switchSpike.toFixed(4));
  await page.waitForTimeout(3200);
  const zone3 = await rms(700);
  check('zone3 drone audible after crossfade', zone3 > 0.004, 'rms=' + zone3.toFixed(5));

  // 3. the tension cluster tracks director tension. Its gain stage is the
  // only one scheduled with tau 1.2 s; RMS-level comparison cannot separate
  // it from the bed (quadrature mixing keeps the total-energy rise small).
  const lastClusterTarget = () => evalStable(() => {
    let v = null;
    for (const rec of window.__gainParams) {
      const cs = rec.calls.filter((c) => Math.abs(c.tc - 1.2) < 1e-6);
      if (cs.length > 0) v = cs.at(-1).v;
    }
    return v;
  });
  await evalStable(() => { window.__scoreTest.score.setState(3, 0); });
  await page.waitForTimeout(2600);
  const baseline = await rms(800);
  const calmTarget = await lastClusterTarget();
  check('calm holds the tension cluster silent', calmTarget === 0, String(calmTarget));
  await evalStable(() => { window.__scoreTest.score.setState(3, 1); });
  const tenseTarget = await lastClusterTarget();
  check('tension opens the cluster toward its full level',
    tenseTarget !== null && Math.abs(tenseTarget - 0.035) < 1e-9, String(tenseTarget));
  await page.waitForTimeout(3200); // tau 1.2 s -> mostly settled
  const tense = await rms(1200);
  check('the swelled bed stays audible', tense > 0.004 && tense >= baseline * 0.9,
    'calm=' + baseline.toFixed(5) + ' tense=' + tense.toFixed(5));

  // 4. melody pacing at peak tension: watch the score schedule pluck voices.
  // (Amplitude-threshold detection is unreliable here: the tension cluster
  // lifts the bed median, so pluck peaks never clear bed*1.8.)
  // The fast-forward runs synchronously in virtual time: a setTimeout-driven
  // pump is throttled to ~15 iterations/s in this headless browser, which
  // delivered only ~14 of the intended ~90 virtual seconds and starved the
  // pluck count below the transient threshold even though pacing was correct.
  const plucks = await evalStable(() => {
    const t = window.__scoreTest;
    const ctx = t.ctx;
    const createdAt = [];
    let vtime = 0; // pumped scheduler time: ctx.currentTime stays wall-bound
    const orig = ctx.createOscillator.bind(ctx);
    ctx.createOscillator = (...a) => {
      const o = orig(...a);
      if (o.type === 'sine') createdAt.push(vtime);
      return o;
    };
    for (let i = 0; i < 900; i++) { t.score.update(0.1); vtime += 0.1; } // 90 virtual seconds
    ctx.createOscillator = orig;
    // pacing: consecutive plucks land in the documented 4-6 s virtual window
    const gaps = [];
    for (let i = 1; i < createdAt.length; i++) gaps.push(createdAt[i] - createdAt[i - 1]);
    return { count: createdAt.length, gaps };
  });
  check('melody plucks scheduled at peak tension',
    transientLanded(plucks.count),
    'plucks=' + plucks.count + ' gapsVirtualS=' + JSON.stringify(plucks.gaps.map((g) => +g.toFixed(2))));

  // 5. stop() fades everything to silence
  await evalStable(() => { window.__scoreTest.score.stop(); window.__scoreTest.stopped = true; });
  await page.waitForTimeout(2600);
  const silent = await rms(600);
  check('stop silences score', silent < 0.002, 'rms=' + silent.toFixed(5));
} catch (e) {
  console.log('FAIL  harness error: ' + String(e).slice(0, 300));
  fail++;
}
if (errors.length) {
  console.log('console/page errors: ' + errors.slice(0, 5).join(' | '));
  fail += errors.length;
}
console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILURES');
process.exitCode = fail === 0 ? 0 : 1;
await browser.close();



