/**
 * Journal feed tests - pure Node, no renderer.
 *
 * Covers src/story/journal-feed.ts: FNV-1a hashing, feed-title derivation,
 * stable note ids, arc cluster ids, and JournalFeed.feedFromLayout
 * (clustering, cross-layout dedup, district passthrough, junk layouts).
 *
 * Run: node test/journal-feed-test.mjs  (prints JOURNALFEED ALL PASS, exits 0)
 */
import { register } from 'node:module';
import assert from 'node:assert/strict';

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

const {
  fnv1a, deriveFeedTitle, noteIdFor, arcClusterId,
  JournalFeed, CLUSTER_RADIUS,
} = await import('../src/story/journal-feed.ts');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  ok - ' + name);
  else { failures++; console.error('FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}

// --- fnv1a basics ---
{
  const h1 = fnv1a('hello');
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

  console.log('PASS note id stability and coordinate sensitivity');
}

// --- arc cluster ids ---
{
  check('arcClusterId stable for same anchor', arcClusterId(3, -4) === arcClusterId(3, -4));
  check('arcClusterId distinct across anchors', arcClusterId(3, -4) !== arcClusterId(3, -5));
  check('arcClusterId prefixed arc-hex', /^arc-[0-9a-f]{8}$/.test(arcClusterId(0, 0)));
}

// --- JournalFeed.feedFromLayout ---
{
  // Memory recorder journal stub: records addNote calls, accepts everything.
  const makeJournal = () => {
    const calls = [];
    return {
      calls,
      addNote(noteId, title, text, clusterId, district) {
        calls.push({ noteId, title, text, clusterId, district });
        return true;
      },
    };
  };

  // Clustering: notes within CLUSTER_RADIUS of the run's anchor share an id.
  {
    const j = makeJournal();
    const feed = new JournalFeed(j);
    const fed = feed.feedFromLayout({
      cx: 0, cz: 0,
      notes: [
        { x: 0, z: 0, text: 'First note. Anchors the cluster.' },
        { x: CLUSTER_RADIUS - 1, z: 0, text: 'Second note. Near the first.' },
      ],
    }, 2);
    check('both clustered notes accepted', fed === 2);
    check('clustered notes share one cluster id',
      j.calls[0].clusterId === j.calls[1].clusterId && j.calls[0].clusterId !== 'frag');
    check('district passed through as string',
      j.calls.every((c) => c.district === '2'));
    check('titles derived per note',
      j.calls[0].title === 'First note' && j.calls[1].title === 'Second note');
  }

  // Isolated notes land under 'frag'.
  {
    const j = makeJournal();
    const feed = new JournalFeed(j);
    feed.feedFromLayout({
      cx: 0, cz: 0,
      notes: [
        { x: 0, z: 0, text: 'Lone note far from anything.' },
        { x: 1000, z: 1000, text: 'Another lone note even farther.' },
      ],
    }, 0);
    check('isolated notes use frag cluster id',
      j.calls.every((c) => c.clusterId === 'frag'));
  }

  // Cross-layout dedup: revisiting a chunk never double-files entries.
  {
    const j = makeJournal();
    const feed = new JournalFeed(j);
    const layout = {
      cx: 5, cz: 5,
      notes: [{ x: 1, z: 1, text: 'Eternal layout note. Same every visit.' }],
    };
    const first = feed.feedFromLayout(layout, 1);
    const second = feed.feedFromLayout(layout, 1);
    check('first visit files the note', first === 1);
    check('revisit files nothing new', second === 0 && j.calls.length === 1);
  }

  // Junk handling: blank text skipped, non-array/missing notes -> 0.
  {
    const j = makeJournal();
    const feed = new JournalFeed(j);
    check('layout without notes array returns 0',
      feed.feedFromLayout({ cx: 0, cz: 0 }, 1) === 0);
    check('null layout returns 0', feed.feedFromLayout(null, 1) === 0);
    const fed = feed.feedFromLayout({
      cx: 0, cz: 0,
      notes: [{ x: 0, z: 0, text: '   ' }, { x: 0, z: 0, text: 'Real note here.' }],
    }, 1);
    check('blank-text note skipped, real note filed', fed === 1 && j.calls.length === 1);
  }
}

if (failures > 0) {
  console.error('JOURNALFEED FAILURES: ' + failures);
  process.exit(1);
}
console.log('JOURNALFEED ALL PASS');
