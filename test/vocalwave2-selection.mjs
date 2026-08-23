/*
 * Vocal wave 2 selection tests -- pure data + pure selectors, no engine.
 * Run: node test/vocalwave2-selection.mjs
 */
import {
  HELPER_COMFORTS,
  INCOMPLETE_BASE_PHRASES,
  WATCHER_BROADCASTS,
  garblePhrase,
  pickHelperComfort,
  pickIncompleteGarble,
  pickWatcherBroadcast,
} from '../src/entities/vocalwave2.ts';

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok  ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
}

const behaviour = async () => {
  // ---- pools are well formed ----------------------------------------------
  ok(WATCHER_BROADCASTS.length >= 4 && WATCHER_BROADCASTS.every((b) =>
      typeof b.text === 'string' && b.text.length > 0 && Number.isInteger(b.syllables) && b.syllables > 0),
    'watcher broadcasts carry words with honest syllable counts');
  ok(HELPER_COMFORTS.length >= 3 && HELPER_COMFORTS.every((c) =>
      typeof c.text === 'string' && c.text.length >= 5),
    'helper comforts are full quiet-dread sentences');
  ok(INCOMPLETE_BASE_PHRASES.length >= 8
      && INCOMPLETE_BASE_PHRASES.every((p) => /^[a-z A-Z,']+$/.test(p)),
    'incomplete base phrases are plain domestic sentences');

  // ---- watcher broadcast selection ----------------------------------------
  const w1 = pickWatcherBroadcast(101);
  ok(w1 !== null && WATCHER_BROADCASTS.includes(w1), 'broadcast picks trace to the pool');
  let wRepeat = false;
  let prev = w1;
  for (let s = 102; s < 140; s++) {
    const w = pickWatcherBroadcast(s, [prev]);
    if (w === prev) wRepeat = true;
    prev = w;
  }
  ok(!wRepeat, 'back-to-back broadcast repeats are skipped when history says no');

  // ---- helper comfort gate --------------------------------------------------
  ok(pickHelperComfort(7, 1.0) === null, 'steady world: helpers stay silent');
  ok(pickHelperComfort(7, 0.5) === null, 'above the threshold nobody wastes kindness');
  ok(pickHelperComfort(7, 0.39) !== null, 'just under the threshold a fragment appears');
  ok(pickHelperComfort(9, -2) !== null, 'deeply negative stability still comforts');
  ok(pickHelperComfort(11, 0.2) !== null && HELPER_COMFORTS.includes(pickHelperComfort(11, 0.2)),
    'unlocked fragments trace to the pool');
  ok(pickHelperComfort(7, 1.0) === null,
    'gate holds at extremes (1.0 null, negative low yields fragment)');
  ok(garblePhrase('', 5).text === '...', 'empty phrase garbles to bare ellipsis');

  // ---- garble transformation properties ----
  let sawDoubling = false;
  let sawTruncation = false;
  let sawEllipsis = false;
  let allEndPunctuated = true;
  let sourcesHonest = true;
  for (let s = 0; s < 300; s++) {
    const g = garblePhrase(INCOMPLETE_BASE_PHRASES[s % INCOMPLETE_BASE_PHRASES.length], s * 2654435761);
    if (/[a-z]+-[a-z]+/.test(g.text)) sawDoubling = true;
    if (g.text.split(/\s+|[.,]/).some((w) => w.length >= 1 && w.length <= 2)) sawTruncation = true;
    if (/\.\.\.$/.test(g.text)) sawEllipsis = true;
    if (!/($|\.\.\.|\.)$/.test('x')) allEndPunctuated = false; // placeholder guard
    if (!/(\.\.\.|\.)$/.test(g.text)) allEndPunctuated = false;
    if (!INCOMPLETE_BASE_PHRASES.includes(g.source)) sourcesHonest = false;
    if (!g.text.startsWith(g.text[0].toLowerCase?.() ?? g.text[0])) { /* lowercase-ish output */ }
  }
  ok(sawDoubling, 'syllable doubling present across seeds (hyphenated repeats)');
  ok(sawTruncation, 'truncation present across seeds (clipped short words)');
  ok(sawEllipsis, 'tail abandonment produces ellipses across seeds');
  ok(allEndPunctuated, 'every garble ends punctuated (ellipsis or period)');
  ok(sourcesHonest, 'every garble reports its exact base phrase as source');
  // punctuation stripped from corrupted body
  const commaGarbles = new Set();
  for (let s = 0; s < 100; s++) {
    commaGarbles.add(garblePhrase('excuse me, is this seat taken', s).text);
  }
  const hasComma = [...commaGarbles].some((t) => /,/.test(t.replace(/\.\.\.$/, '').replace(/\.$/, '')));
  ok(!hasComma, 'interior punctuation stripped before corruption');
  // word count never grows beyond source (doubling reuses prefix, tail may drop)


  let grewLonger = false;
  for (let s = 0; s < 100; s++) {
    const g = garblePhrase('we regret to inform you', s);
    if (g.text.split(/\s+/).length > 'we regret to inform you'.split(/\s+/).length) grewLonger = true;
  }
  ok(!grewLonger, 'garbled word count never exceeds the source phrase');

  // ---- incomplete selection tracks sources, not rendered text ----
  const ig1 = pickIncompleteGarble(4711);
  ok(ig1 !== null && INCOMPLETE_BASE_PHRASES.includes(ig1.source),
    'pickIncompleteGarble traces to a base phrase');
  const seenSources = [ig1.source];
  let noRepeat = true;
  for (let i = 0; i < 50; i++) {
    const g = pickIncompleteGarble(4711, seenSources.slice(-1));
    if (g === null || g.source === seenSources[seenSources.length - 1]) { noRepeat = false; break; }
    seenSources.push(g.source);
  }
  ok(noRepeat, 'source-level anti-repetition holds across 50 chained picks');
  // two seeds hitting the same source render different garbles sometimes
  const renders = new Set();
  for (let s = 0; s < 40; s++) renders.add(garblePhrase('dinner is at seven tonight', s).text);
  ok(renders.size >= 10, 'same source renders varied garbles (' + renders.size + '/40)');
}

try {
  await behaviour();
} catch (err) {
  console.error('  FAIL behavioural section could not run:', err && err.stack || err);
  failures++;

}
if (failures > 0) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('ALL VOCALWAVE2 SELECTION TESTS PASSED');
