/* Functional verification of agent-added settings: FOV + subtitles. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 200)));
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:4178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('set'));
await page.waitForTimeout(1500);

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

// Subtitles off -> say() must not display
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.ui.subtitlesOn = false;
  g.ui.say('this must not appear', 3);
});
await page.waitForTimeout(300);
const sub = await page.evaluate(() => {
  const el = document.querySelector('.subtitle');
  return getComputedStyle(el).opacity;
});
console.log('SUBTITLES_OFF_OPACITY=' + sub, parseFloat(sub) < 0.05 ? 'SUBS_OK' : 'SUBS_BAD');

// Subtitles on -> displays
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.ui.subtitlesOn = true;
  g.ui.say('visible now', 2);
});
await page.waitForTimeout(300);
const sub2 = await page.evaluate(() => document.querySelector('.subtitle')?.textContent);
console.log('SUBTITLES_ON_TEXT=' + JSON.stringify(sub2), sub2 === 'visible now' ? 'SUBS2_OK' : 'SUBS2_BAD');

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


