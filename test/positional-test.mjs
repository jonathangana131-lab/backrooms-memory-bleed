/* Functional check for the positional per-fixture hum.
   Loads PositionalHum in the real browser via the Vite dev server and
   verifies stereo placement, inverse-square falloff, the combined -12 dB
   stacking cap, smooth movement response, stop(), and audibility. */
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

try {
  await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.__BMB__, null, { timeout: 60000 });
  await page.evaluate(() => window.__BMB__.startNew('positional'));
  await page.evaluate(() => window.__BMB__.game.audio.unlock());
  await page.waitForTimeout(500);

  const out = await page.evaluate(async () => {
    const res = {};
    const mod = await import('/src/audio/positional.ts');
    const { PositionalHum, humRolloff, panForBearing, COMBINED_CAP_LINEAR } = mod;
    res.hasClass = typeof PositionalHum === 'function';

    // --- pure math helpers ---
    res.rolloffClose = humRolloff(2);          // within REF_DIST -> 1
    res.rolloff10 = humRolloff(10);            // (5/10)^2 -> 0.25
    res.panRight = panForBearing(Math.PI / 2); // right of facing -> +1

    const ctx = window.__BMB__.game.audio.ctx;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch {} }
    await new Promise((r) => setTimeout(r, 300));

    const settle = (ms = 650) => new Promise((r) => setTimeout(r, ms));
    const sumGain = (st) => st.reduce((a, v) => a + v.gain, 0);

    // Player pose: origin, yaw=0 -> forward is -Z (Babylon left-handed).
    const px = 0, pz = 0, yaw = 0;
    const hum = new PositionalHum(ctx);

    // 1. placement: one fixture ahead (-Z), one to the right (+X)
    hum.setFixtures([{ x: 0, z: -4 }, { x: 4, z: 0 }]);
    hum.update(px, pz, yaw);
    await settle();
    let st = hum.voiceState();
    res.panAfterPlace = st.map((v) => Math.round(v.pan * 100) / 100);
    res.someAhead = st.some((v) => Math.abs(v.pan) < 0.35);       // ahead ~ centre
    res.someRight = st.some((v) => v.pan > 0.7);                  // right ~ hard R

    // 2. distance attenuation: near voice must dominate a far one
    hum.setFixtures([{ x: 0, z: -3 }, { x: 0, z: -40 }]);
    hum.update(px, pz, yaw);
    await settle();
    st = hum.voiceState().slice().sort((a, b) => b.gain - a.gain);
    res.nearGain = Math.round(st[0].gain * 10000) / 10000;
    res.farGain = Math.round(st[2].gain * 10000) / 10000;
    res.farQuieter = st[0].gain > st[2].gain * 4;

    // 3. stacking cap: three fixtures all within ~2 m
    hum.setFixtures([
      { x: 1, z: -1 }, { x: -1, z: -1 }, { x: 0, z: 1.5 },
    ]);
    hum.update(px, pz, yaw);
    await settle();
    st = hum.voiceState();
    res.cappedSum = Math.round(sumGain(st) * 10000) / 10000;
    res.capLinear = Math.round(COMBINED_CAP_LINEAR * 10000) / 10000;
    res.capRespected = sumGain(st) <= COMBINED_CAP_LINEAR * 1.05;

    // 4. movement response: one off-axis fixture to the right-front;
    // turning 180 deg must carry its voice across the head SMOOTHLY
    // (tau 0.1 s: right after the pose change the pan has barely moved,
    // half a second later it sits on the opposite side).
    hum.setFixtures([{ x: 3, z: -2 }]);
    hum.update(px, pz, 0); // fixture ahead-right -> positive pan
    await settle();
    const before = Math.max(...hum.voiceState().map((v) => v.pan));
    hum.update(px, pz, Math.PI); // now behind-left -> negative pan target
    const immediate = Math.max(...hum.voiceState().map((v) => v.pan));
    await settle(500);
    const after = Math.min(...hum.voiceState().map((v) => v.pan));
    res.panBefore = Math.round(before * 100) / 100;
    res.panImmediate = Math.round(immediate * 100) / 100;
    res.panAfterTurn = Math.round(after * 100) / 100;
    res.pansSwung = before > 0.5 && after < -0.5;
    res.smoothNotSnapped = immediate > 0; // hadn't jumped yet at t+0ms

    // 5. empty fixture list silences voices smoothly
    hum.setFixtures([]);
    hum.update(px, pz, yaw);
    await settle(400);
    res.emptySum = Math.round(sumGain(hum.voiceState()) * 10000) / 10000;

    // 6. audibility through an analyser on its own instance
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const hum2 = new PositionalHum(ctx, analyser);
    hum2.setFixtures([{ x: 0, z: -3 }]);
    hum2.update(px, pz, yaw);
    await settle();
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
      await new Promise((r) => setTimeout(r, 30));
    }
    res.humPeak = Math.round(peak * 10000) / 10000;
    hum2.stop();

    // 7. stop() fades everything out
    hum.stop();
    await settle(700);
    res.afterStopSum = Math.round(sumGain(hum.voiceState()) * 10000) / 10000;
    return res;
  });

  console.log('=== POSITIONAL HUM ===');
  console.log(JSON.stringify(out, null, 2));

  const fail = [];
  if (!out.hasClass) fail.push('PositionalHum missing');
  if (!(Math.abs(out.rolloffClose - 1) < 1e-6)) fail.push('rolloff close != 1');
  if (!(Math.abs(out.rolloff10 - 0.25) < 1e-6)) fail.push('rolloff(10) != 0.25');
  if (!(out.panRight > 0.99)) fail.push('panForBearing(pi/2) != +1');
  if (!out.someAhead) fail.push('no centre-panned voice for ahead fixture');
  if (!out.someRight) fail.push('no right-panned voice for right fixture');
  if (!out.farQuieter) fail.push(`far voice not attenuated (${out.nearGain} vs ${out.farGain})`);
  if (!out.capRespected) fail.push(`combined gain ${out.cappedSum} exceeds cap ${out.capLinear}`);
  if (!out.pansSwung) fail.push(`pan did not swing across on turn (${out.panBefore} -> ${out.panAfterTurn})`);
  if (!out.smoothNotSnapped) fail.push(`pan snapped instead of gliding (immediate=${out.panImmediate})`);
  if (!(out.emptySum < 0.005)) fail.push('empty fixtures did not silence voices');
  if (!(out.humPeak > 0.001)) fail.push('no audible signal from hum');
  if (!(out.afterStopSum < 0.002)) fail.push('stop() left signal (' + out.afterStopSum + ')');
  if (errors.length) fail.push('console/page errors: ' + errors.slice(0, 3).join(' | '));
  if (fail.length) { console.log('FAIL:', fail.join(' | ')); process.exit(1); }
  console.log('PASS: positional fixture hum placed, attenuated, capped, smooth, stops clean');
} finally {
  await browser.close();
}


