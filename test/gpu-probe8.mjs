/* WORKING-NOTES HARNESS #8: system-removal matrix with VERIFICATION that
 * each knob is genuinely off before startNew. Captures full first error. */
import { chromium } from 'playwright-core';

const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL_ = process.env.GAME_URL || 'http://127.0.0.1:5178/';

async function variant(label, setupFn) {
  const browser = await chromium.launch({
    executablePath: EXEC, headless: true,
    args: ['--enable-unsafe-webgpu', '--enable-webgpu', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  let errCount = 0; let firstErr = '';
  page.on('console', (m) => {
    const t = m.text();
    if (/exceeds the maximum/.test(t)) { errCount++; if (!firstErr) firstErr = t.slice(0, 400); }
  });
  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (window).__BMB__, null, { timeout: 60000 });
  const state = await page.evaluate(setupFn);
  await page.evaluate(() => (window).__BMB__.startNew('probe8'));
  await page.waitForTimeout(9000);
  const after = await page.evaluate(() => {
    const s = (window).__BMB__.game.scene;
    return {
      lightsEnabled: s.lights.filter((l) => l.isEnabled()).length,
      effectLayers: s.effectLayers ? s.effectLayers.length : -1,
      pipelines: s.postProcessRenderPipelineManager && s.postProcessRenderPipelineManager.pipelines ? Object.keys(s.postProcessRenderPipelineManager.pipelines).length : -1,
      camPost: s.cameras[0] && s.cameras[0]._postProcesses ? s.cameras[0]._postProcesses.filter(Boolean).length : -1,
    };
  });
  console.log('VARIANT', label, 'setup=' + JSON.stringify(state), 'after=' + JSON.stringify(after), 'valErrors=' + errCount);
  if (errCount) console.log('   FIRST:', firstErr.slice(0, 250));
  await browser.close();
}

const keepTwo = `(function(){ const s=(window).__BMB__.game.scene;
  s.lights.forEach((l)=>l.setEnabled(l.getClassName().includes('Hemispheric')||l.getClassName().includes('Spot')));
  return {lightsEnabled: s.lights.filter((l)=>l.isEnabled()).length}; })()`;

await variant('control', `() => ({})`);
await variant('noglow_verified', `(function(){ const s=(window).__BMB__.game.scene;
  if (s.effectLayers) for (const l of s.effectLayers.slice()) l.dispose();
  return {effectLayers: s.effectLayers?s.effectLayers.length:-1}; })()`);
await variant('nopipe_verified', `(function(){ const g=(window).__BMB__.game, s=g.scene;
  if (g.postfx) try { g.postfx.dispose(); } catch(e) {}
  const mgr=s.postProcessRenderPipelineManager;
  if (mgr && mgr._pipelines) for (const k of Object.keys(mgr._pipelines)) mgr.detachPipeline(k);
  if (mgr && mgr.pipelines) for (const p of Object.values(mgr.pipelines)) try{p.dispose();}catch(e){}
  for (const cam of s.cameras) { try{ while(cam._postProcesses && cam._postProcesses.length) cam.removePostProcess(cam._postProcesses[0]); }catch(e){} }
  return {pipelines: mgr&&mgr.pipelines?Object.keys(mgr.pipelines).length:-1,
          camPost: s.cameras[0]&&s.cameras[0]._postProcesses? s.cameras[0]._postProcesses.filter(Boolean).length : -1}; })()`);
await variant('both_glow_pipe', `(function(){ const g=(window).__BMB__.game, s=g.scene;
  if (s.effectLayers) for (const l of s.effectLayers.slice()) l.dispose();
  if (g.postfx) try { g.postfx.dispose(); } catch(e) {}
  const mgr=s.postProcessRenderPipelineManager;
  if (mgr && mgr.pipelines) for (const p of Object.values(mgr.pipelines)) try{p.dispose();}catch(e){}
  for (const cam of s.cameras) { try{ while(cam._postProcesses && cam._postProcesses.length) cam.removePostProcess(cam._postProcesses[0]); }catch(e){} }
  return {effectLayers: s.effectLayers?s.effectLayers.length:-1}; })()`);
await variant('two_lights_only', `() => ${keepTwo}`);
await variant('two_lights_no_glow_no_pipe', `(function(){ const s=(window).__BMB__.game.scene;
  s.lights.forEach((l)=>l.setEnabled(l.getClassName().includes('Hemispheric')||l.getClassName().includes('Spot')));
  if (s.effectLayers) for (const l of s.effectLayers.slice()) l.dispose();
  const g=(window).__BMB__.game;
  if (g.postfx) try { g.postfx.dispose(); } catch(e) {}
  const mgr=s.postProcessRenderPipelineManager;
  if (mgr && mgr.pipelines) for (const p of Object.values(mgr.pipelines)) try{p.dispose();}catch(e){}
  for (const cam of s.cameras) { try{ while(cam._postProcesses && cam._postProcesses.length) cam.removePostProcess(cam._postProcesses[0]); }catch(e){} }
  return {ok:true}; })()`);
