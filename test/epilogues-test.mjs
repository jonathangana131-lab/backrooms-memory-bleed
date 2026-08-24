/**
 * Contamination epilogue tests (F82) - pure Node, no renderer.
 * Verifies the F82 acceptance proof:
 *   1. band mapping exact - exposureBand matches the documented half-open
 *      bands over a fine boundary sweep (edges belong to the opening
 *      band), clamps out-of-range values, and is a pure step function
 *   2. within-band assembly deterministic - same (band, seed) yields
 *      byte-identical text regardless of the exact E inside the band;
 *      replays are byte-identical; seeds decorrelate
 *   3. fragment pools never leak across bands - every assembled title and
 *      body line belongs to its own band's pools over a wide seed sweep
 *   4. empty pool fallback - an emptied band produces exactly the
 *      documented fallback variant, deterministic across seeds, without
 *      disturbing other bands
 *
 * Run: node test/epilogues-test.mjs  (prints EPILOGUES ALL PASS, exits 0)
 */
import { register } from 'node:module';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const {
  exposureBand, selectEpilogue,
  EXPOSURE_BANDS, EXPOSURE_BAND_EDGES, EPILOGUE_BODY_LINES,
  EPILOGUE_POOLS, FALLBACK_TITLE, FALLBACK_LINE,
} = await import('../src/story/epilogues.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

// Independent reference mapping built from the exported edge table only.
function refBand(e) {
  const v = Math.min(1, Math.max(0, e));
  for (let i = 0; i < EXPOSURE_BAND_EDGES.length; i++) {
    if (v < EXPOSURE_BAND_EDGES[i]) return EXPOSURE_BANDS[i];
  }
  return EXPOSURE_BANDS[EXPOSURE_BANDS.length - 1];
}

// --- 1. band mapping exact -----------------------------------------------------
console.log('[band mapping]');
{
  ok(exposureBand(0) === 'clean', 'E=0 maps to clean');
  ok(exposureBand(1) === 'dissolved', 'E=1 maps to dissolved (last band closed)');
  ok(exposureBand(-0.5) === 'clean', 'negative E clamps into clean');
  ok(exposureBand(1.5) === 'dissolved', 'E>1 clamps into dissolved');
  // Boundary sweep: every edge value opens the NEXT band; just-below stays down.
  for (let i = 0; i < EXPOSURE_BAND_EDGES.length; i++) {
    const edge = EXPOSURE_BAND_EDGES[i];
    const below = edge - 1e-9;
    const above = edge + 1e-9;
    ok(exposureBand(edge) === refBand(edge), `edge ${edge} maps deterministically to ${refBand(edge)}`);
    ok(exposureBand(edge) === EXPOSURE_BANDS[i + 1], `edge ${edge} belongs to the band that opens at it`);
    ok(exposureBand(below) === EXPOSURE_BANDS[i], `${below} (just below ${edge}) stays in ${EXPOSURE_BANDS[i]}`);
    ok(refBand(above) === EXPOSURE_BANDS[i + 1], `${above} enters ${EXPOSURE_BANDS[i + 1]}`);
  }
  // Fine sweep: implementation agrees with the reference everywhere.
  let sweepOk = true;
  const STEP = 1 / 4000;
  for (let e = -0.25; e <= 1.25; e += STEP) {
    if (exposureBand(e) !== refBand(e)) { sweepOk = false; break; }
  }
  ok(sweepOk, 'fine sweep -0.25..1.25 matches reference half-open mapping at every step');
}

// --- 2. within-band assembly deterministic ------------------------------------
console.log('[deterministic assembly]');
{
  // Byte-identical replay for identical inputs.
  const a = selectEpilogue(0.31, 12345);
  const b = selectEpilogue(0.31, 12345);
  ok(a.text === b.text, 'same (E, seed) replays byte-identical text');
  // Keyed to BAND, not E: any two exposures inside one band give identical text.
  const pairs = [[0.05, 0.2499], [0.3, 0.4999], [0.55, 0.7499], [0.8, 1]];
  let bandKeyed = true;
  for (const [e1, e2] of pairs) {
    const t1 = selectEpilogue(e1, 777).text;
    const t2 = selectEpilogue(e2, 777).text;
    if (t1 !== t2 || selectEpilogue(e1, 777).band !== selectEpilogue(e2, 777).band) bandKeyed = false;
  }
  ok(bandKeyed, 'text depends only on the band: all same-band E pairs byte-identical per seed');
  // Structure: title + blank line + EPILOGUE_BODY_LINES lines + trailing newline.
  ok(a.lines.length === EPILOGUE_BODY_LINES, `exactly ${EPILOGUE_BODY_LINES} body lines`);
  ok(a.text === `${a.title}\n\n${a.lines.join('\n')}\n`, 'rendered text matches documented format');
  // Seeds decorrelate: different seeds overwhelmingly assemble differently.
  let differing = 0;
  const base = selectEpilogue(0.6, 0).text;
  for (let s = 1; s <= 40; s++) if (selectEpilogue(0.6, s).text !== base) differing++;
  ok(differing >= 36, `seed variation assembles distinct variants (${differing}/40 differ)`);
}

// --- 3. pools never leak across bands -----------------------------------------
console.log('[pool isolation]');
{
  let leak = false;
  for (const band of EXPOSURE_BANDS) {
    const lo = band === 'clean' ? 0 : EXPOSURE_BAND_EDGES[EXPOSURE_BANDS.indexOf(band) - 1] + 1e-6;
    const hi = band === 'dissolved' ? 1 : EXPOSURE_BAND_EDGES[EXPOSURE_BANDS.indexOf(band)] - 1e-6;
    for (let s = 0; s < 60; s++) {
      const e = lo + ((hi - lo) * s) / 60;
      const ep = selectEpilogue(e, s);
      if (!EPILOGUE_POOLS[band].titles.includes(ep.title)) leak = true;
      for (const line of ep.lines) {
        if (!EPILOGUE_POOLS[band].fragments.includes(line)) leak = true;
      }
    }
  }
  ok(!leak, 'every title/body line over 240 assemblies comes from its own band\u2019s pools');
}

// --- 4. empty pool fallback ----------------------------------------------------
console.log('[empty pool fallback]');
{
  const emptied = { ...EPILOGUE_POOLS, tinged: { titles: [], fragments: [] } };
  const f1 = selectEpilogue(0.3, 111, emptied);
  const f2 = selectEpilogue(0.49, 999999, emptied);
  ok(f1.band === 'tinged', 'emptied band still reported on the result');
  ok(f1.title === FALLBACK_TITLE, 'fallback title is the documented constant');
  ok(f1.lines.length === EPILOGUE_BODY_LINES && f1.lines.every((l) => l === FALLBACK_LINE),
    'every body line is the documented fallback line');
  ok(f1.text.includes(FALLBACK_LINE), 'fallback line present in rendered text');
  ok(f1.text === f2.text, 'fallback variant identical across seeds and exposures (constant output)');
  // Other bands unaffected by the emptied entry.
  const clean = selectEpilogue(0.1, 42, emptied);
  const normalClean = selectEpilogue(0.1, 42);
  ok(clean.text === normalClean.text && clean.title !== FALLBACK_TITLE,
    'non-emptied bands assemble normally alongside an emptied band');
  const dis = selectEpilogue(0.9, 42, emptied);
  ok(EPILOGUE_POOLS.dissolved.titles.includes(dis.title), 'dissolved untouched by emptied tinged pool');
}

console.log(failures === 0 ? 'EPILOGUES ALL PASS' : `EPILOGUES FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
