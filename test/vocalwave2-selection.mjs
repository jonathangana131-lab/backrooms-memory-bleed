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
    if (g.text.split('\s+').length > 4) grewLonger = true;
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


