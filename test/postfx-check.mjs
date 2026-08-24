/**
 * PostFX integration check against the live dev page: grain overlay
 * presence/animation/opacity, chromatic aberration driven through the
 * LightingRig pipeline, blackout DOF hint, dispose cleanup.
 *
 * Rebuilt (recovery truncation): the harvested copy lost its launch preamble,
 * referenced Node-side `page` from inside a browser evaluate, lost the
 * aberration section to [unrecovered line] markers, and duplicated its
 * dispose block. The aberration section is rebuilt on the current PostFX API
 * (setAberration() target smoothed in update(); offset capped at
 * MAX_ABERRATION_OFFSET = 0.002 of render width). Uses the already-running
 * dev server; never starts its own.
 *
 *   node test/postfx-check.mjs   (dev server on 127.0.0.1:5178)
 */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
page.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 250)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
await page.evaluate(() => (window).__BMB__.startNew('pfx'));
await page.waitForTimeout(3500);

const results = await page.evaluate(async () => {
  const g = (window).__BMB__.game;
  const out = {};
  // adapted: the running game owns its own PostFX grain under the same
  // overlay id, so disposal is judged by element COUNT vs the pre-init
  // baseline rather than bare getElementById
  const grainsBaseline = document.querySelectorAll('#bmb-grain-overlay').length;
  const mod = await import('/src/gfx/postfx.ts');
  const fx = new mod.PostFX();
  fx.init(g.scene); // no explicit pipeline -> must auto-adopt LightingRig's
  const pipe = (g.lighting && g.lighting['pipeline']) || {};

  // --- film grain ---
  const grain = document.getElementById('bmb-grain-overlay');
  out.grainExists = !!grain;
  out.grainOpacity = grain ? parseFloat(getComputedStyle(grain).opacity) : -1;
  // grain tile repositions every other frame via FilmGrain's rAF loop
  out.grainAnimates = await new Promise((res) => {
    if (!grain) { res(false); return; }
    const p0 = grain.style.backgroundPosition;
    let n = 0;
    const tick = () => {
      const p = grain.style.backgroundPosition;
      if (p && p !== p0) { res(true); return; }
      if (++n > 90) res(false);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // --- chromatic aberration --- (rebuilt: section unrecovered at harvest)
  fx.setAberration(1);
  for (let i = 0; i < 90; i++) fx.update(1 / 60);
  out.abEnabled = pipe.chromaticAberrationEnabled === true;
  out.abAmount = pipe.chromaticAberration ? pipe.chromaticAberration.aberrationAmount : -1;
  out.abCapPx = 0.002 * g.scene.getEngine().getRenderWidth();

  out.abOk = out.abEnabled && out.abAmount > 0.01 && out.abAmount <= out.abCapPx * 1.001;
  fx.setAberration(0);
  // adapted: settle loop — a single update(5) clamps dt to 0.1 and cannot
  // drive the smoothed offset under the enable threshold by itself
  for (let i = 0; i < 40; i++) fx.update(1 / 30);
  out.abOffOk = pipe.chromaticAberrationEnabled === false;

  // --- DOF hint ---
  fx.setBlackout(true);
  const dof = document.getElementById('bmb-dof-overlay');
  out.dofVisible = !!dof && getComputedStyle(dof).display !== 'none';
  out.dofBlur = dof ? getComputedStyle(dof).backdropFilter.includes('blur') : false;
  fx.setBlackout(false);
  out.dofHides = !dof || getComputedStyle(dof).display === 'none';

  // deduped: the harvest copy disposed twice
  fx.dispose();
  out.grainRemoved =
    document.querySelectorAll('#bmb-grain-overlay').length === grainsBaseline;
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
