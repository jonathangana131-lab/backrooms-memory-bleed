/* Settings panel dismissal: BACK button + Escape must return to the title
 * screen from the shared #settings-panel (defect: panel had only RESETs). */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 200)));
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:4178/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 120000 });

const titleBtnVisible = () =>
  page.evaluate(() => {
    const btn = [...document.querySelectorAll('.title-screen .btn')]
      .find((b) => b.textContent === 'NEW EXPEDITION');
    return !!btn && getComputedStyle(btn).display !== 'none';
  });

let fails = 0;
const check = (name, ok) => { console.log(name, ok ? 'OK' : 'FAIL'); if (!ok) fails++; };

check('TITLE_VISIBLE_PRE', await titleBtnVisible());

// open settings from the title screen
await page.click('.title-screen .menu-col button:has-text("SETTINGS")');
await page.waitForTimeout(200);
const panelShown = await page.evaluate(() => {
  const p = document.getElementById('settings-panel');
  return !!p && p.style.display === 'block';
});
check('PANEL_OPENS', panelShown);
const hasBack = await page.evaluate(() => {
  const p = document.getElementById('settings-panel');
  const b = [...p.querySelectorAll('button')].find((x) => x.textContent === 'BACK');
  return !!b;
});
check('BACK_BUTTON_PRESENT', hasBack);

// BACK returns to the title screen (panel hidden again)
await page.click('#settings-panel button:has-text("BACK")');
await page.waitForTimeout(200);
const closedByBack = await page.evaluate(() => {
  const p = document.getElementById('settings-panel');
  return !!p && p.style.display === 'none';
});
check('BACK_CLOSES_PANEL', closedByBack && await titleBtnVisible());

// reopen, Escape must dismiss too
await page.click('.title-screen .menu-col button:has-text("SETTINGS")');
await page.waitForTimeout(150);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const closedByEsc = await page.evaluate(() => {
  const p = document.getElementById('settings-panel');
  return !!p && p.style.display === 'none';
});
check('ESCAPE_CLOSES_PANEL', closedByEsc && await titleBtnVisible());

await browser.close();
if (fails > 0) { console.error('SETTINGS_DISMISS_FAIL=' + fails); process.exit(1); }
console.log('SETTINGS_DISMISS_PASS');
