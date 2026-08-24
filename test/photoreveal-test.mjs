/**
 * Unit test for anomaly photography (src/gfx/photoreveal.ts, F41).
 * Standalone (no browser): transpiles the module (+ its deps) into a temp
 * dir and drives the pure reveal pipeline with injected captures.
 *
 * Acceptance:
 *   1. reveal pipeline — across 500 entity-present captures, reveals land
 *      at the seeded rate (REVEAL_RATE), and every silhouette is complete
 *   2. absent entities NEVER reveal (500 captures, all dark)
 *   3. determinism per frameHash+seed — identical descriptors develop
 *      deep-equal records; different seeds/frames differ somewhere
 *   4. gallery tier thresholds exact at every boundary, monotone, saturating
 *
 * Run: node test/photoreveal-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-photoreveal-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/gfx/photoreveal.ts', 'gfx/photoreveal.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const pr = await import(pathToFileURL(path.join(tmp, 'gfx', 'photoreveal.mjs')).href);
const { develop, buildGalleryModel, galleryTier, GALLERY_TIERS, REVEAL_RATE } = pr;

/* ------------------------------------------------------------------ */
/* 1. Reveal pipeline: seeded rate across 500 present-entity captures  */
/* ------------------------------------------------------------------ */
{
  const seed = 0xbeef01;
  let revealed = 0;
  let silhouettesComplete = true;
  const seenSilhouettes = new Set();
  for (let i = 0; i < 500; i++) {
    const rec = develop({ frameHash: (0x1000 + i * 7919) >>> 0, entityPresence: true, seed });
    if (rec.revealed) {
      revealed++;
      const s = rec.silhouette;
      if (
        !s ||
        !(s.heightM > 0) || !(s.widthM > 0) ||
        typeof s.headTiltRad !== 'number' ||
        !(s.limbCount >= 2) ||
        s.limbSplay < 0 || s.limbSplay > 1 ||
        s.edgeSoftness < 0 || s.edgeSoftness > 1
      ) {
        silhouettesComplete = false;
      } else {
        seenSilhouettes.add(JSON.stringify(s));
      }
    } else if (rec.silhouette !== null) {
      silhouettesComplete = false;
    }
  }
  const rate = revealed / 500;
  // binomial(500, 0.4): sigma ~0.022 — wide guard band, exact-rate equality
  // is NOT required, only that the seeded threshold tracks the design rate.
  check('reveal rate near REVEAL_RATE over 500 captures', rate > 0.3 && rate < 0.5,
    `rate=${rate} expected~${REVEAL_RATE}`);
  check('revealed records carry complete distinct silhouettes',
    silhouettesComplete && seenSilhouettes.size === revealed,
    `complete=${silhouettesComplete} distinct=${seenSilhouettes.size}/${revealed}`);
}

/* ------------------------------------------------------------------ */
/* 2. Absent entities never reveal                                     */
/* ------------------------------------------------------------------ */
{
  let leaks = 0;
  for (let i = 0; i < 500; i++) {
    const rec = develop({
      frameHash: (0x9000 + i * 104729) >>> 0,
      entityPresence: false,
      seed: (0x1234 + i) >>> 0,
    });
    if (rec.revealed || rec.silhouette !== null) leaks++;
  }
  check('no reveals when entity absent (500 captures)', leaks === 0, `leaks=${leaks}`);
}

/* ------------------------------------------------------------------ */
/* 3. Determinism per frameHash+seed                                   */
/* ------------------------------------------------------------------ */
{
  const cap = { frameHash: 0xc0ffee, entityPresence: true, seed: 77 };
  const a = JSON.stringify(develop(cap));
  const b = JSON.stringify(develop({ ...cap }));
  check('identical descriptor develops deep-equal record', a === b, `${a} vs ${b}`);

  let diffSeed = false;
  let diffFrame = false;
  const base = JSON.stringify(develop(cap));
  for (let d = 1; d <= 64 && (!diffSeed || !diffFrame); d++) {
    if (JSON.stringify(develop({ ...cap, seed: 77 + d })) !== base) diffSeed = true;
    if (JSON.stringify(develop({ ...cap, frameHash: 0xc0ffee + d })) !== base) diffFrame = true;
  }
  check('different seed changes development somewhere', diffSeed);
  check('different frameHash changes development somewhere', diffFrame);

  // call order independence: interleaved calls cannot cross-contaminate
  const c1 = develop(cap);
  for (let i = 0; i < 50; i++) develop({ frameHash: i, entityPresence: true, seed: i * 31 });
  const c2 = develop(cap);
  check('development immune to interleaved calls', JSON.stringify(c1) === JSON.stringify(c2));
}

/* ------------------------------------------------------------------ */
/* 4. Gallery tier thresholds                                          */
/* ------------------------------------------------------------------ */
{
  const th = GALLERY_TIERS.map((t) => t.minReveals);
  const ascending = th.every((v, i) => i === 0 || v > th[i - 1]);
  check('tier thresholds strictly ascending from 0', ascending && th[0] === 0, JSON.stringify(th));

  // exact promotion: count just below a threshold stays in the lower tier,
  // count exactly at a threshold reaches the higher tier
  let exact = true;
  for (let i = 1; i < th.length; i++) {
    if (galleryTier(th[i] - 1) !== i - 1) exact = false;
    if (galleryTier(th[i]) !== i) exact = false;
  }
  check('tier promotions exact at each boundary', exact);

  check('tier 0 anchored at zero reveals', galleryTier(0) === 0);
  check('tiers saturate beyond last threshold', galleryTier(th[th.length - 1] + 500) === GALLERY_TIERS.length - 1);

  let mono = true;
  let prev = -1;
  for (let c = 0; c <= 40; c++) {
    const t = galleryTier(c);
    if (t < prev) mono = false;
    prev = t;
  }
  check('tier monotone non-decreasing in reveal count', mono);

  const model = buildGalleryModel([
    { frameHash: 1, seed: 5, revealed: true },
    { frameHash: 2, seed: 5, revealed: true },
    { frameHash: 3, seed: 5, revealed: true },
    { frameHash: 4, seed: 5, revealed: false },
  ]);
  check('gallery model counts reveals and resolves tier from them',
    model.revealedCount === 3 && model.tierIndex === 1 &&
    model.photos.length === 4 && model.photos[3].revealed === false);
  const modelAgain = buildGalleryModel(model.photos);
  check('gallery model pure on re-derivation',
    JSON.stringify(buildGalleryModel(JSON.parse(JSON.stringify(model.photos)))) ===
    JSON.stringify({ photos: model.photos, revealedCount: 3, tierIndex: 1 }));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? 'PHOTOREVEAL_PASS' : `PHOTOREVEAL_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
