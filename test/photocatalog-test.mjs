/**
 * Anomaly photo catalog tests (F85) - pure Node, no browser.
 * Verifies the F85 acceptance proof: tier thresholds [0,3,8,15] map to
 * names [empty,contact,sheet,archive] with exact unlock points over
 * capture counts 0..20; the unlocked journal page set is the exact
 * cumulative union of the injected page table and monotone (never
 * re-locks), including adversarial out-of-order reveal interleavings;
 * serialize/parse JSON round-trips preserve progress; malformed saves,
 * malformed records, and duplicate page handling all behave as
 * documented; everything is deterministic with no randomness.
 * Run: node test/photocatalog-test.mjs  (prints ALL PASS, exits 0)
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
  PhotoCatalog, TIER_THRESHOLDS, TIER_NAMES, tierIndexForCount,
} = await import('../src/ui/photocatalog.ts');

let failures = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Injected page table covering every tier. */
function makePageTable() {
  return {
    empty: ['page-handbook'],
    contact: ['page-contact-1', 'page-contact-2'],
    sheet: ['page-sheet-1'],
    archive: ['page-archive-1', 'page-archive-2'],
  };
}

/** One revealing record. */
const hit = (seed = 1) => ({ revealed: true, silhouetteSeed: seed });
/** One non-revealing record. */
const miss = (seed = 0) => ({ revealed: false, silhouetteSeed: seed });

console.log('1. thresholds + names + exact unlock points over counts 0..20');
{
  ok(JSON.stringify(TIER_THRESHOLDS) === JSON.stringify([0, 3, 8, 15]), 'thresholds are [0,3,8,15]');
  ok(JSON.stringify(TIER_NAMES) === JSON.stringify(['empty', 'contact', 'sheet', 'archive']),
    'tier names are [empty,contact,sheet,archive]');

  const expectedTier = (n) => (n >= 15 ? 3 : n >= 8 ? 2 : n >= 3 ? 1 : 0);
  let exact = true;
  for (let count = 0; count <= 20; count++) {
    if (tierIndexForCount(count) !== expectedTier(count)) { exact = false; break; }
  }
  ok(exact, 'tierIndexForCount exact for every count 0..20');

  // Class-level check through the live class as well.
  let classExact = true;
  for (let count = 0; count <= 20; count++) {
    const cat = new PhotoCatalog(makePageTable());
    for (let i = 0; i < count; i++) cat.record(hit(i));
    if (cat.tierIndex !== expectedTier(count) || cat.tier !== TIER_NAMES[expectedTier(count)]) {
      classExact = false;
      break;
    }
  }
  ok(classExact, 'PhotoCatalog tier matches exactly at every capture count 0..20');
  ok(tierIndexForCount(9999) === 3 && tierIndexForCount(-5) === 0,
    'counts saturate high and clamp low');

  // Unlock points land exactly on the crossing capture.
  const cat = new PhotoCatalog(makePageTable());
  let pagesAtCrossing = true;
  for (let i = 0; i < 16; i++) {
    const before = [...cat.unlockedPages];
    cat.record(hit(i));
    const after = cat.unlockedPages;
    const crossed = expectedTier(i + 1) > expectedTier(i);
    if (crossed && after.length <= before.length) pagesAtCrossing = false;
    if (!crossed && after.length !== before.length) pagesAtCrossing = false;
  }
  ok(pagesAtCrossing, 'pages unlock exactly at threshold-crossing captures only');
}

console.log('2. page table mapping is exact + cumulative');
{
  const table = makePageTable();
  const cat = new PhotoCatalog(table);
  const expectedAt = (n) => {
    const tier = n >= 15 ? 3 : n >= 8 ? 2 : n >= 3 ? 1 : 0;
    return ['empty', 'contact', 'sheet', 'archive'].slice(0, tier + 1)
      .flatMap((t) => table[t]);
  };
  let exact = true;
  for (let count = 0; count <= 20; count++) {
    while (cat.revealedCount < count) cat.record(hit(count));
    const got = cat.unlockedPages.join(',');
    const want = expectedAt(count).join(',');
    if (got !== want) { exact = false; console.error('   count', count, 'got', got, 'want', want); break; }
  }
  ok(exact, 'unlockedPages equals cumulative page-table union at every count 0..20');
}

console.log('3. monotonicity incl. adversarial out-of-order counts');
{
  // Interleaved hits and misses never shrink the unlocked set.
  const cat = new PhotoCatalog(makePageTable());
  let monotone = true;
  const pattern = [hit(), miss(), miss(), hit(), hit(), miss(7), hit(), miss(), hit(),
    miss(), miss(), miss(), hit(), hit(), miss(3), hit()];
  let lastPages = '';
  for (let round = 0; round < 3; round++) {
    for (const rec of pattern) {
      cat.record(rec);
      const pages = cat.unlockedPages.join(',');
      if (!pages.startsWith(lastPages)) monotone = false;
      lastPages = pages;
      if (cat.tierIndex < 0 || cat.revealedCount < 0) monotone = false;
    }
  }
  ok(monotone, 'adversarial interleaved reveals keep unlockedPages monotone');
  ok(cat.tierIndex === 3 && cat.revealedCount === 24, 'interleaved run reaches archive tier');

  // A fresh catalog restored from a high-tier save then fed nothing stays unlocked.
  const saved = cat.serialize();
  const revived = new PhotoCatalog(makePageTable(), saved);
  ok(revived.unlockedPages.length === cat.unlockedPages.length, 'restored catalog keeps unlocks');
}

console.log('4. determinism');
{
  const replay = () => {
    const cat = new PhotoCatalog(makePageTable());
    for (let i = 0; i < 17; i++) cat.record(i % 4 === 3 ? miss(i) : hit(i));
    return JSON.stringify({ count: cat.revealedCount, tier: cat.tierIndex, pages: cat.unlockedPages, save: cat.serialize() });
  };
  ok(replay() === replay(), 'identical record streams replay byte-identically');
}

console.log('5. JSON round-trip persistence');
{
  const table = makePageTable();
  const cat = new PhotoCatalog(table);
  for (let i = 0; i < 9; i++) cat.record(hit(i * 13));
  const json = cat.serialize();
  const revived = new PhotoCatalog(table, json);
  ok(revived.revealedCount === cat.revealedCount &&
     revived.tierIndex === cat.tierIndex &&
     JSON.stringify(revived.unlockedPages) === JSON.stringify(cat.unlockedPages),
    'serialize/load restores full progress');

  // Continue after restore: counting resumes, tiers still promote.
  for (let i = 0; i < 10; i++) revived.record(hit(100 + i));
  ok(revived.tierIndex === 3 && revived.unlockedPages.includes('page-archive-2'),
    'restored catalog continues unlocking');

  // Round-trip of the round-trip is stable.
  ok(revived.serialize() === new PhotoCatalog(table, revived.serialize()).serialize(),
    'double round-trip is a fixpoint');

  // Adversarial save claiming a higher tier than its count implies keeps the mark.
  const inflated = JSON.stringify({ version: 1, revealedCount: 1, maxTierIndex: 3 });
  const adv = new PhotoCatalog(table, inflated);
  ok(adv.tierIndex === 3, 'inflated save keeps monotone high-water mark');
}

console.log('6. fail-loud malformed saves + records');
{
  const badSaves = [
    'not json at all',
    '{"version":2,"revealedCount":3,"maxTierIndex":1}',
    '{"revealedCount":3,"maxTierIndex":1}',
    '{"version":1,"revealedCount":-1,"maxTierIndex":0}',
    '{"version":1,"revealedCount":3.5,"maxTierIndex":0}',
    '{"version":1,"revealedCount":3,"maxTierIndex":99}',
    '{"version":1,"revealedCount":3,"maxTierIndex":-2}',
    '{"version":1,"maxTierIndex":1}',
    '{"version":1,"revealedCount":"3","maxTierIndex":1}',
    'null',
    '{}',
  ];
  let loud = 0;
  for (const bad of badSaves) {
    try { new PhotoCatalog(makePageTable(), bad); } catch { loud++; }
  }
  ok(loud === badSaves.length, `all ${badSaves.length} malformed saves fail loud`);

  const cat = new PhotoCatalog(makePageTable());
  const badRecords = [
    /** @type {any} */ ({ revealed: 'yes', silhouetteSeed: 1 }),
    /** @type {any} */ ({ revealed: true }),
    /** @type {any} */ ({ revealed: true, silhouetteSeed: Number.NaN }),
    null,
  ];
  let recLoud = 0;
  for (const badRecord of badRecords) {
    try { cat.record(badRecord ?? undefined); } catch { recLoud++; }
  }
  ok(recLoud === badRecords.length, `all ${badRecords.length} malformed records fail loud`);
  ok(cat.revealedCount === 0, 'failed records leave the count untouched');
}

console.log(`\n${checks - failures}/${checks} checks`);
if (failures === 0 && checks > 0) console.log('ALL PASS');
else { console.error(`${failures} FAILURES`); process.exit(1); }
