import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
for (const vp of [[480, 270], [640, 400]]) {
  const t0 = Date.now();
  try {
    const browser = await chromium.launch({ executablePath: EXEC, headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: vp[0], height: vp[1] } });
    await page.goto('http://127.0.0.1:5178/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(vp.join('x'), 'ok', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    await browser.close();
  } catch (e) {
    console.log(vp.join('x'), 'FAILED', ((Date.now() - t0) / 1000).toFixed(1) + 's', String(e).slice(0, 200));
  }
}
