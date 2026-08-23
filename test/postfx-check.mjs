/* Behavioral check for src/gfx/postfx.ts: drives PostFX against the live
   scene (adopting the LightingRig pipeline) and asserts all four effects. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const PORT = 5199;
const BASE = 'http://127.0.0.1:' + PORT;
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

let server = null;
try {
  await fetch(BASE + '/', { method: 'HEAD' });
  console.log('reusing dev server on', PORT);
} catch {
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await fetch(BASE + '/'); up = true; } catch {}
  }
  if (!up) throw new Error('vite did not start');
}

const browser = await chromium.launch({
  executablePath: EXEC,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],

(Showing lines 1-30 of 110. Use offset=31 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
const results = await page.evaluate(async () => {
  const g = (window).__BMB__.game;
  const out = {};
  const mod = await import('/src/gfx/postfx.ts');
  const fx = new mod.PostFX();
  fx.init(g.scene); // no explicit pipeline -> must auto-adopt LightingRig's
  const pipe = g.lighting && g.lighting['pipeline'];

  // --- film grain ---
  const grain = document.getElementById('bmb-grain-overlay');
  out.grainExists = !!grain;
  out.grainOpacity = grain ? parseFloat(getComputedStyle(grain).opacity) : -1;
  // confirm rAF actually runs in this headless page before judging the grain
  await page.evaluate(() => {}); // keep evaluate context warm
  const posA = grain ? grain.style.backgroundPosition : '';
  for (let i = 0; i < 10 && !out._rafWorks; i++) {
    out._rafWorks = await Promise.race([
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))),
      new Promise((r) => setTimeout(() => r(false), 1000)),
    ]);
    await new Promise((r) => setTimeout(r, 100));
    const p = grain ? grain.style.backgroundPosition : '';
    if (posA && p && p !== posA) { out.grainAnimates = true; break; }
    if (!posA && p) { out.grainAnimates = true; break; }
  }
  if (out.grainAnimates === undefined) {
    const posB = grain ? grain.style.backgroundPosition : '';
    out.grainAnimates = !!posA && posA !== posB;
  }


(Showing lines 44-73 of 131. Use offset=74 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
  out.abOk = out.abEnabled && out.abAmount > 0.01 && out.abAmount <= out.abCapPx * 1.001;
  fx.setAberration(0);
  fx.update(5);
  out.abOffOk = pipe.chromaticAberrationEnabled === false;

  // --- DOF hint ---
  fx.setBlackout(true);
  const dof = document.getElementById('bmb-dof-overlay');
  out.dofVisible = !!dof && getComputedStyle(dof).display !== 'none';
  out.dofBlur = dof ? getComputedStyle(dof).backdropFilter.includes('blur') : false;
  fx.setBlackout(false);
  out.dofHides = !dof || getComputedStyle(dof).display === 'none';

  fx.dispose();
  out.grainRemoved = !document.getElementById('bmb-grain-overlay');

(Showing lines 80-94 of 110. Use offset=95 to continue.)

  fx.dispose();
  out.grainRemoved = !document.getElementById('bmb-grain-overlay');
  return out;
});

console.log(JSON.stringify(results, null, 2));
const fails = Object.entries(results).filter(
  ([k, v]) => (k.endsWith('Ok') || k.endsWith('Exists') || k.endsWith('Animates') ||
    k.endsWith('Settles') || k.endsWith('Visible') || k.endsWith('Blur') ||
    k.endsWith('Hides') || k.endsWith('Enabled') || k.endsWith('Removed')) && v !== true,
);
// numeric sanity
if (Math.abs(results.grainOpacity - 0.04) > 0.005) fails.push(['grainOpacity', results.grainOpacity]);
if (fails.length) { console.error('FAIL:', fails.map((f) => f.join('=')).join(', ')); process.exitCode = 1; }
else console.log('postfx-check: PASS');

await browser.close();
if (server) server.kill();


