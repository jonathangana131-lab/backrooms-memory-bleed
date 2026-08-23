/**
 * First-watcher introduction tests -- pure Node, no engine.
 *
 * src/story/firstwatcher.ts is a dependency-free leaf, but it uses a
 * TypeScript parameter property that Node's strip-only mode rejects, so
 * it is transpiled on the fly with the workspace TypeScript install
 * (same approach as cracks-test.mjs) and loaded from a temp dir.
 * Run: node test/firstwatcher-test.mjs
 */
import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-firstwatcher-'));
{
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, 'src/story/firstwatcher.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  fs.writeFileSync(path.join(tmp, 'firstwatcher.mjs'), js);
}
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  FirstWatcher, FIRSTWATCHER_STORAGE_KEY, PRELUDE_SECONDS, REVEAL_HOLD_SECONDS,
  HUM_DUCK_FRACTION, FIRSTWATCHER_SUBTITLE, FLICKER_RATE_HZ,
  readShownSlots, persistShownSlot, humCurve, swellCurve, preludeFlicker,
  nearestFixtureIndex,
} = await import(pathToFileURL(path.join(tmp, 'firstwatcher.mjs')).href);

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + ' :: ' + (e && e.message || e)); }
}

/** In-memory localStorage stand-in. */
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

/* ------------------------------------------------------------------ */
/* Persistence record                                                  */
/* ------------------------------------------------------------------ */

check('readShownSlots tolerates missing and corrupt records', () => {
  const s = memStorage();
  assert.deepEqual(readShownSlots(s), {}, 'empty storage -> empty record');
  assert.deepEqual(readShownSlots(null), {}, 'null storage -> empty record');
  s.setItem(FIRSTWATCHER_STORAGE_KEY, '{not json');
  assert.deepEqual(readShownSlots(s), {}, 'corrupt JSON -> empty record');
  s.setItem(FIRSTWATCHER_STORAGE_KEY, '[1,2]');
  assert.deepEqual(readShownSlots(s), {}, 'non-object JSON -> empty record');
});

check('persistShownSlot round-trips through storage', () => {
  const s = memStorage();
  persistShownSlot(s, 'auto');
  persistShownSlot(s, 'manual-3');
  const slots = readShownSlots(s);
  assert.equal(slots.auto, true);
  assert.equal(slots['manual-3'], true);
});

/* ------------------------------------------------------------------ */
/* Curves                                                              */
/* ------------------------------------------------------------------ */

check('humCurve ducks to half during the prelude and restores in the reveal', () => {
  assert.equal(humCurve('idle', 0), 1, 'outside the intro the hum runs untouched');
  assert.equal(humCurve('done', 9), 1);
  assert.ok(humCurve('prelude', 0) === 1, 'prelude starts at full hum');
  assert.ok(Math.abs(humCurve('prelude', PRELUDE_SECONDS * 0.5) - HUM_DUCK_FRACTION) < 1e-9,
    'half the lead in, the duck bottoms out');
  assert.ok(Math.abs(humCurve('prelude', PRELUDE_SECONDS) - HUM_DUCK_FRACTION) < 1e-9,
    'the duck holds until visibility');
  assert.ok(Math.abs(humCurve('reveal', REVEAL_HOLD_SECONDS) - 1) < 1e-9,
    'the reveal eases the hum back to baseline');
});

check('swellCurve stays in [0,1], silent outside the intro', () => {
  assert.equal(swellCurve('idle', 1), 0);
  assert.equal(swellCurve('done', 1), 0);
  let rose = true;
  let last = -1;
  for (let t = 0; t <= PRELUDE_SECONDS + 1e-9; t += 0.1) {
    const v = swellCurve('prelude', t);
    assert.ok(v >= 0 && v <= 1);
    if (v < last) rose = false;
    last = v;
  }
  assert.ok(rose, 'the swell fades IN across the prelude');
  assert.ok(swellCurve('prelude', 0) === 0, 'starts from silence');
});

check('lights outside the prelude run calm at 1', () => {
  assert.equal(preludeFlicker('idle', 0.5, 11), 1);
  assert.equal(preludeFlicker('reveal', 0.5, 11), 1);
  assert.equal(preludeFlicker('done', 0.5, 11), 1);
});

check('preludeFlicker strobes chaotically then settles', () => {
  const rate = FLICKER_RATE_HZ;
  let prev = preludeFlicker('prelude', 0, 11);
  let diffs = 0, n = 0;
  for (let i = 0; i < Math.round(rate * PRELUDE_SECONDS); i++) {
    const a = prev;
    const b = preludeFlicker('prelude', (i + 1) / rate, 11);
    if (a !== b) diffs++;
    n++;
    assert.ok(a >= 0 && a <= 1);
    prev = b;
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
  return new FirstWatcher({ slot, storage });
}

check('never repeats: a second expedition instance on the same slot is refused', () => {
  const s = memStorage();
  const first = freshIntro(s);
  first.playPreloader(3, 4);
  first.markShown();
  const second = freshIntro(s);
  assert.equal(second.shouldPlay(), false);
  second.playPreloader(3, 4); // no-op
  assert.equal(second.isActive(), false);
});

check('slots are independent: another save still gets its own intro', () => {
  const s = memStorage();
  const a = new FirstWatcher({ slot: 'auto', storage: s });
  a.markShown();
  const b = new FirstWatcher({ slot: 'manual-1', storage: s });
  assert.equal(b.shouldPlay(), true);
});

check('the subtitle fires exactly once, at the visibility moment', () => {
  const w = freshIntro(memStorage());
  assert.ok(w.shouldPlay());
  w.playPreloader(3, 4);
  assert.equal(w.getPhase(), 'prelude');
  assert.equal(w.isActive(), true);
  for (let i = 0; i < 121; i++) w.update(1 / 60); // one frame past visibility
  assert.equal(w.getPhase(), 'reveal', 'visibility crosses into the reveal');
  assert.equal(w.consumeSubtitle(), true, 'the moment says its one line');
  w.update(1 / 60);
  assert.equal(w.consumeSubtitle(), false, 'and never says it again');
  assert.equal(FIRSTWATCHER_SUBTITLE.endsWith('very still.'), true);
});

check('curves flow through the instance getters', () => {
  const w = freshIntro(memStorage());
  w.playPreloader(-2, 5);
  assert.deepEqual(w.getSpawnPoint(), { x: -2, z: 5 });
  assert.equal(w.getHumScale(), 1, 'hum starts untouched');
  assert.equal(w.getSwellLevel(), 0, 'swell starts silent');
  // drive to just before visibility
  for (let i = 0; i < Math.round(PRELUDE_SECONDS * 60) - 1; i++) w.update(1 / 60);
  assert.ok(w.getHumScale() <= 1 && w.getHumScale() >= HUM_DUCK_FRACTION - 1e-9,
    'ducked but never below the floor');
  assert.ok(w.getFlickerMul() >= 0 && w.getFlickerMul() <= 1,
    'spawn-nearest fixture flickers inside [0,1]');
  assert.ok(w.getSwellLevel() > 0, 'swell has arrived by the visibility moment');
});

check('markShown retires the intro for this expedition', () => {
  const s = memStorage();
  const w = freshIntro(s);
  w.playPreloader();
  w.update(0.1);
  w.markShown();
  assert.equal(w.isActive(), false);
  assert.equal(w.shouldPlay(), false);
  assert.equal(w.getPhase(), 'done');
  w.markShown(); // idempotent
  assert.equal(readShownSlots(s).auto, true);
});

check('intro completes: done phase after the reveal hold', () => {
  const w = freshIntro(memStorage());
  w.playPreloader();
  const total = PRELUDE_SECONDS + REVEAL_HOLD_SECONDS;
  for (let t = 0; t < total; t += 1 / 60) w.update(1 / 60);
  assert.equal(w.getPhase(), 'done');
  assert.equal(w.isActive(), false);
  // still replayable on this expedition only if not marked -- shouldPlay
  // stays slot-scoped, so an unmarked slot remains true
  assert.equal(w.shouldPlay(), true);
});

console.log(failures === 0 ? '\nALL FIRSTWATCHER TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
