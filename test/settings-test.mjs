/* Functional verification of agent-added settings: FOV + subtitles. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 200)));
// Patient boot: networkidle never settles on a loaded box (procedural asset
// gen keeps the page busy), so anchor on domcontentloaded + the __BMB__ flag.
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:4178/', { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 300000 });
await page.evaluate(() => (window).__BMB__.startNew('set'));
await page.waitForTimeout(1500);

// F91: dismiss the wake cinematic so the player controller owns camera.fov
// again (the sequence rewrites fov per shot; finishToRise restores baseFovRad).
// Then POLL for the wake rise finishing — under SwiftShader sim time lags wall
// time badly (clamped deltas at low fps), so fixed sleeps land mid-rise.
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  if (g.wakePlaying ? g.wakePlaying() : true) g.dismissWakeCinematic();
});
await page.waitForFunction(() => {
  const g = (window).__BMB__.game;
  return !!g.player && g.player.enabled === true && !g.wakeMount;
}, null, { timeout: 180000 });
await page.waitForTimeout(400);

// FOV: set 110, camera fov should become ~1.92 rad
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.applySettings({ sensitivity: 1, volume: 0.8, quality: 1, fov: 110 });
});
await page.waitForTimeout(400);
const fov = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { camFovRad: +g.camera.fov.toFixed(3), expected: +(110 * Math.PI / 180).toFixed(3) };
});
console.log('FOV', JSON.stringify(fov), fov.camFovRad === fov.expected ? 'FOV_OK' : 'FOV_BAD');

// Subtitle suppression seam: show a live line first, then turn subtitles off
// through the canonical applySettings path (panel store -> SettingsData ->
// ui.setSubtitlesOn). The live line must clear AND new say() calls stay
// suppressed — say() alone only gates NEW lines.
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.ui.say('stale line while subs on', 20);
});
await page.waitForTimeout(200);
const subPre = await page.evaluate(() => getComputedStyle(document.querySelector('.subtitle')).opacity);
console.log('SUBTITLES_PRE_ON_OPACITY=' + subPre, parseFloat(subPre) > 0.5 ? 'SUBS_PRE_OK' : 'SUBS_PRE_BAD');

await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.applySettings({ sensitivity: 1, volume: 0.8, quality: 1, fov: 110, subtitles: false });
});
// Poll for the clear: the .4s CSS transition plus loaded-box style-recalc
// starvation means a fixed sleep lands mid-drain.
await page.waitForFunction(() => {
  const el = document.querySelector('.subtitle');
  return el && el.textContent === '' && parseFloat(getComputedStyle(el).opacity) < 0.05;
}, null, { timeout: 30000 });
const sub = await page.evaluate(() => {
  const el = document.querySelector('.subtitle');
  return { op: getComputedStyle(el).opacity, text: el.textContent };
});
console.log('SUBTITLES_OFF', JSON.stringify(sub),
  parseFloat(sub.op) < 0.05 && sub.text === '' ? 'SUBS_OK' : 'SUBS_BAD');

// While suppressed, say() must not display either
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.ui.say('this must not appear', 3);
});
await page.waitForTimeout(600);
const subSuppressed = await page.evaluate(() => {
  const el = document.querySelector('.subtitle');
  return { op: getComputedStyle(el).opacity, text: el.textContent };
});
console.log('SUBTITLES_SUPPRESSED', JSON.stringify(subSuppressed),
  parseFloat(subSuppressed.op) < 0.05 && subSuppressed.text === '' ? 'SUBS_SUPPRESS_OK' : 'SUBS_SUPPRESS_BAD');

// Regression: a legacy slider push (pushSettings -> onSettingsChanged ->
// applySettings) must NOT re-enable subtitles while off. Before the fix the
// slider payload omitted `subtitles`, so applySettings' absent->default-on
// rule flipped it back on AND persisted the clobber.
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.ui.pushSettings();
});
const subSlider = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  // g.settings is the canonical SettingsData applySettings just wrote;
  // if it flipped subtitles back on here it also persisted that clobber.
  return { uiOn: g.ui.subtitlesOn, storedSubtitles: g.settings.subtitles };
});
console.log('SUBS_SLIDER_PUSH', JSON.stringify(subSlider),
  subSlider.uiOn === false && subSlider.storedSubtitles === false ? 'SUBS_SLIDER_OK' : 'SUBS_SLIDER_BAD');

// Subtitles on -> displays
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.applySettings({ sensitivity: 1, volume: 0.8, quality: 1, fov: 110, subtitles: true });
  g.ui.say('visible now', 2);
});
await page.waitForTimeout(300);
const sub2 = await page.evaluate(() => document.querySelector('.subtitle')?.textContent);
// endsWith: the F49 speaker-tag tagger may prefix '[SYSTEM] ' when speakerTags
// is persisted on from an unrelated run — the line itself is what matters.
console.log('SUBTITLES_ON_TEXT=' + JSON.stringify(sub2), (sub2 ?? '').endsWith('visible now') ? 'SUBS2_OK' : 'SUBS2_BAD');

// settings persist with fov.
// Root cause of the old crash: the game's save layer (src/save/db.ts) opens
// 'bmb' at version 2, so opening it at version 1 here raised a VersionError
// on a request whose handlers only covered success — the evaluate promise
// never settled and Playwright garbage-collected it. Open without a version
// (never a VersionError), settle every request through error paths too, and
// race the whole read against an explicit timeout so this evaluate always
// resolves. Assertions unchanged: the persisted 'kv'/'settings' record must
// come back and be logged.
const kv = await page.evaluate(async () => {
  const withTimeout = (p, ms, what) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('settings-read timeout: ' + what)), ms)),
  ]);
  const db = await withTimeout(new Promise((res, rej) => {
    const r = indexedDB.open('bmb'); // no version -> never a VersionError
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('open failed'));
    r.onblocked = () => rej(new Error('open blocked'));
  }), 10000, 'indexedDB.open');
  try {
    if (!db.objectStoreNames.contains('kv')) throw new Error('kv store missing');
    const val = await withTimeout(new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const q = tx.objectStore('kv').get('settings');
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error ?? new Error('get failed'));
      tx.onabort = () => rej(tx.error ?? new Error('transaction aborted'));
    }), 10000, 'kv.get(settings)');
    return val;
  } finally {
    db.close();
  }
});
console.log('PERSISTED_SETTINGS', JSON.stringify(kv));
if (!kv || kv.fov !== 110) {
  console.log('PERSIST_BAD', 'expected persisted fov 110');
} else {
  console.log('PERSIST_OK');
}
await browser.close();


