/**
 * Definitive puddle mesh diagnosis.
 *
 * Premise (corrected): architect.generatePuddles only runs for chunks whose
 * LAYOUT memKind is TRANSIT or HOSPITAL, and generateLayout samples that
 * memKind once at the CHUNK CENTER ((cx+0.5)*CHUNK_SIZE, ...) — not at an
 * arbitrary point inside the chunk. The previous probe picked any wet-field
 * sample far from spawn, which can sit in a chunk whose center reads dry:
 * pudMeshes:0 there is correct generation, not lost geometry.
 *
 * This probe therefore scans CHUNK CENTERS around spawn, teleports into the
 * first chunk whose center field reads TRANSIT/HOSPITAL, then asserts
 * puddle meshes exist against both authoritative sources: the built
 * layout's puddles array and the scene's 'puddles_*' meshes.
 */
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
// Start a run through the real title-screen path; the render loop must be
// stepping or chunk builds never complete.
await page.evaluate(() => document.querySelector('.title-screen .btn.primary')?.click());
await page.waitForTimeout(8000);

// MemoryKind values that make generatePuddles fire (architect.ts).
const WET_KINDS = [3, 6]; // HOSPITAL, TRANSIT
const CHUNK_SIZE = 30;

// Scan CHUNK CENTERS so the sampled kind matches what generateLayout saw,
// then teleport into the first wet-center chunk found.
const spot = await page.evaluate(({ WET_KINDS, CHUNK_SIZE }) => {
  const g = (window).__BMB__.game;
  let found = null;
  outer:
  for (let r = 2; r < 14; r++) {
    for (let cx = -r; cx <= r; cx++) {
      for (let cz = -r; cz <= r; cz++) {
        if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue; // ring only
        const wx = (cx + 0.5) * CHUNK_SIZE, wz = (cz + 0.5) * CHUNK_SIZE;
        const m = g.mem.sampleAt(wx, wz);
        if (WET_KINDS.includes(m.kind)) { found = { cx, cz, x: wx, z: wz, kind: m.kind }; break outer; }
      }
    }
  }
  if (!found) return null;
  g.player.teleport(found.x, found.z, 1);
  for (let i = 0; i < 8; i++) g.chunks.update(found.x, found.z);
  return found;
}, { WET_KINDS, CHUNK_SIZE });
console.log('SPOT', JSON.stringify(spot));

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}
check('probe found a wet-center chunk', !!spot, 'none within 13 rings');

if (spot) {
  // Chunk meshing finishes asynchronously (buildFromLayout spans frames), so
  // poll until the target chunk's layout is registered before counting.
  await page.waitForFunction(({ cx, cz }) =>
    (window).__BMB__.game.chunks.layoutAt(cx, cz) != null,
  { cx: spot.cx, cz: spot.cz }, { timeout: 30000 }).catch(() => {});

  const diag = await page.evaluate(({ WET_KINDS, cx, cz }) => {
    const g = (window).__BMB__.game;
    const info = {};
    // Authoritative source 1: the built layout itself.
    const layout = g.chunks.layoutAt(cx, cz);
    info.layoutMemKind = layout ? layout.memKind : null;
    info.layoutPuddles = layout ? layout.puddles.length : null;
    // Authoritative source 2: scene meshes.
    let pudMeshes = 0, pudIndices = 0, enabled = 0;
    for (const m of g.scene.meshes) {
      if (!m.name.startsWith('puddles')) continue;
      pudMeshes++;
      pudIndices += m.getTotalIndices();
      if (m.isEnabled() && m.isVisible) enabled++;
      // force bright emissive white for the evidence shot
      const mat = m.material;
      mat.emissiveColor = new (mat.diffuseColor.constructor)(5, 5, 5);
      mat.disableLighting = true;
    }
    info.pudMeshes = pudMeshes; info.pudIndices = pudIndices; info.enabled = enabled;
    return info;
  }, { WET_KINDS, cx: spot.cx, cz: spot.cz });
  console.log('DIAG', JSON.stringify(diag));

  check('layout memKind is wet (TRANSIT/HOSPITAL)', WET_KINDS.includes(diag.layoutMemKind),
    'kind=' + diag.layoutMemKind);
  check('layout generated puddles at this chunk', diag.layoutPuddles > 0,
    'count=' + diag.layoutPuddles);
  check('puddle meshes exist in scene', diag.pudMeshes > 0, 'meshes=' + diag.pudMeshes);
  check('puddle meshes carry geometry', diag.pudIndices > 0, 'indices=' + diag.pudIndices);
  check('puddle meshes are enabled and visible', diag.enabled > 0, 'enabled=' + diag.enabled);

  await page.waitForTimeout(800);
  await page.screenshot({ path: 'shots/pud-white.png' });
}
await browser.close();
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
