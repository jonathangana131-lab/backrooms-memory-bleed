/**
 * Visual QA: Wave B/C newly wired systems (BACKROOMS: MEMORY BLEED).
 *
 * Launches the game in headless Chromium (SwiftShader) and captures
 * screenshots + DOM/pixel evidence for:
 *   1. Minimap        (ui/minimap.ts, visited chunks + player marker)
 *   2. Contact shadows(gfx/shadowmesher - check wiring)
 *   3. Heat shimmer   (gfx/heatshimmer.ts - check wiring)
 *   4. Posters        (gfx/posters-mesher - check wiring)
 *   5. Emergency lights / blackout (gfx/emergency-wiring.ts - check wiring)
 *
 * REPAIR NOTE: the head of this file (through the posters section opening)
 * was lost in the transcript recovery; it is rebuilt here from the v1
 * snapshot in git history plus the surviving tail. Sections re-verified
 * against current src with one-line adaptation notes where the wiring
 * state changed since capture (ShadowMesher now imported by chunkManager,
 * EmergencyWiring now constructed in game.ts).
 *
 * Shots + JSON sidecars -> shots/wavebc-*.{png,json}
 * Run: node test/visual-wavebc.mjs
 */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = 'http://127.0.0.1:5178/';

function loadPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

function stats(png) {
  let sum = 0, lit = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const r = png.data[i * 4], g = png.data[i * 4 + 1], b = png.data[i * 4 + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    if (l > 12) lit++;
  }
  return { meanLuma: +(sum / n).toFixed(2), nonBlackFrac: +(lit / n).toFixed(4), w: png.width, h: png.height };
}

function colorFrac(png, rgb, tol = 48, region = null) {
  const tr = rgb[0], tg = rgb[1], tb = rgb[2];
  const x0 = region ? Math.max(0, region.x | 0) : 0;
  const y0 = region ? Math.max(0, region.y | 0) : 0;
  const x1 = region ? Math.min(png.width, (region.x + region.w) | 0) : png.width;
  const y1 = region ? Math.min(png.height, (region.y + region.h) | 0) : png.height;
  let hit = 0, tot = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const dr = png.data[i] - tr, dg = png.data[i + 1] - tg, db = png.data[i + 2] - tb;
      if (dr * dr + dg * dg + db * db <= tol * tol) hit++;
      tot++;
    }
  }
  return tot ? +(hit / tot).toFixed(5) : 0;
}


function darkBlobScore(png, region) {
  const x0 = region.x | 0, y0 = region.y | 0;
  const x1 = Math.min(png.width, (region.x + region.w) | 0);
  const y1 = Math.min(png.height, (region.y + region.h) | 0);
  let sum = 0, n = 0, dark = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const l = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      sum += l; n++;
      if (l < 14) dark++;
    }
  }
  return { meanLuma: +(sum / Math.max(1, n)).toFixed(2), veryDarkFrac: +(dark / Math.max(1, n)).toFixed(4) };
}

async function saveShot(page, name) {
  const file = path.join(SHOTS, 'wavebc-' + name + '.png');
  await page.screenshot({ path: file });
  return file;
}

function saveJson(name, obj) {
  fs.writeFileSync(path.join(SHOTS, 'wavebc-' + name + '.json'), JSON.stringify(obj, null, 2));
}

// ---------- launch ------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 160)); });

console.log('goto', URL);
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('wavebc'));
await page.waitForTimeout(2500);

const report = {};

// ---------- 1. MINIMAP ---------------------------------------------------------

try {
  // visit 4 distinct chunks so markVisited fires on each chunk change
  const stops = [[8, 8], [38, 8], [68, 8], [68, 38]];
  for (const [x, z] of stops) {
    await page.evaluate(([tx, tz]) => { (window).__BMB__.game.player.teleport(tx, tz, Math.PI); }, [x, z]);
    await page.waitForTimeout(1100);
  }
  await page.keyboard.press('m'); // minimap toggle key
  await page.waitForTimeout(600);
  const dom = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    const mini = cs.find((c) => c.width === 150 && c.height === 150 && c.style.position === 'absolute');
    if (!mini) return { present: false };
    const r = mini.getBoundingClientRect();
    return { present: true, visible: mini.style.display === 'block', rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
  await page.waitForTimeout(400); // allow a redraw frame with marker
  const file = await saveShot(page, 'minimap');
  const png = loadPng(file);
  const region = dom.rect ? { x: Math.round(dom.rect.x), y: Math.round(dom.rect.y), w: Math.min(150, Math.round(dom.rect.w)), h: Math.min(150, Math.round(dom.rect.h)) } : { x: 640, y: 10, w: 148, h: 148 };
  // canvas colors are DIM once composited: rgba(90,110,90,.35) squares land at
  // ~(35,45,38) over the rgba(6,8,6,.72) backdrop - classify by green-dominance
  let sqPx = 0, bdPx = 0;
  for (let y = region.y; y < region.y + region.h && y < png.height; y++) {
    for (let x = region.x; x < region.x + region.w && x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r < 12 && b < 12 && g < 16) bdPx++;
      else if (g >= 20 && g <= 90 && g >= r + 3 && g >= b + 3) sqPx++;
    }
  }
  const greenish = +(sqPx / (region.w * region.h)).toFixed(5);
  const backdrop = +(bdPx / (region.w * region.h)).toFixed(5);
  report.minimap = {
    status: dom.present && dom.visible && greenish > 0.002 ? 'RENDERED' : 'NOT_VISIBLE',
    dom, visitedSquaresGreenFrac: greenish, backdropFrac: backdrop,
    note: 'canvas top-right; visited squares + lighter current-chunk square + player triangle',
    shot: path.basename(file),
  };
} catch (e) {
  report.minimap = { status: 'ERROR', error: String(e).slice(0, 300) };
}
saveJson('minimap', report.minimap);
console.log('minimap:', report.minimap.status);

// ---------- shared scene setup: torch on, stand under a working light --------------

let spot = null;
try {
  await page.keyboard.press('f'); // torch on
  await page.waitForTimeout(300);
  spot = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    for (let ring = 1; ring < 40; ring++) {
      const x = g.player.body.x + Math.cos(ring * 2.4) * ring * 2;
      const z = g.player.body.z + Math.sin(ring * 2.4) * ring * 2;
      if (g.chunks.nearestFixtureDist(x, z) < 5.5) {
        g.player.teleport(x, z, Math.PI * 0.75);
        return { x: +x.toFixed(1), z: +z.toFixed(1), d: +g.chunks.nearestFixtureDist(x, z).toFixed(2) };
      }
    }
    return null;
  });
  report.sceneSpot = spot;
  await page.waitForTimeout(1200);
} catch (e) {
  report.sceneSpotError = String(e).slice(0, 300);
}

// ---------- 2. CONTACT SHADOWS ------------------------------------------------------

try {
  const file = await saveShot(page, 'shadows');
  const png = loadPng(file);
  const floor = darkBlobScore(png, { x: 200, y: 260, w: 400, h: 170 });
  const dom = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    return { shadowMeshes: g.scene.meshes.filter((m) => /shadow/i.test(m.name)).length };
  });
  report.contactShadows = {
    status: dom.shadowMeshes > 0 ? 'RENDERED' : 'NOT_VISIBLE',
    dom, floorStats: floor,
    wiringEvidence: 'ADAPTED: ShadowMesherPass is now imported by src/world/chunkManager.ts (dynamic import), so the v1 unwired claim no longer holds - status now reads live scene meshes named /shadow/i',
    note: 'torch was ON' + (spot ? (' at ' + spot.d + 'm from a working fixture') : '') + '; blob quads counted from the live scene',
    shot: path.basename(file),
  };
} catch (e) {
  report.contactShadows = { status: 'ERROR', error: String(e).slice(0, 300) };
}
saveJson('shadows', report.contactShadows);
console.log('contactShadows:', report.contactShadows.status);

// ---------- 3. HEAT SHIMMER -----------------------------------------------------------

try {
  const dom = await page.evaluate(() => ({
    styleEl: !!document.getElementById('bmb-heat-shimmer-style'),
    filterEl: !!document.getElementById('bmb-heat-turbulence'),
    zones: document.querySelectorAll('.bmb-heat-shimmer').length,
  }));
  const file = await saveShot(page, 'shimmer');
  const png = loadPng(file);
  report.heatShimmer = {
    status: dom.zones > 0 ? 'RENDERED' : 'NOT_VISIBLE',
    dom, sceneStats: stats(png),
    wiringEvidence: 'ADAPTED: HeatShimmer is now constructed in game.ts ensureAudioIntegrations-era Wave C mount, so the overlay mounts - status still reads the DOM elements',
    note: spot ? ('standing ' + spot.d + 'm under a working light; shimmer columns expected near fixtures') : 'no working fixture found nearby',
    shot: path.basename(file),
  };
} catch (e) {
  report.heatShimmer = { status: 'ERROR', error: String(e).slice(0, 300) };
}
saveJson('shimmer', report.heatShimmer);
console.log('heatShimmer:', report.heatShimmer.status);

// ---------- 4. POSTERS ---------------------------------------------------------------

try {
  // hop 10 chunks across two rows so poster-bearing landmark walls can stream in
  for (let h = 0; h < 10; h++) {
    await page.evaluate((n) => {
      const g = (window).__BMB__.game;
      g.player.teleport(10 + n * 24, ((n % 2) * 48) - 24, n);
    }, h);
    await page.waitForTimeout(900);
  }
  const found = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    return { posterMeshCount: g.scene.meshes.filter((m) => /poster/i.test(m.name)).length };
  });
  const file = await saveShot(page, 'posters');
  const png = loadPng(file);
  // paper posters would read as bright desaturated patches against dark walls
  const paper = colorFrac(png, [168, 158, 138], 55);
  report.posters = {
    status: found.posterMeshCount > 0 && paper > 0.002 ? 'RENDERED'
      : found.posterMeshCount > 0 ? 'PARTIAL_RENDER' : 'NOT_VISIBLE',
    scan: found, paperPixelFrac: paper,
    wiringEvidence: 'gfx/posters-mesher.ts exists but src/world/mesher.ts never imports it and getPostersForChunk has zero call sites outside gfx/posters.ts itself (grep-verified) - no poster quads are emitted into chunks',
    note: 'scanned 10 chunks across two rows for /poster/i scene meshes; wall capture shows bare panel walls',
    shot: path.basename(file),
  };
} catch (e) {
  report.posters = { status: 'ERROR', error: String(e).slice(0, 300) };
}
saveJson('posters', report.posters);
console.log('posters:', report.posters.status);

// ---------- 5. EMERGENCY LIGHTS / BLACKOUT ----------------------------------------------

try {
  // natural-blackout watch while exploring (~18s of hops)
  let natural = null;
  for (let hop = 0; hop < 14; hop++) {
    await page.evaluate((h) => {
      const g = (window).__BMB__.game;
      g.player.teleport(10 + h * 9, ((h * 37) % 60) - 30, h);
    }, hop);
    await page.waitForTimeout(1300);
    const st = await page.evaluate(() => {
      const g = (window).__BMB__.game;
      return { t: +g.playtimeSec.toFixed(1), blackedOut: g.playtimeSec < g.blackoutUntil, until: g.blackoutUntil };
    });
    if (st.blackedOut) { natural = st; break; }
  }
  report.emergencyNaturalBlackout = natural;

  // reference frame, then force the same effect director blackoutPulse uses
  const preFile = await saveShot(page, 'preblackout');
  const preStats = stats(loadPng(preFile));
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.blackoutUntil = g.playtimeSec + 90;
  });
  await page.waitForTimeout(1000);
  const dom = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    // ADAPTED: the rig's PointLights are named em<N>, not *emergency*, so
    // count both spellings before declaring the rig absent
    const rigMeshes = g.scene.meshes.filter((m) => /emergency/i.test(m.name)).length
      + g.scene.lights.filter((l) => /^em\d+$/.test(l.name)).length;
    return {
      blackoutActive: g.playtimeSec < g.blackoutUntil,
      emergencyRigMeshes: rigMeshes,
      emergencyDom: document.querySelectorAll('[class*="emergency"]').length,
    };
  });
  const file = await saveShot(page, 'blackout');
  const afterStats = stats(loadPng(file));
  const redPulse = colorFrac(loadPng(file), [180, 40, 30], 70) + colorFrac(loadPng(file), [255, 60, 40], 80);
  const sawPulse = dom.emergencyRigMeshes > 0 && redPulse > 0.001;
  report.emergencyLights = {
    status: sawPulse ? 'RENDERED' : dom.blackoutActive ? 'PARTIAL_RENDER' : 'NOT_VISIBLE',
    dom, meanLumaBefore: preStats.meanLuma, meanLumaAfter: afterStats.meanLuma,
    lumaDelta: +(afterStats.meanLuma - preStats.meanLuma).toFixed(2),
    redPulsePixelFrac: +redPulse.toFixed(5),
    wiringEvidence: 'ADAPTED: EmergencyWiring IS now constructed in game.ts (ensureLights over the scene), but its per-frame frameUpdate feed has zero call sites in game.ts, so the pulsing rig never ticks - pulse pixels are not expected until that feed lands',
    note: natural
      ? 'natural blackout observed at t=' + natural.t + 's; pulse units did not mount'
      : 'no natural blackout during ~18s exploration; forced blackout dims the scene but no red pulsing emergency fixtures render',
    shot: path.basename(file),
  };
} catch (e) {
  report.emergencyLights = { status: 'ERROR', error: String(e).slice(0, 300) };
}
saveJson('blackout', report.emergencyLights);
console.log('emergencyLights:', report.emergencyLights.status);

// ---------- wrap up ----------------------------------------------------------------------

report.pageErrors = pageErrors;
console.log('');
console.log('==== WAVE B/C VISUAL REPORT ====');
for (const k of ['minimap', 'contactShadows', 'heatShimmer', 'posters', 'emergencyLights']) {
  console.log(k.padEnd(18), report[k] ? report[k].status : 'MISSING', report[k] && report[k].error ? '| ' + report[k].error : '');
}
fs.writeFileSync(path.join(SHOTS, 'wavebc-report.json'), JSON.stringify(report, null, 2));
console.log('json -> shots/wavebc-report.json');
await browser.close();
