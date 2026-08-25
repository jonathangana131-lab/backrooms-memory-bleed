/* WORKING-NOTES HARNESS #6: track enabled-light counts across the
 * startNew boundary under both enforcement modes, and correlate with
 * validation-error onset. */
import { chromium } from 'playwright-core';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.GAME_URL || 'http://127.0.0.1:5178/';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
let errCount = 0;
page.on('console', (m) => {
  const t = m.text();
  if (/exceeds the maximum/.test(t)) { errCount++; }
});
await page.goto(URL_, { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

// install continuous cap like probe5, plus instrumentation
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  const s = g.scene;
  window.__capLog = [];
  const rank = (l) => l.getClassName().includes('Hemispheric') ? 0 : (l.getClassName().includes('Spot') ? 1 : 2);
  const apply = () => {
    const ls = [...s.lights];
    ls.sort((a, b) => rank(a) - rank(b)).forEach((l, i) => l.setEnabled(i < 3));
    window.__capLog.push({ t: performance.now() | 0, total: ls.length, enabled: ls.filter((l) => l.isEnabled()).length });
  };
  apply();
  s.onBeforeRenderObservable.add(apply);
});

const c0 = await page.evaluate(() => ({
  total: (window).__BMB__.game.scene.lights.length,
  enabled: (window).__BMB__.game.scene.lights.filter((l) => l.isEnabled()).length,
}));
console.log('BEFORE_START', JSON.stringify(c0));

await page.evaluate(() => (window).__BMB__.startNew('probe6'));
await page.waitForTimeout(8000);
const c1 = await page.evaluate(() => ({
  total: (window).__BMB__.game.scene.lights.length,
  enabled: (window).__BMB__.game.scene.lights.filter((l) => l.isEnabled()).length,
  logHead: (window).__capLog.slice(0, 3),
  logTail: (window).__capLog.slice(-3),
  logMaxEnabled: Math.max(...(window).__capLog.map((e) => e.enabled)),
}));
console.log('AFTER_START', JSON.stringify(c1));
console.log('VALIDATION_ERRORS=' + errCount);

// same instrumentation WITHOUT any cap (control)
const page2 = await browser.newPage({ viewport: { width: 640, height: 360 } });
page2.on('console', (m) => { if (/exceeds the maximum/.test(m.text())) errs.push(1); });
await page2.goto(URL_, { waitUntil: 'networkidle' });
await page2.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page2.evaluate(() => (window).__BMB__.startNew('probe6b'));
await page.waitForTimeout(8000);
const c2 = await page2.evaluate(() => {
  const s = (window).__BMB__.game.scene;
  return { total: s.lights.length, enabled: s.lights.filter((l) => l.isEnabled()).length };
});
console.log('CONTROL_AFTER_START', JSON.stringify(c2));
console.log('CONTROL_ERRORS=' + errs.length);
await browser.close();
