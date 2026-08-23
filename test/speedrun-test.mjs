  const c2 = makeClock();
  const s2 = new FakeStorage();
  const t2 = new SpeedrunTimer({ now: c2.now, storage: s2 });
  const seen = [];
  t2.onSplit = (r) => seen.push(r);
  t2.start();
  c2.advance(100);
  assert.equal(t2.split('silent'), null || t2.split('silent').isPB, 'sanity');
  assert.deepEqual(seen, []); // split() alone stays quiet
  c2.advance(100);
  const r = t2.recordSplit('loud');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'loud');
  assert.equal(seen[0].time, r.time);
  assert.equal(typeof r.isPB, 'boolean');


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
  setup.handle.destroy();
});

check('delta coloring: green vs stale PB, red when behind, neutral first-ever', () => {
  const st = new FakeStorage();
  const cA = makeClock();
  const warmup = new SpeedrunTimer({ now: cA.now, storage: st });
  warmup.start(); cA.advance(1000); warmup.stop(); // sets fullRun PB only
  const cB = makeClock();
  const racer = new SpeedrunTimer({ now: cB.now, storage: st });
  racer.start();
  const container = doc.createElement('div');
  const handle = buildOverlay(container, racer);
  cB.advance(800); racer.recordSplit('fast-first'); // ahead of nothing per-split -> neutral
  handle.refresh();
  let rows = handle.root.children[1].children;
  assert.equal(rows[0].style.color, '#cccccc');
  cB.advance(200); racer.reset(); racer.start();
  cB.advance(700); racer.recordSplit('fast-first'); // beats stored 800
  cB.advance(300); racer.recordSplit('slow-second'); // sets its own PB then equals it
  handle.refresh();
  rows = handle.root.children[1].children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].style.color, '#4caf50'); // 700 < 800
  assert.equal(rows[1].style.color, '#ff5252'); // tied with own PB counts as behind
  handle.destroy();
});

check('T key toggles overlay visibility via document listener', () => {
  const setup = freshOverlaySetup(doc);
  assert.equal(setup.handle.isVisible(), true);
  doc.dispatch('keydown', { key: 'T', target: { tagName: 'DIV' } });


