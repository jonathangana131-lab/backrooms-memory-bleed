/* Definitive puddle mesh diagnosis. */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 250)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });

// teleport directly INTO a known-wet zone BEFORE startNew so chunks build there
const diag = await page.evaluate(async () => {
  const g = (window).__BMB__.game;
  // find wet spot
  let spot = null;
  for (let x = -400; x < 400 && !spot; x += 30) {
    for (let z = -400; z < 400; z += 30) {
      if (Math.hypot(x, z) < 60) continue;
      const m = g.mem.sampleAt(x, z);
      if (m.kind === 3 || m.kind === 6) { spot = { x, z }; break; }
    }
  }
  if (!spot) return { err: 'no wet spot' };
  g.player.teleport(spot.x, spot.z, 1);
  for (let i = 0; i < 8; i++) g.chunks.update(spot.x, spot.z);
  const info = { spot };
  // count puddle meshes and their visibility state
  let pudMeshes = 0, pudIndices = 0, enabled = 0;
  const C3 = Object.getPrototypeOf(g.scene.clearColor).constructor;
  void C3;
  for (const m of g.scene.meshes) {
    if (!m.name.startsWith('puddles')) continue;
    pudMeshes++;
    pudIndices += m.getTotalIndices();
    if (m.isEnabled() && m.isVisible) enabled++;
    // force bright emissive white
    const mat = m.material;
    mat.emissiveColor = new (mat.diffuseColor.constructor)(5, 5, 5);
    mat.disableLighting = true;
  }
  info.pudMeshes = pudMeshes; info.pudIndices = pudIndices; info.enabled = enabled;
  return info;
});
console.log('DIAG', JSON.stringify(diag));
await page.waitForTimeout(800);
await page.screenshot({ path: 'shots/pud-white.png' });
await browser.close();


