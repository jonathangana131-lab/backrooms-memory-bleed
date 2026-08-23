/* Console quality audit during full playthrough. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const logs = [];
page.on('console', (m) => {
  const t = m.type(); const text = m.text();
  if (/ReadPixels|GPU stall|Babylon\.js v/.test(text)) return;
  logs.push('[' + t + '] ' + text.slice(0, 200));
});
page.on('pageerror', (e) => logs.push('[PAGEERROR] ' + String(e).slice(0, 250)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__BMB__, null, { timeout: 60000 });
await page.evaluate(() => window.__BMB__.startNew('audit'));
await page.waitForTimeout(4500);
await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.keyboard.up('KeyW');
await page.evaluate(() => { const g = window.__BMB__.game; g.pause(); });
await page.waitForTimeout(500);
await page.evaluate(() => { const g = window.__BMB__.game; g.resume(); });
await page.keyboard.press('KeyF');
await page.keyboard.press('Tab');
await page.waitForTimeout(900);
await page.keyboard.press('Tab');
await page.evaluate(() => { const g = window.__BMB__.game; g.pause(); g.resume(); });
await page.waitForTimeout(1500);
console.log('=== CONSOLE AUDIT ===');
for (const l of logs) console.log(l);
const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[PAGEERROR]'));
const warns = logs.filter((l) => l.startsWith('[warning]'));
console.log('SUMMARY errors=' + errors.length + ' warnings=' + warns.length + ' total=' + logs.length);
for (const e2 of errors.slice(0, 5)) console.log('ERR:', e2.slice(0, 180));
for (const w of [...new Set(warns)].slice(0, 5)) console.log('WARN:', w.slice(0, 180));
await browser.close();


