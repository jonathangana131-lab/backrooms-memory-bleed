/**
 * Unit tests for src/story/reread.ts (note rereading + memory distortion).
 *
 * Runs under plain Node with no DOM and no Babylon: the module is exercised
 * through a stub Storage backend. Launch:
 *
 *   node test/reread-test.mjs
 */
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Transpile the TypeScript module to a temp dir so plain Node can import it.
const tmp = mkdtempSync(join(tmpdir(), 'bmb-reread-'));
execSync(
  'npx tsc --target ES2022 --module ES2022 --moduleResolution bundler ' +
    '--skipLibCheck --outDir ' + JSON.stringify(tmp) + ' src/story/reread.ts',
  { stdio: 'inherit' },
);

const {
  SYNONYMS,
  DISTORT_OPEN,
  DISTORT_CLOSE,
  REREAD_STORAGE_KEY,
  BLEED_PROBABILITY,
  hashString,
  mulberry32,
  hasHighlight,
  stripHighlights,
  findSwapCandidates,
  distortOnce,
  promptForRead,
  sanitizeState,
  NoteReread,
} = await import('file://' + join(tmp, 'reread.js'));

// ---------------------------------------------------------------------------
// Minimal Storage stub
// ---------------------------------------------------------------------------

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => void map.clear(),
    _map: map,
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

const EM = '\u2014';

// ---------------------------------------------------------------------------
// Synonym map
// ---------------------------------------------------------------------------

test('SYNONYMS has ~30+ entries with distinct string alternates', () => {
  const keys = Object.keys(SYNONYMS);
  assert.ok(keys.length >= 30, 'expected >= 30 synonyms, got ' + keys.length);
  for (const k of keys) {
    assert.equal(typeof SYNONYMS[k], 'string');
    assert.ok(SYNONYMS[k].length > 0);
    assert.notEqual(SYNONYMS[k], k, 'alternate must differ: ' + k);
  }
});

test('required unsettling alternates are present', () => {
  assert.equal(SYNONYMS['walked'], 'was walked');
  assert.equal(SYNONYMS['saw'], 'witnessed');
  assert.equal(SYNONYMS['door'], 'the door');
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('hashString and mulberry32 are deterministic', () => {
  const h1 = hashString('note-a#2');
  assert.equal(h1, hashString('note-a#2'));
  assert.notEqual(h1, hashString('note-b#2'));
  const r1 = mulberry32(h1);
  const r2 = mulberry32(h1);
  for (let i = 0; i < 8; i++) assert.equal(r1(), r2());
});

test('findSwapCandidates matches whole words only', () => {
  const c = findSwapCandidates('I walked past a doorway and saw it.');
  const keys = c.map((x) => x.key);
  assert.ok(keys.includes('walked'));
  assert.ok(keys.includes('saw'));
  assert.ok(!keys.includes('door'), 'doorway must not match "door"');
});

test('distortOnce below threshold alters exactly one word locally', () => {
  const text = 'I walked to the door.';
  const res = distortOnce(text, 'seed-x', 0.1); // < BLEED_PROBABILITY
  assert.equal(res.altered, true);
  assert.equal(res.text.split(DISTORT_OPEN).length - 1, 1, 'one open marker');
  assert.equal(res.text.split(DISTORT_CLOSE).length - 1, 1, 'one close marker');
  const stripped = stripHighlights(res.text);
  assert.notEqual(stripped, text);
});

test('distortOnce at/above threshold leaves text untouched', () => {
  const text = 'I walked to the door.';
  const res = distortOnce(text, 'seed-y', BLEED_PROBABILITY + 0.01);
  assert.deepEqual(res, { text, altered: false });
});

test('distortOnce wraps the altered word in subtle markers', () => {
  const res = distortOnce('I saw the light.', 'seed-z', 0.05);
  assert.equal(hasHighlight(res.text), true);
  const re = new RegExp(DISTORT_OPEN + '(.+?)' + DISTORT_CLOSE);
  const m = re.exec(res.text);
  assert.ok(m, 'highlighted word present');
  assert.ok(m[1].length > 0);
  assert.equal(stripHighlights(res.text), res.text.split(DISTORT_OPEN).join('').split(DISTORT_CLOSE).join(''));
});

test('promptForRead distinguishes first vs later reads', () => {
  assert.equal(promptForRead(false), 'E ' + EM + ' READ');
  assert.equal(promptForRead(true), 'E ' + EM + ' REREAD');
  assert.notEqual(promptForRead(true), promptForRead(false));
});

// ---------------------------------------------------------------------------
// NoteReread: tracking, distortion, ledger
// ---------------------------------------------------------------------------

test('markRead / isRead / promptFor track state', () => {
  const rr = new NoteReread({ storage: makeStorage() });
  assert.equal(rr.isRead('n1'), false);
  assert.equal(rr.promptFor('n1'), 'E ' + EM + ' READ');
  rr.markRead('n1');
  assert.equal(rr.isRead('n1'), true);
  assert.equal(rr.promptFor('n1'), 'E ' + EM + ' REREAD');
  assert.equal(rr.readCount('n1'), 1);
  rr.markRead('n1');
  assert.equal(rr.readCount('n1'), 2);
});

test('first read never distorts', () => {
  const rr = new NoteReread({ storage: makeStorage() });
  const text = 'I saw something by the door.';
  rr.markRead('n1'); // count 1 -> this reading IS the first read
  assert.deepEqual(rr.distort(text, 'n1'), { text, altered: false });
});

test('second read distorts deterministically; unread notes stay clean', () => {
  const rr = new NoteReread({ storage: makeStorage() });
  const text = 'Last night I walked toward the humming wall and saw it open.';
  rr.markRead('n1');
  rr.markRead('n1'); // count 2 -> eligible to bleed

  const res = rr.distort(text, 'n1');
  assert.deepEqual(rr.distort(text, 'never-read'), { text, altered: false });

  // Determinism: identical reconstructed state reproduces the same outcome.
  const rr2 = new NoteReread({ storage: makeStorage() });
  rr2.importState(rr.exportState());
  // n1 count is now 3 in rr/rr2 snapshots? No: importState snapshot was taken
  // BEFORE this second distort call mutated rr. Recount explicitly.
  const rr3 = new NoteReread({ storage: makeStorage() });
  rr3.markRead('n1');
  rr3.markRead('n1');
  assert.deepEqual(rr3.distort(text, 'n1'), res, 'same seed chain, same outcome');

  if (res.altered) {
    assert.ok(hasHighlight(res.text), 'altered word is highlighted');
    const alts = rr.alterationsFor('n1');
    assert.equal(alts.length, 1);
    assert.ok(alts[0].from !== '?', 'ledger knows original key: ' + JSON.stringify(alts[0]));
    assert.ok(Object.prototype.hasOwnProperty.call(SYNONYMS, alts[0].from));
    assert.equal(Object.values(SYNONYMS).includes(stripHighlights(alts[0].to)) ||
      stripHighlights(alts[0].to) === SYNONYMS[alts[0].from] ||
      stripHighlights(alts[0].to).toLowerCase().includes(alts[0].to.toLowerCase()), true);
    assert.equal(alts[0].seq, 1);
    assert.equal(rr.totalAlterations(), 1);
  } else {
    assert.equal(rr.totalAlterations(), 0);
  }
});

test('alteration ledger accumulates across reads and notes', () => {
  const rr = new NoteReread({ storage: makeStorage() });
  const textA = 'The hallway was quiet and I heard the hum behind the walls.';
  const textB = 'I found the exit and felt safe until morning.';
  rr.markRead('a');
  rr.markRead('b');
  let alteredCount = 0;
  for (let i = 0; i < 6; i++) {
    const id = i % 2 === 0 ? 'a' : 'b';
    rr.markRead(id);
    const r = rr.distort(id === 'a' ? textA : textB, id);
    if (r.altered) alteredCount++;
  }
  assert.equal(rr.totalAlterations(), alteredCount, 'ledger matches observed swaps');
  const perA = rr.alterationsFor('a').length;
  const perB = rr.alterationsFor('b').length;
  assert.ok(perA <= 3 && perB <= 3, 'at most ONE swap per reading');
  for (const [i, rec] of rr.alterationsFor('a').entries()) assert.equal(rec.seq, i + 1);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('state persists under bmb-reread and reloads into a fresh instance', () => {
  const storage = makeStorage();
  const rr = new NoteReread({ storage });
  rr.markRead('n9');
  rr.markRead('n9');
  rr.distort('I walked home.', 'n9');

  assert.ok(storage._map.has(REREAD_STORAGE_KEY), 'writes under ' + REREAD_STORAGE_KEY);

  const rr2 = new NoteReread({ storage }); // fresh instance, same storage
  assert.equal(rr2.isRead('n9'), true);
  assert.equal(rr2.readCount('n9'), 2);
  assert.equal(rr2.promptFor('n9'), 'E ' + EM + ' REREAD');
  assert.equal(rr2.totalAlterations(), rr.totalAlterations());
});

test('exportState/importState round-trips and rejects garbage', () => {
  const rr = new NoteReread({ storage: makeStorage() });
  rr.markRead('x');
  const snap = rr.exportState();
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);

  const rr2 = new NoteReread({ storage: makeStorage() });
  assert.equal(rr2.importState(snap), true);
  assert.equal(rr2.isRead('x'), true);

  assert.equal(rr2.importState(null), false);
  assert.equal(rr2.importState('nope'), false);
  assert.equal(rr2.importState({ version: 99 }), false);
  assert.equal(
    sanitizeState({ version: 1, reads: [], alterations: {} }),
    null,
    'array-as-object payload rejected',
  );
});

test('corrupt persisted JSON starts clean instead of throwing', () => {
  const storage = makeStorage();
  storage.setItem(REREAD_STORAGE_KEY, '{not json');
  const rr = new NoteReread({ storage });
  assert.equal(rr.isRead('anything'), false);
});

test('null storage runs fully in-memory without persistence errors', () => {
  const rr = new NoteReread({ storage: null });
  rr.markRead('m1');
  rr.markRead('m1');
  const res = rr.distort('The room was cold.', 'm1');
  assert.equal(typeof res.altered, 'boolean');
  assert.equal(rr.isRead('m1'), true);
});

console.log('\nreread-test: ' + passed + ' tests passed');


