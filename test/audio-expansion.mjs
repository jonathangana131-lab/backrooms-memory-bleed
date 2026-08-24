/* Functional check for the audio expansion: positional step echo,
   zone transition stingers, heartbeat, radio static.
   Drives the real engine in-browser and measures output energy.
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

async function boot() {
  await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.__BMB__, null, { timeout: 60000 });
  await page.evaluate(() => window.__BMB__.startNew('audio-exp'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__BMB__.game.audio.unlock());
  await page.waitForTimeout(600);
}

async function evalStable(fn) {
  for (let i = 0; i < 6; i++) {
    try {
      return await page.evaluate(fn);
    } catch (e) {
      if (!/context was destroyed|Target closed|navigation/i.test(String(e))) throw e;
      console.log('(page reloaded mid-test, rebooting)');
      await boot();
    }
  }
  throw new Error('page kept reloading');
}

try {
  await boot();
  const out = await evalStable(async () => {
    const a = window.__BMB__.game.audio;
    const res = {};
    for (const m of ['setZoneTransition', 'setHeartbeat', 'heartbeatFromState', 'setRadioStatic', 'setErosionStability']) {
      res['has_' + m] = typeof a[m] === 'function';
    }
    const ctx = a.ctx;
    // make sure the context has fully resumed before trusting silence
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch {} }
    await new Promise((r3) => setTimeout(r3, 500));
    // Headless Chromium renders audio in large catch-up bursts and DROPS
    // main-thread ScriptProcessor callbacks under WebGL software-rendering
    // load, and analyser polling misses short one-shots between bursts. An
    // AudioWorklet runs on the audio thread and sees every rendered quantum,
    // so record per-stage peaks there instead.
    const WORKLET_SRC = `
      class PeakRecorder extends AudioWorkletProcessor {
        constructor() {
          super();
          this.max = 0;
          this.port.onmessage = (e) => {
            if (e.data === 'reset') { this.max = 0; return; }
            if (e.data === 'query') { this.port.postMessage({ max: this.max }); return; }
          };
        }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > this.max) this.max = v; }
          return true;
        }
      }
      registerProcessor('peak-recorder', PeakRecorder);
    `;
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    const recorder = new AudioWorkletNode(ctx, 'peak-recorder');
    a.master.connect(recorder);
    recorder.connect(ctx.destination); // pull the sink; its output stays silent
    const queryPeak = () => new Promise((resolve) => {
      recorder.port.onmessage = (e) => resolve(e.data.max);
      recorder.port.postMessage('query');
    });
    const round4 = (v) => Math.round(v * 10000) / 10000;
    const peak = async (ms) => {
      await new Promise((r2) => setTimeout(r2, ms));
      // let the rendered tail drain past the recorder before querying
      await new Promise((r2) => setTimeout(r2, 150));
      const v = await queryPeak();
      recorder.port.postMessage('reset');
      return round4(v);
    };
    // 1. zone transition stinger (cross two zones through the public path)
    await peak(50); // settle baseline, resets the recorder
    a.setZoneAmbient(1);
    a.setZoneAmbient(3); // change -> internal setZoneTransition()
    res.stingerPeak = await peak(400);
    // 2. heartbeat at full intensity
    a.setHeartbeat(1);
    res.hbFromStateLowStab = a.heartbeatFromState(0.1, 999).toFixed(2);
    res.hbFromStateCloseWatch = a.heartbeatFromState(1, 2).toFixed(2);
    res.hbFromStateCalm = a.heartbeatFromState(1, 999).toFixed(2);
    const hbPeak = await peak(1300);
    a.setHeartbeat(0);
    // 3. radio static near ARCHIVE
    a.setRadioStatic(1);
    const radioPeak = await peak(700);
    a.setRadioStatic(0);
    // 4. positional footstep echo inside a landmark room
    a.setLandmarkAmbient('ARCHIVE');
    a.footstep(false, 1);
    const echoPeak = await peak(600);
    a.setLandmarkAmbient(null);
    res.hbPeak = round4(hbPeak);
    res.radioPeak = round4(radioPeak);
    res.echoPeak = round4(echoPeak);
    return res;
  });

  console.log('=== AUDIO EXPANSION ===');
  console.log(JSON.stringify(out, null, 2));
  const fail = [];
  for (const k of Object.keys(out)) if (k.startsWith('has_') && !out[k]) fail.push(k + ' missing');
  for (const k of ['stingerPeak', 'hbPeak', 'radioPeak', 'echoPeak']) {
    if (!(out[k] > 0.001)) fail.push(k + ' shows no signal (' + out[k] + ')');
  }
  if (parseFloat(out.hbFromStateLowStab) <= 0) fail.push('low stability should trigger heartbeat');
  if (parseFloat(out.hbFromStateCloseWatch) <= 0) fail.push('close watcher should trigger heartbeat');
  if (parseFloat(out.hbFromStateCalm) !== 0) fail.push('calm state should not trigger heartbeat');
  if (errors.length) fail.push('console/page errors: ' + errors.slice(0, 3).join(' | '));
  if (fail.length) { console.log('FAIL:', fail.join(' | ')); process.exit(1); }
  console.log('PASS: all expansion layers present and audible');
} finally {
  await browser.close();
}


