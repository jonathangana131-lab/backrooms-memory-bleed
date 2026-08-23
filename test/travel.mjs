/* Long-run procedural traversal stress test.
 * Travels > 2km in hops, monitors chunk lifecycle, memory, FPS, determinism. */
import { chromium } from 'playwright-core';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const HOPS = parseInt(process.env.HOPS || '70', 10);
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e).slice(0, 200)); console.log('[PAGEERROR]', String(e).slice(0, 200)); });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('stress'));
await page.waitForTimeout(2500);

// remember a fingerprint of the spawn area for the determinism check
const fingerprint = () => page.evaluate(() => {
  const g = (window).__BMB__.game;
  const l = g.chunks.layoutAt(0, 0);
  let h = 0;
  if (l) {
    for (let i = 0; i < l.hEdges.length; i++) h = ((h * 31) + l.hEdges[i]) | 0;
    for (let i = 0; i < l.vEdges.length; i++) h = ((h * 31) + l.vEdges[i]) | 0;
  }
  const m = g.mem.sampleAt(1, 1);
  return { layoutHash: h | 0, memKind: m.kind, memI: Math.round(m.intensity * 1000) };
});
const fpBefore = await fingerprint();

const samples = [];
for (let hop = 0; hop < HOPS; hop++) {
  // travel east-northeast with slight sine weave
  await page.evaluate((hop) => {
    const g = (window).__BMB__.game;
    const t = hop * 38;
    g.player.teleport(8 + t, Math.sin(hop * 0.9) * 120, 0.3);
  }, hop);
  await page.waitForTimeout(900); // allow budgeted builds
  const s = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    const perf = performance.memory ? performance.memory.usedJSHeapSize : null;
    return {
      hopChunks: g.chunks.loadedCount,
      built: g.chunks.totalBuilt,
      act: g.scene.getActiveMeshes().length,
      fps: Math.round(g.engine.getFps()),
      heapMB: perf ? Math.round(perf / 1048576) : null,
      x: Math.round(g.player.body.x),
    };
  });
  samples.push(s);
  if (hop % 10 === 0 || hop === HOPS - 1) console.log('hop', hop, JSON.stringify(s));
}

// determinism: return to origin, compare chunk (0,0) layout
await page.evaluate(() => {
  const g = (window).__BMB__.game;
  g.player.teleport(1.25, 1.25, 0);
});
await page.waitForTimeout(2500);
const fpAfter = await fingerprint();
console.log('FP_BEFORE', JSON.stringify(fpBefore));
console.log('FP_AFTER ', JSON.stringify(fpAfter));

const first = samples[0], last = samples[samples.length - 1];
const maxChunks = Math.max(...samples.map((s) => s.hopChunks));
const maxHeap = Math.max(...samples.map((s) => s.heapMB ?? 0));
const minFps = Math.min(...samples.map((s) => s.fps));
console.log('SUMMARY', JSON.stringify({
  distanceM: HOPS * 38,
  builtTotal: last.built,
  maxChunksLoaded: maxChunks,
  heapGrowthMB: (last.heapMB ?? 0) - (first.heapMB ?? 0),
  maxHeapMB: maxHeap,
  minFps: minFps,
  pageErrors: errors.length,
}));
const pass =
  maxChunks <= 40 &&                       // bounded working set
  errors.length === 0 &&
  last.built >= HOPS * 2;                  // kept generating
// structure must be ETERNAL (seed+coords); memory dressing may legally drift
const structureStable = fpBefore.layoutHash === fpAfter.layoutHash;
const memDrift = { before: fpBefore.memKind + '/' + fpBefore.memI, after: fpAfter.memKind + '/' + fpAfter.memI };
console.log('STRUCTURE_STABLE=' + structureStable, 'MEM_DRIFT', JSON.stringify(memDrift));
console.log(pass && structureStable ? 'TRAVEL_TEST_PASS' : 'TRAVEL_TEST_FAIL');
await browser.close();


