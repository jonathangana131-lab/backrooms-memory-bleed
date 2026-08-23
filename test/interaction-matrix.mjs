/* Interaction matrix: emergent cross-system edge cases.
 *
 * Six recently-wired system pairs are driven through their interaction
 * edge cases inside the real game loop (playwright + __BMB__ API,
 * launch pattern from travel.mjs):
 *
 *   1. Blackout + heartbeat   - heartbeat keeps beating while lights are out
 *                               (audio path independent of the visual lights)
 *   2. Landmark + weather     - discovery subtitle and storm-front warning
 *                               coexist without overlapping on screen
 *   3. Slide + torch          - torch beam tracks the camera through a height
 *                               change; no errors; slide cam contract holds
 *   4. Checkpoint during peak - F5 quick-save mid-peak restores cleanly
 *   5. Journal during ending  - J key ignored once the ending has triggered
 *   6. Minimap + fast travel  - rapid chunk crossing never breaks visited
 *                               tracking (set stays exact, map still draws)
 *
 * Row statuses:
 *   PASS   - observable behavior matches the spec above
 *   DEFECT - spec violated; row records hard evidence (does not fail the
 *            gate: the finding itself is the deliverable)
 *   FAIL   - test/harness error (network, boot, unexpected exception)
 *
 * State forcing used (all via page.evaluate against __BMB__):
 *   - audio.unlock() without a user gesture (headless has none)
 *   - blackoutUntil pushed forward directly (sustained blackout)
 *   - humans.spawn('watcher', ...) adjacent to the player
 *   - MemoryWeather internal clock/nextPlan rewritten to stage an imminent
 *     super-storm forecast inside the 30s warning window
 *   - dynamic import of /src/world/architect.ts to locate a landmark room
 *   - flashlight.has/battery granted directly before real KeyF press
 *   - dynamic import of /src/player/slide.ts: SlideController driven at
 *     module boundary because it is not consumed by the live loop yet
 *   - director.enter('peak', ...) plus F5/F9 REAL key presses
 *   - triggerEnding() invoked directly to reach the post-ending state
 *   - player.teleport(...) as the fast-travel proxy: there is no dedicated
 *     fast-travel mechanic yet, teleports exercise the same chunk-change /
 *     minimap bookkeeping path a jump across the map would
 */
import { chromium } from 'playwright-core';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BASE = 'http://127.0.0.1:5178/';
const CHUNK = 30; // src/world/constants.ts CHUNK_SIZE
const LAUNCH = {
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
};

const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One fresh browser PER scenario: software WebGL contexts are the scarcest
 * resource here and a dying renderer must not cascade across the matrix.
 * IndexedDB isolation comes free with it. */
async function boot(seed) {
  const browser = await chromium.launch(LAUNCH);
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  // Sever vite's HMR socket: while this suite runs, sibling agents edit src/,
  // and every one of their saves forces a full-page reload that would destroy
  // the execution context mid-scenario. The game itself needs no HMR.
  await ctx.routeWebSocket(/:\d+\//, (ws) => { ws.close(); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 250)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ReadPixels|GPU stall|Babylon\.js v/.test(m.text())) {
      errors.push('[console] ' + m.text().slice(0, 200));
    }
  });
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
    await page.evaluate((s) => (window).__BMB__.startNew(s), seed);
    await page.waitForTimeout(1600);
  } catch (e) {
    try { await browser.close(); } catch { /* ignore */ }
    throw e;
  }
  return { browser, ctx, page, errors };
}

async function runScenario(id, title, fn) {
  let row = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    row = { id, title, status: 'FAIL', notes: [] };
    let b = null;
    try {
      b = await boot('ix-' + id);
      await fn(row, b.page);
      if (row.status === 'FAIL') row.status = 'PASS'; // fn upgrades otherwise
    } catch (e) {
      row.status = 'FAIL';
      row.notes.push('harness error (attempt ' + attempt + '): ' + String(e).slice(0, 300));
    }
    if (b) {
      if (b.errors.length) row.notes.push('page errors: ' + b.errors.join(' | ').slice(0, 400));
      try { await b.browser.close(); } catch { /* ignore */ }
    }
    if (row.status !== 'FAIL') break; // harness errors get exactly one retry
  }
  rows.push(row);
  console.log('[' + row.status.padEnd(6) + '] ' + id + ' - ' + title);
  for (const n of row.notes) console.log('         . ' + n);
}
/* ------------------------------------------------------------------
 * 1. Blackout + heartbeat
 * ------------------------------------------------------------------ */
async function scenarioBlackoutHeartbeat(row, page) {
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.audio.unlock();                                  // forced: headless has no gesture
    if (!g.audio.started) throw new Error('audio did not start');
    g.blackoutUntil = g.playtimeSec + 30;              // forced: sustained blackout
    const px = g.player.body.x, pz = g.player.body.z;
    g.humans.spawn('watcher', px + 3.2, pz - 1.5, g.seed); // forced: watcher adjacent
  });
  await sleep(700);
  const samples = await page.evaluate(async () => {
    const g = (window).__BMB__.game;
    const out = [];
    for (let i = 0; i < 14; i++) {
      let wd = null;
      for (const e of g.humans.proximities) {
        if (e.type !== 'watcher' && e.type !== 'double') continue;
        wd = wd === null ? e.dist : Math.min(wd, e.dist);
      }
      out.push({
        hb: +(g.audio.hbIntensity || 0).toFixed(3),
        blackout: g.playtimeSec < g.blackoutUntil,
        wd: wd === null ? null : +wd.toFixed(2),
      });
      await new Promise((r) => setTimeout(r, 130));
    }
    return out;
  });
  const allBlackout = samples.every((s) => s.blackout);
  const beats = samples.filter((s) => s.hb > 0).length;
  const maxHb = Math.max.apply(null, samples.map((s) => s.hb));
  const near = samples.every((s) => s.wd === null || s.wd < 8);
  row.notes.push('blackout held entire window: ' + allBlackout +
    ' | heartbeat active in ' + beats + '/' + samples.length + ' samples (peak ' + maxHb + ')' +
    ' | watcher kept < 8m: ' + near);
  row.notes.push('sample[0]: ' + JSON.stringify(samples[0]));
  if (!allBlackout) { row.status = 'FAIL'; row.notes.push('blackout lapsed mid-scenario'); }
  if (!near) { row.status = 'FAIL'; row.notes.push('watcher drifted out of heartbeat range'); }
  if (beats < Math.ceil(samples.length * 0.5)) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: heartbeat should continue independently of lights during blackout');
  }
}
/* ------------------------------------------------------------------
 * 2. Landmark + weather
 * ------------------------------------------------------------------ */
async function scenarioLandmarkWeather(row, page) {
  const spot = await page.evaluate(async () => {
    const { landmarkFor } = await import('/src/world/architect.ts');
    const g = (window).__BMB__.game;
    const seed = g.chunks.seed;
    for (let cx = -30; cx < 30; cx++) {
      for (let cz = -30; cz < 30; cz++) {
        if (Math.hypot(cx, cz) < 3) continue;
        const lm = landmarkFor(cx, cz, seed);
        if (lm) {
          return {
            name: (lm && typeof lm === 'object' && lm.name) ? lm.name : String(lm),
            x: (cx * 12 + 6) * 2.5, z: (cz * 12 + 8) * 2.5,
          };
        }
      }
    }
    return null;
  });
  if (!spot) { row.status = 'FAIL'; row.notes.push('no landmark found within scan range'); return; }
  row.notes.push('landmark staged at (' + Math.round(spot.x) + ',' + Math.round(spot.z) + ')');

  // Force an imminent super-storm forecast: eta 20s sits inside the 30s
  // warning window; storm:true flips WeatherUI to the violet banner.
  await page.evaluate(() => {
    const w = (window).__BMB__.game.weather;
    w.t = 0;
    w.dur = 20;
    w.nextPlan = { kind: w.front.kind, strength: 0.95, storm: true };
  });
  await page.evaluate((s) => {
    const g = (window).__BMB__.game;
    g.player.teleport(s.x, s.z, Math.PI);
  }, spot);

  let coexistent = null;
  for (let i = 0; i < 40 && !coexistent; i++) {
    await page.evaluate(() => {
      const g = (window).__BMB__.game;
      g.chunks.update(g.player.body.x, g.player.body.z);
    });
    const st = await page.evaluate(() => {
      const g = (window).__BMB__.game;
      const sub = document.querySelector('.subtitle');
      const ban = document.querySelector('.bmb-weather-banner');
      return {
        lm: g.chunks.landmarkAtPos(g.player.body.x, g.player.body.z) ?? null,
        subOn: !!sub && sub.textContent.length > 0 && getComputedStyle(sub).opacity !== '0',
        subText: sub ? sub.textContent.slice(0, 60) : '',
        banOn: !!ban && ban.classList.contains('bmb-visible'),
        banText: ban ? ban.textContent : '',
        subRect: sub ? sub.getBoundingClientRect().toJSON() : null,
        banRect: ban ? ban.getBoundingClientRect().toJSON() : null,
      };
    });
    if (st.subOn && st.banOn) coexistent = st;
    await sleep(220);
  }
  if (!coexistent) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: discovery subtitle and storm warning never coexisted on screen');
    return;
  }
  const a = coexistent.subRect, b = coexistent.banRect;
  const rectsOverlap = !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
  row.notes.push('COEXIST: subtitle=\'' + coexistent.subText + '\' | banner=\'' + coexistent.banText + '\'' +
    ' | landmark=' + coexistent.lm + ' | rect overlap: ' + rectsOverlap);
  if (rectsOverlap) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: subtitle and weather banner bounding boxes intersect');
  }
}
/* ------------------------------------------------------------------
 * 3. Slide + torch
 * ------------------------------------------------------------------ */
async function scenarioSlideTorch(row, page) {
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.flashlight.has = true; g.flashlight.battery = 1; g.flashlight.on = false; // forced grant
  });
  await page.keyboard.press('KeyF');           // real input path
  await sleep(400);
  const on = await page.evaluate(() => (window).__BMB__.game.flashlight.on);
  if (!on) { row.status = 'FAIL'; row.notes.push('torch did not ignite on KeyF'); return; }

  const measure = () => page.evaluate(() => {
    const g = (window).__BMB__.game;
    const fl = g.flashlight;
    return {
      px: g.player.body.x, pz: g.player.body.z,
      yaw: g.player.yaw, pitch: g.player.pitch,
      camY: g.camera.position.y,
      rotX: +g.camera.rotation.x.toFixed(4),
      livePitch: +g.player.pitch.toFixed(4),
      dirY: +fl.light.direction.y.toFixed(4),
      lightY: fl.light.position.y,
      beamX: fl.beam.position.x, beamY: fl.beam.position.y, beamZ: fl.beam.position.z,
    };
  });

  // Leg A: real-input height change (crouch pipeline drives the camera down)
  // with the torch lit - the interaction under test.
  await page.keyboard.down('KeyC');
  await sleep(650);
  const mid = await measure();
  await page.keyboard.up('KeyC');
  await sleep(650);
  const after = await measure();

  // Beam cone must ride the exact lamp ray: apex at the lens, centre 4m out.
  const expectBeam = (m) => {
    const fx = -Math.sin(m.yaw) * Math.cos(m.pitch);
    const fz = -Math.cos(m.yaw) * Math.cos(m.pitch);
    const fy = Math.sin(-m.pitch);
    const rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw);
    const ex = m.px + rx * 0.18, ez = m.pz + rz * 0.18;
    const dx = fx + rx * 0.08, dy = fy, dz = fz + rz * 0.08;
    const len = Math.hypot(dx, dy, dz) || 1;
    return { x: ex + (dx / len) * 4, y: 1.52 + (dy / len) * 4, z: ez + (dz / len) * 4 };
  };
  const err = (m) => {
    const e = expectBeam(m);
    return Math.max(Math.abs(e.x - m.beamX), Math.abs(e.y - m.beamY), Math.abs(e.z - m.beamZ));
  };
  const midErr = err(mid), aftErr = err(after);
  row.notes.push('camera Y crouched ' + mid.camY.toFixed(2) + ' -> standing ' + after.camY.toFixed(2) +
    ' | lamp Y pinned at ' + mid.lightY.toFixed(2) +
    ' | beam apex tracking err mid=' + midErr.toFixed(4) + 'm post=' + aftErr.toFixed(4) + 'm');

  // Pitch sweep while low/high: beam must tilt with the view. Poll for
  // convergence - under SwiftShader the render loop can stall past any
  // fixed wait.
  await page.evaluate(() => { (window).__BMB__.game.player.pitch = -0.45; }); // forced look angle
  let pitched = null, pitchErr = Infinity;
  for (let i = 0; i < 16; i++) {
    await sleep(250);
    pitched = await measure();
    pitchErr = err(pitched);
    if (pitchErr < 0.05) break;
  }
  row.notes.push('beam apex moved ' + (pitched.beamY - after.beamY).toFixed(2) + 'm under pitch flip, tracking err ' + pitchErr.toFixed(4) + 'm');

  // Leg B: slide module contract (FORCED: pure module driven directly -
  // SlideController is not consumed by the live controller yet; documented).
  const slide = await page.evaluate(async () => {
    const { SlideController } = await import('/src/player/slide.ts');
    const s = new SlideController();
    let sawActive = false, maxBlend = 0, boost0 = 0;
    for (let i = 0; i < 100; i++) {
      const st = s.update(1 / 60, { sprinting: true, crouching: i < 25, speed: 4.4 });
      if (st.slideActive) { sawActive = true; if (boost0 === 0) boost0 = st.slideBoost; }
      if (s.camBlend > maxBlend) maxBlend = s.camBlend;
    }
    return { sawActive, boost0: +boost0.toFixed(3), maxBlend: +maxBlend.toFixed(3) };
  });
  row.notes.push('slide module (direct drive): active=' + slide.sawActive +
    ' initialBoost=' + slide.boost0 + ' fullCamDrop=' + slide.maxBlend);
  row.notes.push('FORCED: SlideController exercised at module boundary (not yet wired into the live loop); camera height change covered via the real crouch pipeline');

  if (!Number.isFinite(mid.beamY) || !Number.isFinite(pitched.beamY)) {
    row.status = 'FAIL';
    row.notes.push('NaN in beam transform during height change');
    return;
  }
  if (midErr > 0.05 || aftErr > 0.05 || pitchErr > 0.05) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: beam cone deviates from the lamp ray through the height/aim change');
  }
  if (!slide.sawActive || slide.boost0 < 1.29 || slide.maxBlend < 0.99) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: slide cam contract broken (active/boost/camDrop)');
  }
}
/* ------------------------------------------------------------------
 * 4. Checkpoint during peak
 * ------------------------------------------------------------------ */
async function scenarioCheckpointPeak(row, page) {
  const saved = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.player.teleport(37.5, 81.2, 1.23);
    g.erosion.stability = 0.42;                 // forced: peak-corroded stability
    g.flashlight.has = true; g.flashlight.battery = 0.66; g.flashlight.on = false;
    g.director.enter('peak', 5);                // forced: peak alive across the save
    return { phase: g.director.phase, x: g.player.body.x, z: g.player.body.z, yaw: g.player.yaw };
  });
  if (saved.phase !== 'peak') { row.status = 'FAIL'; row.notes.push('could not enter peak phase, got ' + saved.phase); return; }
  await page.keyboard.press('F5');              // REAL quick-save during peak
  await sleep(700);
  const stored = await page.evaluate(() => new Promise((res, rej) => {
    const rq = indexedDB.open('bmb');
    rq.onerror = () => rej(new Error('idb open failed'));
    rq.onsuccess = () => {
      const db = rq.result;
      try {
        const tx = db.transaction('checkpoints', 'readonly');
        const gq = tx.objectStore('checkpoints').getAllKeys();
        gq.onsuccess = () => { db.close(); res(gq.result); };
        gq.onerror = () => { db.close(); rej(gq.error); };
      } catch (e) { db.close(); rej(e); }
    };
  }));
  row.notes.push('quick-slot keys after F5: ' + JSON.stringify(stored));
  if (!stored.some((k) => String(k).startsWith('quick-'))) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: F5 quick-save during peak produced no checkpoint record');
  }

  // Read back the ACTUAL saved slot. A live peak can relocate the player via
  // a non-Euclidean nudge before or after the save - the checkpoint contract
  // is 'restore returns exactly what was saved', so the slot contents, not
  // the pre-save intent, are the source of truth.
  const recs = await page.evaluate(() => new Promise((res, rej) => {
    const rq = indexedDB.open('bmb');
    rq.onerror = () => rej(new Error('idb open failed'));
    rq.onsuccess = () => {
      const db = rq.result;
      try {
        const tx = db.transaction('checkpoints', 'readonly');
        const gq = tx.objectStore('checkpoints').getAll();
        gq.onsuccess = () => { db.close(); res(gq.result); };
        gq.onerror = () => { db.close(); rej(gq.error); };
      } catch (e) { db.close(); rej(e); }
    };
  }));
  const rec = (recs || []).filter((r) => r && r.slot && typeof r.slot.px === 'number')
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0];
  if (!rec) { row.status = 'FAIL'; row.notes.push('no readable checkpoint slot after F5'); return; }
  const want = { px: rec.slot.px, pz: rec.slot.pz, yaw: rec.slot.yaw, stab: rec.slot.stability, batt: rec.slot.flash ? rec.slot.flash.battery : null };
  row.notes.push('slot content: ' + JSON.stringify(want));

  // Let the forced peak expire BEFORE restoring: a live peak keeps firing
  // director hazards (non-Euclidean nudges relocate the player seconds after
  // restore) which would confound the restore assertions.
  for (let i = 0; i < 25; i++) {
    const ph = await page.evaluate(() => (window).__BMB__.game.director.phase);
    if (ph !== 'peak') break;
    await sleep(300);
  }
  await page.evaluate(() => { (window).__BMB__.game.player.teleport(240, 380, 2.6); });
  await sleep(300);
  await page.keyboard.press('F9');              // REAL quick-load
  // Restore is async (IDB read + full beginRun rebuild); poll rather than
  // guess a fixed wait - under SwiftShader the rebuild can take seconds.
  let now = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    now = await page.evaluate(() => {
      const g = (window).__BMB__.game;
      return {
        state: g.state, phase: g.director.phase,
        x: +g.player.body.x.toFixed(2), z: +g.player.body.z.toFixed(2), yaw: +g.player.yaw.toFixed(3),
        stab: +g.erosion.stability.toFixed(3),
        flashHas: g.flashlight.has, batt: +g.flashlight.battery.toFixed(3),
      };
    });
    if (Math.abs(now.x - 240) > 1 || Math.abs(now.z - 380) > 1) break; // teleport back landed
  }
  if (!now) { row.status = 'FAIL'; row.notes.push('no post-restore sample taken'); return; }
  row.notes.push('post-F9: ' + JSON.stringify(now));
  const posOk = Math.abs(now.x - want.px) < 0.5 && Math.abs(now.z - want.pz) < 0.5 && Math.abs(now.yaw - want.yaw) < 0.05;
  const stabOk = typeof want.stab === 'number' && Math.abs(now.stab - want.stab) < 0.05;
  const flashOk = now.flashHas && want.batt !== null && Math.abs(now.batt - want.batt) < 0.02;
  if (!(posOk && stabOk && flashOk) || now.state !== 'playing') {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: restore did not return the saved peak-era state (posOk=' + posOk +
      ' stabOk=' + stabOk + ' flashOk=' + flashOk + ' state=' + now.state + ')');
  }
  if (now.phase !== 'peak') {
    row.notes.push('OBSERVATION: director phase is not serialized (slot schema); after restore phase=' +
      now.phase + ' while all persisted peak-era state came back intact');
  }
}
/* ------------------------------------------------------------------
 * 5. Journal during ending
 * ------------------------------------------------------------------ */
async function scenarioJournalEnding(row, page) {
  // Guard against a transient hiccup: make sure the booted API is reachable.
  await page.waitForFunction(() => (window).__BMB__ && (window).__BMB__.game, null, { timeout: 30000 });
  await page.evaluate(() => { (window).__BMB__.game.triggerEnding(); }); // forced entry into ending
  await sleep(2300);                            // whiteout beat (1400ms) + showEnding
  const pre = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    return { state: g.state, journalOpen: g.journalApi ? g.journalApi.isOpen : null };
  });
  if (pre.journalOpen) { row.status = 'FAIL'; row.notes.push('journal already open before keypress'); return; }

  await page.keyboard.press('KeyJ');            // real J press after the ending
  await sleep(450);
  const post = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    const el = document.querySelector('.bmb-journal-overlay');
    return {
      journalOpen: g.journalApi ? g.journalApi.isOpen : null,
      display: el ? getComputedStyle(el).display : 'missing',
    };
  });
  row.notes.push('after ending (state=' + pre.state + '): J pressed -> isOpen=' + post.journalOpen +
    ' overlayDisplay=' + post.display);
  if (post.journalOpen || post.display === 'flex') {
    await page.keyboard.press('KeyJ');          // clean up the overlay
    await sleep(300);
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: J toggles the field journal after the ending has triggered; expected ignored/disabled');
  }
}

/* ------------------------------------------------------------------
 * 6. Minimap + fast travel
 * ------------------------------------------------------------------ */
async function scenarioMinimapFastTravel(row, page) {
  await page.keyboard.press('KeyM');            // real input: open the minimap
  await sleep(200);
  const vis = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const mini = canvases.find((c) => c.width === 150 && c.height === 150);
    return { found: !!mini, shown: mini ? mini.style.display === 'block' : false };
  });
  if (!vis.found) { row.status = 'FAIL'; row.notes.push('minimap canvas not in DOM'); return; }
  if (!vis.shown) { row.status = 'FAIL'; row.notes.push('KeyM did not reveal the minimap'); return; }

  // Phase A: long-range fast travel. Teleports hop far outside the loaded
  // ring; every landing must be recorded exactly once and never lost.
  const hops = [];
  for (let i = 1; i <= 14; i++) hops.push({ x: i * 300 + 15, z: (i % 2 ? 45 : -45) + 15 });
  await page.evaluate(async (hs) => {
    const g = (window).__BMB__.game;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // forced fast-travel proxy; one landing per rendered frame so the
    // per-frame edge detect (noteBuiltChunks) observes every arrival
    for (const h of hs) {
      g.player.teleport(h.x, h.z, 0.5);
      await frame();
    }
  }, hops);
  await sleep(500);

  // Phase B: dense ring of distinct chunks near origin (inside the map's
  // view radius) so the drawn squares can be pixel-verified afterwards.
  const ring = [];
  for (let d = 1; d <= 5; d++) { ring.push({ x: d * 30 + 15, z: 15 }); ring.push({ x: 15, z: d * 30 + 15 }); }
  await page.evaluate(async (rs) => {
    const g = (window).__BMB__.game;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const r of rs) {
      g.player.teleport(r.x, r.z, Math.PI);
      await frame();
    }
    g.player.teleport(15, 15, Math.PI);         // land home: current-chunk square
    await frame();
  }, ring);
  await sleep(600);

  const audit = await page.evaluate((CH) => {
    const g = (window).__BMB__.game;
    const set = g.minimap ? g.minimap['visited'] : null; // private field, runtime-visible
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const mini = canvases.find((c) => c.width === 150 && c.height === 150);
    let greenish = -1;
    if (mini) {
      const img = mini.getContext('2d').getImageData(0, 0, 150, 150).data;
      greenish = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i], gr = img[i + 1], b = img[i + 2];
        if (gr > 28 && gr < 110 && gr > r + 4 && gr > b + 4 && Math.abs(r - b) < 14) greenish++;
      }
    }
    // exact expected landing set (mirrors the hop plan above)
    const want = new Set(['0,0']);
    for (let i = 1; i <= 14; i++) want.add((i * 10) + ',' + (i % 2 ? 2 : -1));
    for (let d = 1; d <= 5; d++) { want.add(d + ',0'); want.add('0,' + d); }
    const have = set ? new Set(set) : new Set();
    const missing = Array.from(want).filter((k) => !have.has(k));
    const extra = Array.from(have).filter((k) => !want.has(k));
    return {
      visitedSize: set ? set.size : -1,
      sampleKeys: set ? Array.from(set).slice(0, 4) : [],
      hasHome: set ? set.has('0,0') : false,
      hasFar: set ? set.has('10,2') : false, // hop i=1: x=315 -> cx=10, z=60 -> cz=2
      missingKeys: missing,
      extraKeys: extra.slice(0, 8),
      greenishPixels: greenish,
      state: g.state,
    };
  }, CHUNK);

  // Expected exact set: 14 far landings (x=i*300+15 -> cx=i*10; z=45/-45+15
  // -> cz in {2,-1}); 5 east + 5 south near-origin ring chunks; home 0,0.
  // Every teleport lands in a fresh chunk -> exactly 25 distinct entries.
  const expected = 25;
  row.notes.push('visited set size=' + audit.visitedSize + ' (expected ' + expected + ')' +
    ' home recorded=' + audit.hasHome + ' far chunk recorded=' + audit.hasFar +
    ' sample keys=' + JSON.stringify(audit.sampleKeys));
  row.notes.push('drawn explored-square pixels detected on canvas: ' + audit.greenishPixels);
  if (audit.missingKeys.length) row.notes.push('missing landings: ' + JSON.stringify(audit.missingKeys));
  if (audit.extraKeys.length) row.notes.push('unexpected extras: ' + JSON.stringify(audit.extraKeys));
  if (audit.visitedSize !== expected) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: visited tracking diverged from the exact landing-chunk set' +
      ' (got ' + audit.visitedSize + ', wanted ' + expected + '; duplicates or losses)');
  }
  if (!audit.hasHome || !audit.hasFar) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: anchor chunks missing from visited tracking');
  }
  if (audit.greenishPixels < 100) {
    row.status = 'DEFECT';
    row.notes.push('SPEC VIOLATION: minimap stopped drawing explored squares after rapid crossing');
  }
}
/* ---------------------------------------------------------------- */

await runScenario('S1', 'Blackout + heartbeat: audio independent of lights', scenarioBlackoutHeartbeat);
await runScenario('S2', 'Landmark + weather: subtitle and storm warning coexist', scenarioLandmarkWeather);
await runScenario('S3', 'Slide + torch: beam follows camera through height change', scenarioSlideTorch);
await runScenario('S4', 'Checkpoint during peak: F5 save + F9 restore', scenarioCheckpointPeak);
await runScenario('S5', 'Journal during ending: J ignored post-trigger', scenarioJournalEnding);
await runScenario('S6', 'Minimap + fast travel: rapid chunk crossing keeps visited exact', scenarioMinimapFastTravel);

const defects = rows.filter((r) => r.status === 'DEFECT');
const failures = rows.filter((r) => r.status === 'FAIL');
console.log('');
console.log('==== INTERACTION MATRIX ====');
for (const r of rows) console.log(r.status.padEnd(7) + ' ' + r.id + '  ' + r.title);
console.log('----');
console.log('PASS ' + (rows.length - defects.length - failures.length) + '/' + rows.length +
  ' | DEFECTS: ' + (defects.map((d) => d.id).join(',') || 'none') +
  ' | FAILURES: ' + (failures.map((f) => f.id).join(',') || 'none'));
process.exit(failures.length > 0 ? 1 : 0);


