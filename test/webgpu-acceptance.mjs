/* ACCEPTANCE CHECK: WebGPU repro — boot, NEW EXPEDITION, flashlight ON,
 * measure center-crop (flashlight cone) brightness. Pass >= 15/255.
 * Also records validation-error count and dark baseline before F press. */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
let errCount = 0;
page.on('console', (m) => { if (/exceeds the maximum/.test(m.text())) errCount++; });
await page.goto(process.env.GAME_URL || 'http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

const engineKind = await page.evaluate(() => {
  const g = (window).__BMB__.game;
  return { isWebGPU: !!g.engine.isWebGPU };
});
console.log('ENGINE', JSON.stringify(engineKind));

await page.evaluate(() => (window).__BMB__.startNew('accept'));
// stream chunks and settle
await page.waitForTimeout(15000);

async function centerBrightness(label) {
  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  let sum = 0, n = 0;
  for (let y = Math.floor(png.height * .35); y < png.height * .65; y += 2) {
    for (let x = Math.floor(png.width * .35); x < png.width * .65; x += 2) {
      const i = (png.width * y + x) << 2;
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n++;
    }
  }
  const avg = sum / n;
  console.log('CENTER_BRIGHTNESS', label, avg.toFixed(2));
  return avg;
}

const darkBaseline = await centerBrightness('dark_baseline_flash_off');

// own + switch on flashlight through the real toggle path where possible
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.flashlight.has = true; g.flashlight.battery = 1;
});
await page.keyboard.press('KeyF');
await page.waitForTimeout(500);
const torchState = await page.evaluate(() => {
  const f = (window).__BMB__.game.flashlight;
  if (!f.on) { f.on = true; }
  return { on: f.on, intensity: f.light.intensity, battery: +f.battery.toFixed(2),
    maxSimulLightsClamped: (window).__BMB__.game.scene.materials
      .filter((m) => m.maxSimultaneousLights !== undefined)
      .map((m) => m.maxSimultaneousLights)
      .reduce((acc, v) => acc.add(v), new Set()) ? [...new Set((window).__BMB__.game.scene.materials.map((m) => m.maxSimultaneousLights).filter((v) => v !== undefined))] : [] };
});
console.log('TORCH', JSON.stringify(torchState));
await page.waitForTimeout(4000);
const lit = await centerBrightness('flash_on');

const pass = lit >= 15 && lit > darkBaseline * 2 && errCount === 0;
console.log('VALIDATION_ERRORS=' + errCount);
console.log('RESULT dark=' + darkBaseline.toFixed(2), 'lit=' + lit.toFixed(2));
console.log(pass ? 'WEBGPU_ACCEPTANCE_PASS' : 'WEBGPU_ACCEPTANCE_FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
