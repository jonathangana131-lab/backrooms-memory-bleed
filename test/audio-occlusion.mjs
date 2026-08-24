/* Functional check for audio occlusion + spatial improvements:
   wall lowpass sweep on the ambient bed, inverse-square distance
   rolloff, district-dependent reverb wet, whisper panning.
   Drives the real engine in-browser and measures node params /
   channel energy. Tolerates Vite full-reloads from concurrent edits. */
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
  await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__BMB__, null, { timeout: 60000 });
  await page.evaluate(() => window.__BMB__.startNew('audio-occ'));
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__BMB__.game.audio.unlock());
  await page.waitForTimeout(500);
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

const close = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const asym = ([sl, sr]) => (sl + sr) === 0 ? 0 : (sl - sr) / (sl + sr);

try {
  await boot();
  const out = await evalStable(async () => {
    const a = window.__BMB__.game.audio;
    const res = { api: {}, ctxState: a.ctx?.state };
    if (a.ctx.state !== 'running') { try { await a.ctx.resume(); } catch {} }

    // API surface
    for (const m of ['setOcclusion', 'setDistrict', 'setWhisperPan', 'setSpaceSize', 'whisper']) {
      res.api[m] = typeof a[m] === 'function';
    }
    res.api.rolloff = typeof a.constructor.rolloff === 'function';

    // inverse-square rolloff math
    res.rolloff = {
      near: a.constructor.rolloff(4),
      at5: a.constructor.rolloff(5),
      at10: a.constructor.rolloff(10),
      inf: a.constructor.rolloff(Infinity),
      nan: a.constructor.rolloff(NaN),
    };

    // locate the stored lowpass occlusion node on the engine
    const findOcclusion = (engine) => {
      for (const key of Object.getOwnPropertyNames(engine)) {
        const v = engine[key];
        if (v && typeof v === 'object' && v.type === 'lowpass' && v.frequency) return v;
      }
      return null;
    };

    // occlusion filter sweep
    a.setOcclusion(1);
    await new Promise((r2) => setTimeout(r2, 900));
    res.occludedHz = findOcclusion(a)?.frequency.value ?? null;
    a.setOcclusion(0);
    await new Promise((r2) => setTimeout(r2, 900));
    res.openHz = findOcclusion(a)?.frequency.value ?? null;

    // district reverb wet: the game loop keeps re-applying setSpaceSize,
    // so compare districts RELATIVELY against the neutral state
    const settle = (ms) => new Promise((r2) => setTimeout(r2, ms));
    a.setSpaceSize(0.3);
    a.setDistrict(-1); // neutral
    await settle(2400);
    res.verbNeutral = a.reverbGain.gain.value;
    a.setDistrict(4); // STORAGE -> metallic echo boost
    await settle(2800);
    res.verbStorage = a.reverbGain.gain.value;
    a.setDistrict(1); // OPEN_OFFICE -> deadened
    await settle(3200);
    res.verbOffice = a.reverbGain.gain.value;
    a.setDistrict(-1);

    // whisper panning, two ways:
    // (1) structural — capture the StereoPanner whisper() builds and read
    //     the pan value it was given;
    // (2) acoustic — tap THAT panner directly so only the whisper under
    //     test reaches the analysers (the shared master bus carries the
    //     game's own random-pan whispers and the centered ambience bed).
    // The interception covers ONLY the synchronous whisper() call: the live
    // loop keeps creating unrelated StereoPanners (zone-event clatter,
    // music voices) on timers, so any await with the hook installed lets
    // one race in and get misattributed to the whisper under test.
    const origCreate = a.ctx.createStereoPanner.bind(a.ctx);
    const capturePanners = async (pan) => {
      a.setWhisperPan(pan);
      await new Promise((r2) => setTimeout(r2, 30));
      let made = [];
      a.ctx.createStereoPanner = (...args) => {
        const n = origCreate(...args);
        made.push(n);
        return n;
      };
      try {
        a.whisper(); // synchronous: builds exactly one StereoPanner
      } finally {
        a.ctx.createStereoPanner = origCreate;
      }
      await new Promise((r2) => setTimeout(r2, 120));
      const node = made[made.length - 1];
      const split = a.ctx.createChannelSplitter(2);
      node.connect(split);
      const mk = () => { const x = a.ctx.createAnalyser(); x.fftSize = 2048; return x; };
      const anL = mk(), anR = mk();
      split.connect(anL, 0); split.connect(anR, 1);
      const td = new Float32Array(2048);
      let sl = 0, sr = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 1600) {
        anL.getFloatTimeDomainData(td);
        for (let i2 = 0; i2 < td.length; i2++) sl += td[i2] * td[i2];
        anR.getFloatTimeDomainData(td);
        for (let i2 = 0; i2 < td.length; i2++) sr += td[i2] * td[i2];
        await new Promise((r2) => setTimeout(r2, 25));
      }
      node.disconnect(split);
      const asym2 = (sl + sr) <= 0 ? 0 : (sl - sr) / (sl + sr);
      return { pans: made.map((n2) => n2.pan.value), asym: asym2 };
    };
    res.panLeftCaptured = await capturePanners(-0.9);
    await new Promise((r2) => setTimeout(r2, 2400));
    res.panRightCaptured = await capturePanners(0.9);
    return res;
  });

  console.log(JSON.stringify(out, null, 1));

  let fails = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) fails++;
  };

  for (const m of ['setOcclusion', 'setDistrict', 'setWhisperPan', 'rolloff']) {
    check('api.' + m, out.api[m] === true);
  }

  check('rolloff unity within 5m', out.rolloff.near === 1 && out.rolloff.at5 === 1);
  check('rolloff inverse-square beyond 5m',
    close(out.rolloff.at10, 0.25, 1e-6) && out.rolloff.inf === 0 && out.rolloff.nan === 0,
    `at10=${out.rolloff.at10} inf=${out.rolloff.inf} nan=${out.rolloff.nan}`);

  check('occlusion fully closed sweeps toward 800Hz',
    out.occludedHz !== null && out.occludedHz < 1600, `hz=${out.occludedHz}`);
  check('occlusion open restores ~20kHz',
    out.openHz !== null && out.openHz > 15000, `hz=${out.openHz}`);

  check('STORAGE boosts reverb wet vs neutral', out.verbStorage > out.verbNeutral * 1.15,
    `storage=${out.verbStorage.toFixed(3)} neutral=${out.verbNeutral.toFixed(3)}`);
  check('OPEN_OFFICE deadens reverb wet vs neutral', out.verbOffice < out.verbNeutral * 0.85,
    `office=${out.verbOffice.toFixed(3)} neutral=${out.verbNeutral.toFixed(3)}`);

  const capL = out.panLeftCaptured, capR = out.panRightCaptured;
  check('whisper node created with requested pan (-0.9)',
    capL.pans.length > 0 && Math.abs(capL.pans[capL.pans.length - 1] + 0.9) < 1e-4,
    `pans=${JSON.stringify(capL.pans)}`);
  check('whisper node created with requested pan (+0.9)',
    capR.pans.length > 0 && Math.abs(capR.pans[capR.pans.length - 1] - 0.9) < 1e-4,
    `pans=${JSON.stringify(capR.pans)}`);
  check('whisper audible and panned left acoustically',
    capL.asym > 0.5, `asym=${capL.asym?.toFixed(3)}`);
  check('whisper audible and panned right acoustically',
    capR.asym < -0.5, `asym=${capR.asym?.toFixed(3)}`);

  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));

  console.log(fails === 0 ? '\nAUDIO-OCCLUSION: ALL PASS' : `\nAUDIO-OCCLUSION: ${fails} FAILURE(S)`);
  process.exitCode = fails === 0 ? 0 : 1;
} catch (e) {
  console.error('HARNESS ERROR', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}


