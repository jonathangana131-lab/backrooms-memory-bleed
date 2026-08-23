  assert.equal(typeof h1, 'number');
  assert.ok(h1 >= 0 && h1 <= 0xffffffff);
  assert.equal(fnv1a('hello'), fnv1a('hello'));
  assert.notEqual(fnv1a('hello'), fnv1a('hellp'));
  console.log('PASS fnv1a deterministic 32-bit');

  // --- title derivation ---
  assert.equal(deriveFeedTitle('FIELD NOTE A-1: We are mapping the east wing. Reyes says the corridors repeat.'), 'FIELD NOTE A-1: We are mapping the east wing');
  assert.equal(deriveFeedTitle('RULE: if a room feels safe, leave immediately.'), 'RULE: if a room feels safe, leave immediately');
  const long = 'The wallpaper pattern repeats every 41 rolls so start counting them now please';
  assert.ok(long.length > 40);
  const t = deriveFeedTitle(long + '. Then stop.');
  assert.equal(t, long.slice(0, 40) + '...');
  assert.equal(t.length, 43);
  console.log('PASS title derivation: first sentence, 40-char truncation');

  // --- note id stability & coord sensitivity ---
  const idA = noteIdFor('same text', 10, 20);
  assert.equal(idA, noteIdFor('same text', 10, 20));
  assert.notEqual(idA, noteIdFor('same text', 10.5, 20));

(Showing lines 15-34 of 86. Use offset=35 to continue.)

