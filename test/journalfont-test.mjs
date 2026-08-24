/**
 * Evolving journal font tests (F96) - pure Node, no renderer.
 * Verifies the F96 acceptance proof:
 *   1. AC font-stage table - degradationIndex matches
 *      clamp(stage*0.2 + (1-sanity)*0.3) exactly across the combined
 *      stage/sanity grid, and every descriptor field worsens monotonically
 *      along both axes of the grid (stage up, sanity down)
 *   2. exact healthy defaults at rest - index 0 yields slantDeg 0,
 *      jitterAmpPx 0, strokeWeight 1, glyphBreakProbability 0, including
 *      through per-entry variation (an entry can never start healthier)
 *   3. jitter bounds - jitterAmpPx stays inside [0, FONT_JITTER_MAX_PX]
 *      across the whole grid plus seeded entry variation; other fields stay
 *      inside their maxima too
 *   4. per-entry seeded variation +/-10% - effective descriptors lie inside
 *      the [index*0.9, min(1, index*1.1)] envelope, differ between entries,
 *      and replay byte-identical per (entryId, index)
 *   5. determinism - identical inputs replay byte-identical descriptors;
 *      worse states never produce a healthier field than a better state
 *   6. junk safe - NaN/Infinity/negative stage/sanity clamp into valid
 *      in-range descriptors without throwing; only non-string/empty entryId
 *      fails loud
 *
 * Run: node test/journalfont-test.mjs  (prints JOURNALFONT ALL PASS, exits 0)
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
  degradationIndex, journalFont, entryJournalFont,
  REST_FONT, FONT_SLANT_MAX_DEG, FONT_JITTER_MAX_PX,
  FONT_STROKE_MAX_WEIGHT, FONT_BREAK_MAX_PROBABILITY, ENTRY_VARIATION,
} = await import('../src/ui/journalfont.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const STAGES = [0, 1, 2, 3, 4];
const SANITIES = [1, 0.75, 0.5, 0.25, 0];
const FIELDS = ['slantDeg', 'jitterAmpPx', 'strokeWeight', 'glyphBreakProbability'];

// ---------------------------------------------------------------------------
console.log('1. AC font-stage table: index formula + monotone worsening grid');
{
  let formulaExact = true;
  for (const st of STAGES) for (const sa of SANITIES) {
    const want = Math.min(1, Math.max(0, st * 0.2 + (1 - sa) * 0.3));
    if (!near(degradationIndex(st, sa), want, 0)) formulaExact = false;
  }
  ok(formulaExact, `degradationIndex matches clamp(stage*0.2+(1-sanity)*0.3) exactly over ${STAGES.length}x${SANITIES.length} grid`);

  // Monotone worsening along stage axis (sanity fixed).
  let monoStage = true;
  for (const sa of SANITIES) {
    for (let s = 1; s < STAGES.length; s++) {
      const lo = journalFont(degradationIndex(STAGES[s - 1], sa));
      const hi = journalFont(degradationIndex(STAGES[s], sa));
      for (const f of FIELDS) if (hi[f] < lo[f]) monoStage = false;
    }
  }
  ok(monoStage, 'every field non-decreasing as stage rises at fixed sanity');

  // Monotone worsening along sanity axis (stage fixed).
  let monoSanity = true;
  for (const st of STAGES) {
    for (let q = 1; q < SANITIES.length; q++) {
      const lo = journalFont(degradationIndex(st, SANITIES[q - 1]));
      const hi = journalFont(degradationIndex(st, SANITIES[q]));
      for (const f of FIELDS) if (hi[f] < lo[f]) monoSanity = false;
    }
  }
  ok(monoSanity, 'every field non-decreasing as sanity falls at fixed stage');
}
// ---------------------------------------------------------------------------
console.log('2. Exact healthy defaults at rest');
{
  ok(near(degradationIndex(0, 1), 0, 0), 'rest state (stage 0, sanity 1) indexes to exactly 0');
  const rest = journalFont(0);
  ok(
    rest.slantDeg === 0 && rest.jitterAmpPx === 0 &&
    rest.strokeWeight === 1 && rest.glyphBreakProbability === 0 &&
    JSON.stringify(rest) === JSON.stringify({ ...REST_FONT }),
    'journalFont(0) equals REST_FONT exactly {slantDeg:0, jitterAmpPx:0, strokeWeight:1, glyphBreakProbability:0}',
  );
  let restEntriesExact = true;
  for (const id of ['note-001', 'zzz-last-page', 'memo-77']) {
    const f = entryJournalFont(0, id);
    if (!(f.slantDeg === 0 && f.jitterAmpPx === 0 && f.strokeWeight === 1 && f.glyphBreakProbability === 0)) {
      restEntriesExact = false;
    }
  }
  ok(restEntriesExact, 'entry variation at rest still hits the exact healthy defaults');
  ok(
    near(journalFont(1).slantDeg, FONT_SLANT_MAX_DEG, 0) &&
    near(journalFont(1).jitterAmpPx, FONT_JITTER_MAX_PX, 0),
    'full degradation reaches the tunable maxima',
  );
}
// ---------------------------------------------------------------------------
console.log('3. Jitter bounds across grid + entry variation');
{
  let inBounds = true;
  for (const st of STAGES) for (const sa of SANITIES) {
    const idx = degradationIndex(st, sa);
    for (const f of [journalFont(idx), ...['a', 'b', 'c', 'entry-x'].map((id) => entryJournalFont(idx, id))]) {
      if (!(f.jitterAmpPx >= 0 && f.jitterAmpPx <= FONT_JITTER_MAX_PX)) inBounds = false;
      if (!(f.slantDeg >= 0 && f.slantDeg <= FONT_SLANT_MAX_DEG)) inBounds = false;
      if (!(f.strokeWeight >= 1 && f.strokeWeight <= FONT_STROKE_MAX_WEIGHT)) inBounds = false;
      if (!(f.glyphBreakProbability >= 0 && f.glyphBreakProbability <= FONT_BREAK_MAX_PROBABILITY)) inBounds = false;
    }
  }
  ok(inBounds, `all fields inside [0, max] on the full grid incl. entries (jitter bound ${FONT_JITTER_MAX_PX}px)`);

  // A sweep of many entry ids never escapes the jitter bound either.
  let sweepInBounds = true;
  for (let n = 0; n < 200; n++) {
    const f = entryJournalFont(1, `entry-${n}`);
    if (!(f.jitterAmpPx >= 0 && f.jitterAmpPx <= FONT_JITTER_MAX_PX)) sweepInBounds = false;
  }
  ok(sweepInBounds, 'jitter stays bounded over a 200-entry sweep at full degradation');
}
// ---------------------------------------------------------------------------
console.log('4. Per-entry seeded variation within +/-10% envelope');
{
  let insideEnvelope = true;
  for (const idx of [0.2, 0.5, 0.8, 1]) {
    for (let n = 0; n < 40; n++) {
      const f = entryJournalFont(idx, `page-${n}`);
      const lo = journalFont(Math.min(1, idx * (1 - ENTRY_VARIATION)));
      const hi = journalFont(Math.min(1, idx * (1 + ENTRY_VARIATION)));
      for (const fld of FIELDS) if (f[fld] < lo[fld] || f[fld] > hi[fld]) insideEnvelope = false;
    }
  }
  ok(insideEnvelope, 'entry descriptors sit inside the +/-10%-of-degradation envelope componentwise');

  const a = FIELDS.map((f) => entryJournalFont(0.6, 'alpha')[f]);
  const b = FIELDS.map((f) => entryJournalFont(0.6, 'beta')[f]);
  ok(JSON.stringify(a) !== JSON.stringify(b), 'different entryIds diverge at the same index');

  const again = FIELDS.map((f) => entryJournalFont(0.6, 'alpha')[f]);
  ok(JSON.stringify(a) === JSON.stringify(again), 'same (entryId, index) replays identically');
}
// ---------------------------------------------------------------------------
console.log('5. Determinism');
{
  const d1 = journalFont(degradationIndex(3, 0.4));
  const d2 = journalFont(degradationIndex(3, 0.4));
  ok(JSON.stringify(d1) === JSON.stringify(d2), 'identical stage/sanity replay byte-identical descriptors');

  let allFinite = true;
  for (const st of STAGES) for (const sa of SANITIES) {
    for (const f of Object.values(journalFont(degradationIndex(st, sa)))) {
      if (typeof f !== 'number' || !Number.isFinite(f)) allFinite = false;
    }
  }
  ok(allFinite, 'descriptors contain only finite numbers everywhere on the grid');
}
// ---------------------------------------------------------------------------
console.log('6. Junk safe');
{
  const junkStages = [NaN, Infinity, -Infinity, -3, 9];
  let junkClamps = true;
  for (const st of junkStages) {
    const idx = degradationIndex(st, 1);
    if (!(idx >= 0 && idx <= 1)) junkClamps = false;
    const f = journalFont(idx);
    if (!FIELDS.every((k) => Number.isFinite(f[k]))) junkClamps = false;
  }
  ok(junkClamps && near(degradationIndex(NaN, 1), 0, 0) && near(degradationIndex(9, 1), 0.8, 0),
    'junk stages clamp into [0,1] indices without throwing (NaN -> rest, over-max -> stage-4 value)');

  const junkSanities = [NaN, Infinity, -Infinity, -0.5, 42];
  let junkSanityOk = true;
  for (const sa of junkSanities) {
    const idx = degradationIndex(0, sa);
    if (!(idx >= 0 && idx <= 1)) junkSanityOk = false;
  }
  ok(junkSanityOk && near(degradationIndex(0, NaN), 0, 0) && near(degradationIndex(0, -2), 0.3, 1e-12),
    'junk sanity clamps into [0,1] without throwing (NaN -> rest, negative -> fully degraded sanity)');

  let threwEntry = false;
  try { entryJournalFont(0.5, undefined); } catch { threwEntry = true; }
  ok(threwEntry, "missing entryId fails loud ('journal entry needs a non-empty string entryId')");
}

console.log(failures === 0 ? `JOURNALFONT ALL PASS (${check} checks)` : `JOURNALFONT FAIL (${failures}/${check})`);
process.exit(failures === 0 ? 0 : 1);
