/* Content volume + determinism gate for the authored pools:
 *   - 35 standalone notes per wave file (105 total), 14 story arcs of 3-5 beats
 *   - 40 graffiti wall texts, 30 whisper fragments
 *   - no duplicate texts anywhere across the pools
 *   - tag validity (districts 0-4, memKinds known, minStage 0-4)
 *   - deterministic hash selection: same seed -> same picks, stage tags gate
 * Run: node test/content-volume.mjs  (needs the dev server on :5178)
 */
import { chromium } from 'playwright-core';
const EXEC = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'ok - ' : 'FAIL - ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: EXEC, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.on('pageerror', (e) => check('no page errors while loading pools', false, String(e).slice(0, 120)));
await page.goto('http://127.0.0.1:5178/', { waitUntil: 'networkidle' });

const data = await page.evaluate(async () => {
  const [w1, w2, w3, cl, gr, wh, tg] = await Promise.all([
    import('/src/content/notes-wave1.ts'),
    import('/src/content/notes-wave2.ts'),
    import('/src/content/notes-wave3.ts'),
    import('/src/content/clusters.ts'),
    import('/src/content/graffiti-pool.ts'),
    import('/src/content/whispers.ts'),
    import('/src/content/tags.ts'),
  ]);
  return {
    wave1: w1.NOTE_WAVE1, wave2: w2.NOTE_WAVE2, wave3: w3.NOTE_WAVE3_POOL,
    arcs: cl.STORY_ARCS, graffiti: gr.GRAFFITI_POOL, whispers: wh.WHISPERS,
    validKinds: tg.VALID_MEM_KIND_TAGS,
  };
});

// ---- counts ---------------------------------------------------------------
check('wave 1 holds exactly 35 standalone notes', data.wave1.length === 35, String(data.wave1.length));
check('wave 2 holds exactly 35 standalone notes', data.wave2.length === 35, String(data.wave2.length));
check('wave 3 holds exactly 35 standalone notes', data.wave3.length === 35, String(data.wave3.length));
check('standalone waves total 105 notes',
  data.wave1.length + data.wave2.length + data.wave3.length === 105);
check('14 cluster story arcs authored', data.arcs.length === 14, String(data.arcs.length));
check('every arc carries 3-5 beats',
  data.arcs.every((a) => a.beats.length >= 3 && a.beats.length <= 5),
  JSON.stringify(data.arcs.map((a) => a.beats.length)));
check('arc ids are unique kebab-case strings',
  new Set(data.arcs.map((a) => a.id)).size === data.arcs.length &&
    data.arcs.every((a) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.id)));
check('graffiti pool holds 40 wall texts', data.graffiti.length === 40, String(data.graffiti.length));
check('whisper pool holds 30 fragments', data.whispers.length === 30, String(data.whispers.length));

// ---- tag validity ----------------------------------------------------------
const allTagged = [
  ...data.wave1, ...data.wave2, ...data.wave3,
  ...data.arcs.flatMap((a) => a.beats),
  ...data.graffiti,
];
const badDistrict = allTagged.filter((e) => e.districts &&
  !e.districts.every((d) => Number.isInteger(d) && d >= 0 && d <= 4));
const badKind = allTagged.filter((e) => e.memKinds &&
  !e.memKinds.every((k) => data.validKinds.includes(k)));
const badStage = allTagged.filter((e) => e.minStage !== undefined &&
  !(Number.isInteger(e.minStage) && e.minStage >= 0 && e.minStage <= 4));
check('districts all in range 0-4', badDistrict.length === 0,
  JSON.stringify(badDistrict.slice(0, 2).map((e) => e.districts)));
check('memKinds all known tags', badKind.length === 0,
  JSON.stringify(badKind.slice(0, 2).map((e) => e.memKinds)));
check('minStage all integers 0-4', badStage.length === 0,
  JSON.stringify(badStage.slice(0, 2).map((e) => e.minStage)));

// ---- uniqueness ------------------------------------------------------------
const standaloneTexts = [...data.wave1, ...data.wave2, ...data.wave3].map((e) => e.text);
const arcTexts = data.arcs.flatMap((a) => a.beats.map((b) => b.text));
const graffitiTexts = data.graffiti.map((g) => g.text);
const everything = [...standaloneTexts, ...arcTexts, ...graffitiTexts, ...data.whispers];
const dupes = everything.filter((t, i) => everything.indexOf(t) !== i);
check('no duplicate texts across all pools (' + everything.length + ' texts)',
  dupes.length === 0, JSON.stringify(dupes.slice(0, 2)));
check('every text is a non-empty single-line string',
  everything.every((t) => typeof t === 'string' && t.trim().length > 10 && t.indexOf('\n') === -1));

// ---- deterministic selection -----------------------------------------------
const det = await page.evaluate(async () => {
  const [tg, ar] = await Promise.all([
    import('/src/content/tags.ts'),
    import('/src/world/architect.ts'),
  ]);
  const pool = ar.NOTE_TEXTS.map((text) => ({ text }));
  const ctx = { district: 2, memKind: 5 /* MALL */, stage: 1 };
  const h = 0xbeefcafe;
  const a = tg.pickEligible(pool, ctx, h);
  const b = tg.pickEligible(pool, ctx, h);
  const seed = 4242;
  const la = ar.generateLayout(seed, 7, -3, undefined, { stage: 2 });
  const lb = ar.generateLayout(seed, 7, -3, undefined, { stage: 2 });
  const noteTexts = (l) => l.notes.map((n) => n.text).sort();
  const grafTexts = (l) => l.graffiti.map((g) => g.text).sort();
  // stage gating: scan chunks for an ambient note that differs between stages
  let gated = null;
  for (let cx = -20; cx <= 20 && !gated; cx++) {
    for (let cz = -20; cz <= 20; cz++) {
      const s0 = ar.generateLayout(seed, cx, cz, undefined, { stage: 0 });
      const s3 = ar.generateLayout(seed, cx, cz, undefined, { stage: 3 });
      if (noteTexts(s0).join('|') !== noteTexts(s3).join('|')) { gated = { cx, cz }; break; }
    }
  }
  return {
    samePick: !!a && !!b && a.text === b.text,
    sameLayout: JSON.stringify(noteTexts(la)) === JSON.stringify(noteTexts(lb)) &&
      JSON.stringify(grafTexts(la)) === JSON.stringify(grafTexts(lb)),
    stageGatedFound: gated,
  };
});
check('pickEligible returns the same entry for the same hash', det.samePick);
check('generateLayout is stable for the same seed and stage', det.sameLayout);
check('stage tags change what surfaces between stage 0 and stage 3',
  det.stageGatedFound !== null, JSON.stringify(det.stageGatedFound));

console.log(failures === 0 ? 'CONTENT_VOLUME_PASS' : 'CONTENT_VOLUME_FAIL');
await browser.close();
process.exit(failures === 0 ? 0 : 1);
