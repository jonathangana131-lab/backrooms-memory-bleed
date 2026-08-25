/* WORKING-NOTES HARNESS #7: which light-type combos stay under the WebGPU
 * UBO limit? Boot-time one-shot enable lists, count validation errors. */
import { chromium } from 'playwright-core';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.GAME_URL || 'http://127.0.0.1:5178/';

async function variant(label, picker) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  let errCount = 0;
  page.on('console', (m) => { if (/exceeds the maximum/.test(m.text())) errCount++; });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  await page.evaluate(picker.toString().length ? picker : null); // placeholder
  await browser.close();
}

// simpler: inline pickers as strings
async function variant2(label, expr) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  let errCount = 0;
  page.on('console', (m) => { if (/exceeds the maximum/.test(m.text())) errCount++; });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  await page.evaluate((expr) => {
    const s = (window).__BMB__.game.scene;
    // eslint-disable-next-line no-eval
    const keepFn = eval(expr);
    s.lights.forEach((l) => l.setEnabled(keepFn(l)));
  }, expr);
  await page.evaluate(() => (window).__BMB__.startNew('probe7'));
  await page.waitForTimeout(9000);
  const counts = await page.evaluate(() => {
    const s = (window).__BMB__.game.scene;
    return { total: s.lights.length, enabled: s.lights.filter((l) => l.isEnabled()).length };
  });
  console.log('VARIANT', label, JSON.stringify(counts), 'valErrors=' + errCount);
  await browser.close();
}

await variant2('hemi_only', '(l) => l.getClassName().includes("Hemispheric")');
await variant2('hemi+spot', '(l) => l.getClassName().includes("Hemispheric") || l.getClassName().includes("Spot")');
await variant2('hemi+spot+1pt', '(l, i) => l.getClassName().includes("Hemispheric") || l.getClassName().includes("Spot") || l.name === "pl0"');
await variant2('hemi+1pt', '(l) => l.getClassName().includes("Hemispheric") || l.name === "pl0"');
await variant2('spot_only', '(l) => l.getClassName().includes("Spot")');
await variant2('none', '() => false');
