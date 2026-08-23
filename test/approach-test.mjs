  run(w, 3, 8, true, 'gravel');
  assert.ok(w.fired.length > 0);
  for (const f of w.fired) assert.equal(f.surface, 'carpet');
});

test('distance envelope rides each step record', () => {
  const far = new WatcherSteps(null, null);
  run(far, 4, 24, true);
  const near = new WatcherSteps(null, null);
  run(near, 4, 7, true);
  assert.ok(near.fired.length > 0 && far.fired.length > 0);
  const avg = (w) => w.fired.reduce((s, f) => s + f.gain, 0) / w.fired.length;
  assert.ok(avg(near) > avg(far) * 3, 'closer watcher is much louder');

  const cut = new WatcherSteps(null, null);
  run(cut, 4, 2.9, true); // inside 3 m: silence before the encounter


