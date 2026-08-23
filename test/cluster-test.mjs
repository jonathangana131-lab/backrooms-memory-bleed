/* Verify note clusters generate with sequential texts. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
const found = await page.evaluate(async () => {
  const { generateLayout } = await import('/src/world/architect.ts');
  const seed = 777;
  for (let cx = -30; cx < 30; cx++) {
    for (let cz = -30; cz < 30; cz++) {
      const l = generateLayout(seed, cx, cz);
      if (l.notes.length >= 3) {
        return { at: [cx, cz], count: l.notes.length, first: l.notes[0].text.slice(0, 44), second: l.notes[1]?.text.slice(0, 40) };
      }
    }
  }
  return null;
});
console.log('CLUSTER', JSON.stringify(found));
console.log(found && found.count >= 3 ? 'CLUSTER_OK' : 'CLUSTER_FAIL');
await browser.close();


