  // paper posters would read as bright desaturated patches against dark walls
  const paper = colorFrac(png, [168, 158, 138], 55);
  report.posters = {
    status: found.posterMeshCount > 0 && paper > 0.002 ? 'RENDERED'
      : found.posterMeshCount > 0 ? 'PARTIAL_RENDER' : 'NOT_VISIBLE',
    scan: found, paperPixelFrac: paper,
    wiringEvidence: 'gfx/posters-mesher.ts exists but src/world/mesher.ts never imports it and getPostersForChunk has zero call sites outside gfx/posters.ts itself (grep-verified) - no poster quads are emitted into chunks',
    note: 'scanned 10 chunks across two rows for /poster/i scene meshes; wall capture shows bare panel walls',
    shot: path.basename(file),
  };
} catch (e) {
  report.posters = { status: 'ERROR', error: String(e).slice(0, 300) };
}
saveJson('posters', report.posters);
console.log('posters:', report.posters.status);

// ---------- 5. EMERGENCY LIGHTS / BLACKOUT ----------------------------------------------

try {
  // natural-blackout watch while exploring (~18s of hops)
  let natural = null;
  for (let hop = 0; hop < 14; hop++) {
    await page.evaluate((h) => {
      const g = (window).__BMB__.game;
      g.player.teleport(10 + h * 9, ((h * 37) % 60) - 30, h);
    }, hop);
    await page.waitForTimeout(1300);
    const st = await page.evaluate(() => {
      const g = (window).__BMB__.game;
      return { t: +g.playtimeSec.toFixed(1), blackedOut: g.playtimeSec < g.blackoutUntil, until: g.blackoutUntil };
    });
    if (st.blackedOut) { natural = st; break; }
  }
  report.emergencyNaturalBlackout = natural;

  // reference frame, then force the same effect director blackoutPulse uses
  const preFile = await saveShot(page, 'preblackout');
  const preStats = stats(loadPng(preFile));
  await page.evaluate(() => {
    const g = (window).__BMB__.game;
    g.blackoutUntil = g.playtimeSec + 90;
  });
  await page.waitForTimeout(1000);
  const dom = await page.evaluate(() => {
    const g = (window).__BMB__.game;
    const rigMeshes = g.scene.meshes.filter((m) => /emergency/i.test(m.name)).length;
    return {
      blackoutActive: g.playtimeSec < g.blackoutUntil,
      emergencyRigMeshes: rigMeshes,
      emergencyDom: document.querySelectorAll('[class*="emergency"]').length,
    };
  });
  const file = await saveShot(page, 'blackout');
  const afterStats = stats(loadPng(file));
  const redPulse = colorFrac(loadPng(file), [180, 40, 30], 70) + colorFrac(loadPng(file), [255, 60, 40], 80);
  const sawPulse = dom.emergencyRigMeshes > 0 && redPulse > 0.001;
  report.emergencyLights = {
    status: sawPulse ? 'RENDERED' : dom.blackoutActive ? 'PARTIAL_RENDER' : 'NOT_VISIBLE',
    dom, meanLumaBefore: preStats.meanLuma, meanLumaAfter: afterStats.meanLuma,
    lumaDelta: +(afterStats.meanLuma - preStats.meanLuma).toFixed(2),
    redPulsePixelFrac: +redPulse.toFixed(5),
    wiringEvidence: 'fixture emissive cutoff + postfx blackout pulse ARE wired via game.ts blackoutUntil; EmergencyWiring (the adapter that constructs EmergencyLights pulsing units) has ZERO construction sites in game code (grep-verified)',
    note: natural
      ? 'natural blackout observed at t=' + natural.t + 's; pulse units did not mount'
      : 'no natural blackout during ~18s exploration; forced blackout dims the scene but no red pulsing emergency fixtures render',
    shot: path.basename(file),
  };
} catch (e) {
  report.emergencyLights = { status: 'ERROR', error: String(e).slice(0, 300) };
}
saveJson('blackout', report.emergencyLights);
console.log('emergencyLights:', report.emergencyLights.status);

// ---------- wrap up ----------------------------------------------------------------------

report.pageErrors = pageErrors;
console.log('');
console.log('==== WAVE B/C VISUAL REPORT ====');
for (const k of ['minimap', 'contactShadows', 'heatShimmer', 'posters', 'emergencyLights']) {
  console.log(k.padEnd(18), report[k] ? report[k].status : 'MISSING', report[k] && report[k].error ? '| ' + report[k].error : '');
}
fs.writeFileSync(path.join(SHOTS, 'wavebc-report.json'), JSON.stringify(report, null, 2));
console.log('json -> shots/wavebc-report.json');
await browser.close();



