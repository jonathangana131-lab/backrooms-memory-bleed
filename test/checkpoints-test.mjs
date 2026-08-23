  console.log('ok -', label);
}

const mkSlot = (over = {}) => ({
  seed: 1234, px: 1.5, pz: -2.5, yaw: 0.7,
  playtimeSec: 60, savedAt: Date.now(), version: 2,
  story: { stage: 1, discoveries: over.discoveries ?? 2, found: [] },
  ...over,
});

// 1. name validation -------------------------------------------------------
await test('name validation accepts 1-32 alphanumeric/space names', async () => {
  assert.equal(validateName('Level 0 Exit'), 'Level 0 Exit');
  assert.equal(validateName('a'), 'a');
  assert.equal(validateName('  x  '), 'x', 'outer whitespace trimmed');
  assert.equal(validateName('two  words'), 'two words', 'internal whitespace runs normalized to single spaces');
  assert.equal(validateName('two words'), 'two words', 'single internal space allowed');
  assert.equal(validateName('A'.repeat(32)).length, 32);
});
await test('name validation rejects empty/long/symbolic names', async () => {
  assert.equal(validateName(''), null);
  assert.equal(validateName('   '), null);
  assert.equal(validateName('a'.repeat(33)), null);
  assert.equal(validateName('bad<script>'), null);
  assert.equal(validateName('no!slashes/path'), null);
  assert.equal(validateName(42), null);
  assert.equal(validateName(null), null);
});

// 2. create / list / load round-trip ---------------------------------------
await test('createCheckpoint stores and lists a snapshot', async () => {
  const m = new CheckpointManager();
  assert.equal(await m.createCheckpoint('Pool Rooms', mkSlot({ discoveries: 3 })), true);
  const list = await m.listCheckpoints();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Pool Rooms');
  assert.equal(list[0].discoveries, 3);
  assert.ok(list[0].savedAt > 0);
});
await test('loadCheckpoint returns the stored state deep-intact', async () => {
  const m = new CheckpointManager();
  const slot = mkSlot({ seed: 777, px: 9.25 });
  await m.createCheckpoint('hub', slot);
  const loaded = await m.loadCheckpoint('hub');
  assert.ok(loaded);
  assert.equal(loaded.seed, 777);
  assert.equal(loaded.px, 9.25);
  assert.deepEqual(loaded.story, slot.story);
  assert.equal(await m.loadCheckpoint('never-saved'), null);
});
await test('createCheckpoint rejects invalid names without storing', async () => {
  const m = new CheckpointManager();
  assert.equal(await m.createCheckpoint('', mkSlot()), false);
  assert.equal(await m.createCheckpoint('x'.repeat(40), mkSlot()), false);
  assert.equal(await m.createCheckpoint('<img src=x>', mkSlot()), false);
  assert.equal(rawStore().keys.length, 0);
  assert.deepEqual(await m.listCheckpoints(), []);
});
await test('listCheckpoints sorts newest first and reports discoveries', async () => {
  const m = new CheckpointManager();

(Showing lines 150-209 of 367. Use offset=210 to continue.)

