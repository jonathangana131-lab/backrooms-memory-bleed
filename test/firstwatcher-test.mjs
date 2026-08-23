    const b = preludeFlicker('prelude', (i + 1) / rate, 11);
    if (a !== b) diffs++;
    n++;
    assert.ok(a >= 0 && a <= 1);
  }
  assert.ok(diffs > n * 0.25, 'flicker should visibly strobe, got ' + diffs + '/' + n);
});

check('nearestFixtureIndex picks the closest fixture to the spawn point', () => {
  const fixtures = [{ x: 10, z: 0 }, { x: 0, z: 3 }, { x: -8, z: -1 }];
  assert.equal(nearestFixtureIndex(fixtures, 0.5, 0.5), 1);
  assert.equal(nearestFixtureIndex(fixtures, 9, -1), 0);
  assert.equal(nearestFixtureIndex([], 0, 0), -1);
});

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

function freshIntro(storage, slot = 'auto') {

(Showing lines 118-137 of 255. Use offset=138 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
check('never repeats: a second expedition instance on the same slot is refused', () => {
  const s = memStorage();
  const first = freshIntro(s);
  first.playPreloader(3, 4);
  first.markShown();
  const second = freshIntro(s);
  assert.equal(second.shouldPlay(), false);
  second.playPreloader(3, 4); // no-op
  assert.equal(second.isActive(), false);
}});
);

check('slots are independent: another save still gets its own intro', () => {
  const s = memStorage();
  const a = new FirstWatcher({ slot: 'auto', storage: s });
  a.markShown();
  const b = new FirstWatcher({ slot: 'manual-1', storage: s });
  assert.equal(b.shouldPlay(), true);
});


(Showing lines 150-169 of 255. Use offset=170 to continue.)

