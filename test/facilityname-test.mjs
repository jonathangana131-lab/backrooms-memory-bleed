/**
 * Name discovery tests (F84) - pure Node, no browser.
 * Verifies the F84 acceptance proof: the seeded-correct assembly order is
 * deterministic per seed; collecting fragments in that order reveals the
 * true name while every other order never completes; disassembly resets
 * and re-collection in the correct order re-completes identically; the
 * signage-swap map is atomic (null until completion, full coverage once
 * assembled) and every replacement text embeds the true-name glyphs in
 * order via seeded phrasing variants; and the whole state round-trips
 * through serialize/load byte-identically, with malformed saves failing
 * loud.
 * Run: node test/facilityname-test.mjs  (prints ALL PASS, exits 0)
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

const { FacilityName, trueNameOrder, NAME_PHRASING_VARIANTS } = await import(
  '../src/story/facilityname.ts'
);

let failures = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

/** Seeded fragment list of single-character glyphs. */
function makeFragments(n) {
  const alphabet = 'ABCDEFGHIJ';
  const fragments = [];
  for (let i = 0; i < n; i++) {
    fragments.push({ id: `fragment-${String(i).padStart(2, '0')}`, glyph: alphabet[i] });
  }
  return fragments;
}

/** True iff needle's characters appear in haystack in order (subsequence). */
function subsequence(needle, haystack) {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
  }
  return i === needle.length;
}

console.log('1. seeded-correct order is deterministic per seed');
{
  const frags = makeFragments(6);
  const a = trueNameOrder(frags, 12345);
  const b = trueNameOrder(frags, 12345);
  ok(JSON.stringify(a) === JSON.stringify(b), 'same seed -> identical order');
  ok(a.length === frags.length && [...a].sort().join() === [...frags.map((f) => f.id)].sort().join(),
    'order is a permutation of the fragment ids');
  let differs = false;
  for (let seed = 0; seed < 24; seed++) {
    if (JSON.stringify(trueNameOrder(frags, seed)) !== JSON.stringify(a)) { differs = true; break; }
  }
  ok(differs || frags.length <= 1, 'different seeds derive independent orders');
}

console.log('2. correct-order collection completes; wrong orders never complete');
{
  const frags = makeFragments(5);
  const name = new FacilityName(frags, 777);
  ok(name.assembled === false, 'fresh tracker not assembled');
  ok(name.trueName === null, 'true name null before assembly');
  const order = trueNameOrder(frags, 777);
  for (const id of order) name.collect(id);
  ok(name.assembled === true, 'exact seeded order completes');
  ok(typeof name.trueName === 'string' && name.trueName.length === frags.length,
    'true name has one glyph per fragment');
  const expected = order
    .map((id) => frags.find((f) => f.id === id).glyph)
    .join('');
  ok(name.trueName === expected, 'true name concatenates glyphs in seeded order');

  // Adversarial: every non-identity permutation prefix strategy fails.
  let wrongEverCompleted = false;
  for (let seed = 0; seed < 40; seed++) {
    const f2 = makeFragments(4);
    const correct = trueNameOrder(f2, seed);
    const m = new FacilityName(f2, seed);
    // reversed, rotated, swapped-pair orders
    const attempts = [
      [...correct].reverse(),
      [...correct.slice(1), correct[0]],
      [correct[1], correct[0], ...correct.slice(2)],
      [...correct].sort(),
    ];
    for (const attempt of attempts) {
      if (JSON.stringify(attempt) === JSON.stringify(correct)) continue;
      const bad = new FacilityName(f2, seed);
      for (const id of attempt) bad.collect(id);
      if (bad.assembled) wrongEverCompleted = true;
    }
  }
  ok(wrongEverCompleted === false, 'no wrong order ever completed across 40 seeds');

  // A single wrong pick blocks even subsequent correct continuation.
  const blocker = new FacilityName(frags, 777);
  blocker.collect(order[0]);
  blocker.collect(order[2]);
  blocker.collect(order[1]);
  blocker.collect(order[3]);
  blocker.collect(order[4]);
  ok(blocker.assembled === false, 'wrong pick mid-sequence blocks completion permanently');
}

console.log('3. disassembly / re-collection resets');
{
  const frags = makeFragments(4);
  const order = trueNameOrder(frags, 42);
  const name = new FacilityName(frags, 42);
  for (const id of order) name.collect(id);
  ok(name.assembled === true, 'assembled before reset');
  name.disassemble();
  ok(name.assembled === false && name.trueName === null, 'disassemble clears completion atomically');
  for (const id of order) name.collect(id);
  ok(name.assembled === true && name.trueName === order.map((i) => frags.find((f) => f.id === i).glyph).join(''),
    're-collection in correct order re-completes identically');

  const unknown = new FacilityName(frags, 42);
  let threw = false;
  try { unknown.collect('fragment-99'); } catch { threw = true; }
  ok(threw, 'unknown fragment id fails loud');
}

console.log('4. sign swap propagation + atomicity');
{
  const frags = makeFragments(5);
  const signs = [
    { id: 'sign-lobby', currentText: 'LOBBY' },
    { id: 'sign-dock', currentText: 'LOADING DOCK' },
    { id: 'sign-annex', currentText: 'ANNEX B' },
    { id: 'sign-pool', currentText: 'POOLROOMS' },
  ];
  const name = new FacilityName(frags, 2024);
  ok(name.signSwaps(signs) === null, 'swap map absent before completion (atomic)');
  const partial = new FacilityName(frags, 2024);
  partial.collect(trueNameOrder(frags, 2024)[0]);
  ok(partial.signSwaps(signs) === null, 'partial collection produces no map');

  for (const id of trueNameOrder(frags, 2024)) name.collect(id);
  const swaps = name.signSwaps(signs);
  ok(swaps instanceof Map && swaps.size === signs.length, 'completed run swaps every sign');
  const trueStr = name.trueName;
  let allContain = true;
  for (const sign of signs) {
    const newText = swaps.get(sign.id);
    if (!newText || !subsequence(trueStr, newText)) { allContain = false; break; }
  }
  ok(allContain, "every sign's new text contains the true-name glyphs in order");
  ok(signs.every((s) => swaps.get(s.id).includes(trueStr)), 'every replacement embeds the full true name');
  ok(signs.every((s) => NAME_PHRASING_VARIANTS.some((v) => v.replace('%N%', trueStr) === swaps.get(s.id))),
    'every replacement uses one of the documented phrasing variants');
  const again = name.signSwaps(signs);
  ok(JSON.stringify([...swaps]) === JSON.stringify([...again]), 'repeat query reproduces identical map');

  // Determinism across instances.
  const twin = new FacilityName(frags, 2024);
  for (const id of trueNameOrder(frags, 2024)) twin.collect(id);
  ok(JSON.stringify([...twin.signSwaps(signs)]) === JSON.stringify([...swaps]),
    'same seed + same collection -> byte-identical swap map');
  const pickedTemplates = new Set();
  for (let seed = 0; seed < 60; seed++) {
    const f3 = makeFragments(5);
    const n3 = new FacilityName(f3, seed);
    for (const id of trueNameOrder(f3, seed)) n3.collect(id);
    const text3 = n3.signSwaps([{ id: 'sign-a', currentText: 'A' }]).get('sign-a');
    pickedTemplates.add(NAME_PHRASING_VARIANTS.findIndex((v) => v.replace('%N%', n3.trueName) === text3));
  }
  ok(pickedTemplates.size > 1, `seeded phrasing variants vary across seeds (${pickedTemplates.size} distinct)`);

  let dupThrew = false;
  try { name.signSwaps([...signs, signs[0]]); } catch { dupThrew = true; }
  ok(dupThrew, 'duplicate sign ids fail loud');
}

console.log('5. serialize round-trip + malformed saves fail loud');
{
  const frags = makeFragments(5);
  const order = trueNameOrder(frags, 555);
  const name = new FacilityName(frags, 555);
  name.collect(order[0]);
  name.collect(order[1]);
  const revived = new FacilityName([], 0, JSON.parse(JSON.stringify(name.serialize())));
  ok(revived.assembled === false, 'partial progress survives round-trip as incomplete');
  for (const id of order.slice(2)) revived.collect(id);
  ok(revived.assembled === true, 'revived tracker completes with remaining collects');
  const fresh = new FacilityName(frags, 555);
  for (const id of order) fresh.collect(id);
  ok(JSON.stringify([...fresh.signSwaps([{ id: 's', currentText: 'S' }])]) ===
     JSON.stringify([...revived.signSwaps([{ id: 's', currentText: 'S' }])]),
    'round-tripped state produces identical swap map');

  const done = new FacilityName(frags, 555);
  for (const id of order) done.collect(id);
  const doneRevived = new FacilityName([], 0, JSON.parse(JSON.stringify(done.serialize())));
  ok(doneRevived.assembled === true && doneRevived.trueName === done.trueName,
    'fully-assembled state round-trips complete');

  const badStates = [
    { seed: 'x', fragments: frags, collectedIds: [] },
    { seed: 1, collectedIds: [] },
    { seed: 1, fragments: [], collectedIds: [] },
    { seed: 1, fragments: [{ id: 'a', glyph: 'A' }, { id: 'a', glyph: 'B' }], collectedIds: [] },
    { seed: 1, fragments: [{ id: 'a', glyph: '' }], collectedIds: [] },
    { seed: 1, fragments: [{ id: 'a', glyph: 'A' }], collectedIds: ['ghost'] },
    null,
  ];
  let loud = 0;
  for (const bad of badStates) {
    try {
      if (bad === null) new FacilityName(frags, 0, /** @type {any} */ (null));
      else new FacilityName([], 0, bad);
    } catch { loud++; }
  }
  ok(loud === badStates.length, `all ${badStates.length} malformed saves fail loud`);

  let dupThrew = false;
  try { new FacilityName([frags[0], frags[0]], 1); } catch { dupThrew = true; }
  ok(dupThrew, 'duplicate injected fragment ids fail loud');
}

console.log(`\n${checks - failures}/${checks} checks`);
if (failures === 0 && checks > 0) console.log('ALL PASS');
else { console.error(`${failures} FAILURES`); process.exit(1); }
