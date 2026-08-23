/**
 * Visual QA: Wave B/C newly wired systems (BACKROOMS: MEMORY BLEED).
 *
 * Launches the game in headless Chromium (SwiftShader) and captures
 * screenshots + DOM/pixel evidence for:
 *   1. Minimap        (ui/minimap.ts, visited chunks + player marker)
 *   2. Compass        (ui/compass.ts, edge chevron aimed away from beacon)
 *   3. Weather UI     (ui/weatherui.ts, warning banner via forced low eta)
 *   4. Contact shadows(gfx/contactshadow/shadowmesher - check wiring)
 *   5. Heat shimmer   (gfx/heatshimmer.ts - check wiring)
 *   6. Emergency lights / blackout (gfx/emergency-wiring.ts - check wiring)
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
    shot: file,
  };
} catch (e) {
  report.minimap = { status: 'ERROR', error: String(e).slice(0, 300) };
}


// ---------- 2. COMPASS -----------------------------------------------------------

try {
  const b = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    const list = [...g.story.beacons.values()].filter((x) => !x.found);
    if (!list.length) return null;
    list.sort((p, q) => Math.hypot(p.x - g.player.body.x, p.z - g.player.body.z) - Math.hypot(q.x - g.player.body.x, q.z - g.player.body.z));
    return { x: list[0].x, z: list[0].z };
  });
  if (!b) throw new Error('no unfound beacons');
  // stand ~28m away and face directly away from it (forward = (-sin yaw, -cos yaw))
  await page.evaluate((b) => {
    const g = (window).__BMB__.game;
    const px = b.x + 20, pz = b.z + 20;
    const dx = b.x - px, dz = b.z - pz;
    g.player.teleport(px, pz, Math.atan2(-dx, -dz)); // facing opposite of beacon direction
  }, b);
  await page.waitForTimeout(900);
  const dom = await page.evaluate(() => {
    const root = document.querySelector('.bmb-compass-root');
    const chev = document.querySelector('.bmb-compass-chev');
    if (!root) return { rootPresent: false };
    const info = { rootPresent: true, chevPresent: !!chev };
    if (chev) {
      const st = getComputedStyle(chev);
      const r = chev.getBoundingClientRect();
      info.chev = { opacity: +st.opacity, offsetWH: [chev.offsetWidth, chev.offsetHeight], transform: st.transform.slice(0, 60), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    }
    return info;
  });
  const file = await saveShot(page, 'compass');
  const png = loadPng(file);
  const teal = colorFrac(png, [140, 230, 220], 70);
  report.compass = {
    status: dom.rootPresent && dom.chevPresent && dom.chev && dom.chev.opacity > 0.05 &&
      (dom.chev.offsetWH[0] > 0 || teal > 0.0002) ? 'RENDERED' : 'NOT_VISIBLE',
    beacon: b, dom, tealPixelFrac: teal,
    note: 'edge chevron points toward nearest unfound beacon while player faces away (~28m)',
    shot: file,
  };
} catch (e) {
  report.compass = { status: 'ERROR', error: String(e).slice(0, 300) };
}

// ---------- 3. WEATHER UI ----------------------------------------------------------

try {
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    // force nextFront() to report an imminent calm front (etaSec far under 30s threshold)
    g.weather.nextFront = () => ({ kind: 0, intensity: 0.75, etaSec: 6, storm: false });
  });
  await page.waitForTimeout(6000); // WARNING_FADE_MS = 3000 fade-in (headless frames run slow)
  const dom = await page.evaluate(() => {
    const el = document.querySelector('.bmb-weather-banner');
    if (!el) return { present: false };
    const st = getComputedStyle(el);
    return { present: true, classes: el.className, text: el.textContent, opacity: +st.opacity, color: st.color };
  });
  const file = await saveShot(page, 'weather');
  const png = loadPng(file);
  const amberTop = colorFrac(png, [255, 179, 71], 80, { x: 100, y: 20, w: 600, h: 90 });
  report.weatherUi = {
    status: dom.present && (dom.opacity > 0.9 ? amberTop > 0.0002 : amberTop > 0.002) ? 'RENDERED' : 'NOT_VISIBLE',
    dom, amberBannerPixelFrac: amberTop,
    note: 'forced weather.nextFront() etaSec=6 via evaluate; banner fades in under the 30s threshold',
    shot: file,
  };
} catch (e) {
  report.weatherUi = { status: 'ERROR', error: String(e).slice(0, 300) };
}


// ---------- pre-blackout reference frame ------------------------------------------

const refBefore = await saveShot(page, 'preblackout');
const beforeStats = stats(loadPng(refBefore));

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

// ---------- 4. CONTACT SHADOWS ------------------------------------------------------

try {
  const file = await saveShot(page, 'shadows');
  const png = loadPng(file);
  const floor = darkBlobScore(png, { x: 200, y: 260, w: 400, h: 170 });
  report.contactShadows = {
    status: 'NOT_VISIBLE',
    floorStats: floor,
    wiringEvidence: 'gfx/shadowmesher.ts exists but is not imported by src/world/mesher.ts or game.ts (grep-verified) - the decal pass is unwired at capture time',
    note: 'torch was ON' + (spot ? (' at ' + spot.d + 'm from a working fixture') : '') + '; no blob quads until ShadowMesherPass is emitted from the chunk mesher',
    shot: file,
  };
} catch (e) {
  report.contactShadows = { status: 'ERROR', error: String(e).slice(0, 300) };
}

// ---------- 5. HEAT SHIMMER -----------------------------------------------------------

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
    wiringEvidence: 'gfx/heatshimmer.ts exports HeatShimmer but nothing constructs it (zero call sites across src/) - overlay never mounts',
    note: spot ? ('standing ' + spot.d + 'm under a working light; shimmer columns absent') : 'no working fixture found nearby',
    shot: file,
  };
} catch (e) {
  report.heatShimmer = { status: 'ERROR', error: String(e).slice(0, 300) };
}


// ---------- 6. EMERGENCY LIGHTS / BLACKOUT --------------------------------------------

try {
  // fresh reference frame from the CURRENT pose, so the luma delta isolates blackout
  const preStats = stats(loadPng(await saveShot(page, 'preblackout')));
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.blackoutUntil = g.playtimeSec + 90; // same effect as director blackoutPulse
  });
  await page.waitForTimeout(1000);
  const dom = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    return {
      blackoutActive: g.playtimeSec < g.blackoutUntil,
      emergencyRigMounted: !!document.querySelector('[class*="emergency"]'),
    };
  });
  const file = await saveShot(page, 'blackout');
  const afterStats = stats(loadPng(file));
  report.emergencyLights = {
    status: dom.blackoutActive ? 'PARTIAL_RENDER' : 'NOT_VISIBLE',
    dom, meanLumaBefore: preStats.meanLuma, meanLumaAfter: afterStats.meanLuma,
    lumaDelta: +(afterStats.meanLuma - preStats.meanLuma).toFixed(2),
    wiringEvidence: 'fixture emissive cutoff + postfx blackout pulse ARE wired (game.ts blackoutUntil path); the EmergencyWiring -> EmergencyLights battery rig has zero construction sites in game code, so dedicated pulsing units do not mount',
    note: 'scene dims during forced blackout but no pulsing emergency fixtures render',
    shot: file,
  };
} catch (e) {
  report.emergencyLights = { status: 'ERROR', error: String(e).slice(0, 300) };
}

report.pageErrors = pageErrors;
console.log('\n==== WAVE B/C VISUAL REPORT ====');
for (const k of ['minimap', 'compass', 'weatherUi', 'contactShadows', 'heatShimmer', 'emergencyLights']) {
  console.log(k.padEnd(18), report[k] ? report[k].status : 'MISSING', report[k] && report[k].error ? '| ' + report[k].error : '');
}
fs.writeFileSync(path.join(SHOTS, 'wavebc-report.json'), JSON.stringify(report, null, 2));
console.log('json -> shots/wavebc-report.json');
await browser.close();




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
    const rigMeshes = g.scene.meshes.filter((m) => /emergency/i.test(m.name)).length;
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
    wiringEvidence: 'fixture emissive cutoff + postfx blackout pulse ARE wired via game.ts blackoutUntil; EmergencyWiring (the adapter that constructs EmergencyLights pulsing units) has ZERO construction sites in game code (grep-verified)',
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



