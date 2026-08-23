/* Boot the game in headless Chromium and confirm zero console errors over 10s of play. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('console', (m) => {
  const t = m.type(); const text = m.text();
  if (/ReadPixels|GPU stall|Babylon\.js v/.test(text)) return;
  if (t === 'error') errors.push('[error] ' + text.slice(0, 200));
});
page.on('pageerror', (e) => errors.push('[PAGEERROR] ' + String(e).slice(0, 250)));
try {
  await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction(() => window.__BMB__, null, { timeout: 60000 });
  await page.evaluate(() => window.__BMB__.startNew('audio-check'));
  // ~10 seconds of movement / interaction
  await page.waitForTimeout(3000);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(1000);
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(2000);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  const audioState = await page.evaluate(() => {
    const a = window.__BMB__.game.audio;
    return { started: a.started, hasCtx: !!a.ctx };
  }).catch(() => ({ started: false, hasCtx: false }));
  console.log('AUDIO STATE ' + JSON.stringify(audioState));
} finally {
  await browser.close();
}
console.log('=== AUDIO CHECK ===');
for (const e of errors) console.log(e);
if (errors.length === 0) console.log('PASS: no console errors during 10s gameplay');
else { console.log('FAIL: ' + errors.length + ' error(s)'); process.exit(1); }


