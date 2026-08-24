/**
 * Functional verification of the F47 daily rite (src/ui/dailyrite.ts):
 * shared UTC-date seed derivation (incl. leap day), checklist persistence
 * round-trip through injected { get, set } storage, UTC-midnight rollover
 * reset, idempotent goal completion, and the stub-DOM overlay layer.
 *
 * Standalone in Node; the TS module is bundled with esbuild so its
 * '../core/rng' import resolves.
 *
 *   node test/dailyrite-test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const pnpmDir = process.cwd() + '/node_modules/.pnpm';
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
    if (!entry) throw new Error('esbuild not found in node_modules');
    return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
  }
}

let passed = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ' :: ' + (e instanceof Error ? e.message : String(e)));
  }
}

const esbuild = loadEsbuild();
const SRC = process.cwd() + '/src/ui/dailyrite.ts';
readFileSync(SRC, 'utf8'); // fail fast if the source moved
const BUILT = process.cwd() + '/test/.dailyrite-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

const {
  DAILY_RITE_SALT,
  DAILY_RITE_KEY_PREFIX,
  DAILY_GOALS,
  utcDateKey,
  dailySeed,
  DailyRite,
} = await import('./.dailyrite-build.mjs');

/* ------------------------------------------------------------------ */
/* Shared daily seed                                                   */
/* ------------------------------------------------------------------ */

check('same date string derives the same seed everywhere', () => {
  for (const d of ['2024-02-28', '2024-02-29', '1999-12-31', '2000-01-01', '2026-08-23']) {
    assert.equal(dailySeed(d), dailySeed(d), 'unstable for ' + d);
  }
});

check('seed is hash(dateKey) XOR fixed salt, unsigned 32-bit', () => {
  // Re-derive independently: seedFromString is FNV-1a over char codes.
  let h = 2166136261;
  for (const c of '2024-02-29') {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const expected = (h >>> 0) ^ DAILY_RITE_SALT;
  assert.equal(dailySeed('2024-02-29'), expected >>> 0);
  assert.ok(Number.isInteger(DAILY_RITE_SALT) && DAILY_RITE_SALT > 0);
});

check('leap day differs from adjacent days', () => {
  const s28 = dailySeed('2024-02-28');
  const s29 = dailySeed('2024-02-29');
  const sMar = dailySeed('2024-03-01');
  assert.notEqual(s28, s29);
  assert.notEqual(s29, sMar);
  assert.notEqual(s28, sMar);
});

check('utcDateKey formats YYYY-MM-DD from the UTC fields', () => {
  assert.equal(utcDateKey(new Date(Date.UTC(2026, 7, 23, 23, 59))), '2026-08-23');
  assert.equal(utcDateKey(new Date(Date.UTC(2024, 1, 29))), '2024-02-29');
  assert.equal(utcDateKey(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
});

check('utc rollover boundary: local 20:00 EDT is still the prior UTC day', () => {
  // 2026-08-23T20:00-04:00 == 2026-08-24T00:00Z -> new UTC key already.
  const t = new Date(Date.UTC(2026, 7, 24, 0, 0) - 4 * 3600 * 1000);
  assert.equal(utcDateKey(t), '2026-08-23');
});

/* ------------------------------------------------------------------ */
/* Storage helpers                                                     */
/* ------------------------------------------------------------------ */

class FakeStorage {
  constructor() { this.map = new Map(); }
  get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  set(k, v) { this.map.set(k, String(v)); }
}

/** Stub document/container pair matching the sibling UI test idiom. */
function stubDoc() {
  const created = [];
  const doc = {
    createElement(tag) {
      const el = {
        tag,
        className: '',
        textContent: '',
        removed: false,
        styleProps: {},
        children: [],
        style: {
          setProperty(name, value) { el.styleProps[name] = String(value); },
        },
        appendChild(child) { el.children.push(child); return child; },
        remove() { el.removed = true; },
      };
      created.push(el);
      return el;
    },
    head: { appendChild(child) { return child; } },
  };
  const container = doc.createElement('div');
  return { doc, created, container };
}

const DAY1 = '2026-08-23';

function makeRite(storage, opts = {}) {
  return new DailyRite({ storage, now: () => new Date(Date.UTC(2026, 7, 23)), ...opts });
}

/* ------------------------------------------------------------------ */
/* Checklist model                                                     */
/* ------------------------------------------------------------------ */

check('three canonical rite goals exist with targets', () => {
  assert.equal(DAILY_GOALS.length, 3);
  const ids = DAILY_GOALS.map((g) => g.id).sort().join(',');
  assert.equal(ids, 'blackout,landmark,notes');
  const notes = DAILY_GOALS.find((g) => g.id === 'notes');
  assert.equal(notes.target, 3);
});

check('fresh rite starts blank with today\'s seed', () => {
  const rite = makeRite(new FakeStorage());
  assert.equal(rite.dateKey, DAY1);
  assert.equal(rite.seed, dailySeed(DAY1));
  assert.equal(rite.complete, false);
  for (const g of DAILY_GOALS) {
    assert.equal(rite.progress[g.id].count, 0);
    assert.equal(rite.progress[g.id].done, false);
  }
});

check('goal completion is idempotent past the target', () => {
  const rite = makeRite(new FakeStorage());
  assert.equal(rite.report('notes'), false, 'note 1 of 3');
  assert.equal(rite.report('notes'), false, 'note 2 of 3');
  assert.equal(rite.report('notes'), true, 'note 3 newly completes');
  for (let i = 0; i < 10; i++) {
    assert.equal(rite.report('notes', 5), false, 'repeat reports never re-fire');
  }
  assert.equal(rite.progress.notes.done, true);
  assert.equal(rite.progress.notes.count, 3, 'count stays at target');
});

check('unknown goal ids and junk amounts are rejected', () => {
  const rite = makeRite(new FakeStorage());
  assert.equal(rite.report('nope'), false);
  assert.equal(rite.report('notes', 0), false);
  assert.equal(rite.report('notes', -2), false);
});

check('complete requires every goal latched', () => {
  const rite = makeRite(new FakeStorage());
  for (let i = 0; i < 3; i++) rite.report('notes');
  rite.report('landmark');
  assert.equal(rite.complete, false);
  rite.report('blackout');
  assert.equal(rite.complete, true);
});

/* ------------------------------------------------------------------ */
/* Persistence round-trip                                              */
/* ------------------------------------------------------------------ */

check('progress round-trips through injected storage', () => {
  const store = new FakeStorage();
  const first = makeRite(store);
  first.report('notes');
  first.report('notes');
  first.report('landmark');

  // Same-day reopen sees the persisted partial progress.
  const second = makeRite(store);
  assert.equal(second.progress.notes.count, 2);
  assert.equal(second.progress.landmark.done, true);
  assert.equal(second.report('notes'), true, 'third note lands on the restored count');

  const third = makeRite(store);
  assert.equal(third.progress.notes.done, true);
  assert.equal(third.progress.blackout.count, 0);
});

check('state is keyed by date in storage', () => {
  const store = new FakeStorage();
  const rite = makeRite(store);
  rite.report('notes');
  const raw = store.get(DAILY_RITE_KEY_PREFIX + DAY1);
  assert.ok(typeof raw === 'string' && raw.length > 0, 'slot exists under prefix+date');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.dateKey, DAY1);
  assert.equal(parsed.seed, dailySeed(DAY1));
});

/* ------------------------------------------------------------------ */
/* UTC-midnight rollover                                               */
/* ------------------------------------------------------------------ */

check('rollover resets the checklist and swaps the seed', () => {
  const store = new FakeStorage();
  const clock = { d: new Date(Date.UTC(2026, 7, 23)) };
  const rite = makeRite(store, { now: () => clock.d });
  for (let i = 0; i < 3; i++) rite.report('notes');
  rite.report('landmark');
  rite.report('blackout');
  assert.equal(rite.complete, true);
  const day1Seed = rite.seed;

  clock.d = new Date(Date.UTC(2026, 7, 24, 0, 0, 1)); // one second past midnight
  assert.equal(rite.tick(), true, 'tick rolls over after midnight');
  assert.equal(rite.dateKey, '2026-08-24');
  assert.equal(rite.seed, dailySeed('2026-08-24'));
  assert.notEqual(rite.seed, day1Seed);
  assert.equal(rite.complete, false);
  for (const g of DAILY_GOALS) {
    assert.equal(rite.progress[g.id].done, false);
    assert.equal(rite.progress[g.id].count, 0);
  }
});

check('tick before midnight is a no-op', () => {
  const rite = makeRite(new FakeStorage());
  rite.report('notes');
  assert.equal(rite.tick(), false);
  assert.equal(rite.progress.notes.count, 1);
});

check('rollover preserves the previous day\'s stored slot', () => {
  const store = new FakeStorage();
  const clock = { d: new Date(Date.UTC(2026, 7, 23)) };
  const rite2 = new DailyRite({ storage: store, now: () => clock.d });
  for (let i = 0; i < 3; i++) rite2.report('notes');
  clock.d = new Date(Date.UTC(2026, 7, 24));
  rite2.tick();
  const kept = JSON.parse(store.get(DAILY_RITE_KEY_PREFIX + DAY1));
  assert.equal(kept.goals.notes.done, true, 'day-1 history intact');
  assert.equal(JSON.parse(store.get(DAILY_RITE_KEY_PREFIX + '2026-08-24')).goals.notes.done, false);
});

check('corrupt or foreign-date slots fall back to blank state', () => {
  const store = new FakeStorage();
  store.set(DAILY_RITE_KEY_PREFIX + DAY1, '{broken json');
  let rite = makeRite(store);
  assert.equal(rite.progress.notes.count, 0, 'corrupt JSON ignored');

  store.set(DAILY_RITE_KEY_PREFIX + DAY1, JSON.stringify({
    dateKey: '1999-01-01', seed: 7, goals: { notes: { count: 99, done: true } },
  }));
  rite = makeRite(store);
  assert.equal(rite.dateKey, DAY1, 'foreign dateKey slot ignored');
  assert.equal(rite.progress.notes.done, false);
  assert.equal(rite.seed, dailySeed(DAY1), 'seed re-derived, not trusted');
});

/* ------------------------------------------------------------------ */
/* Overlay DOM                                                         */
/* ------------------------------------------------------------------ */

check('overlay mounts stylesheet + hidden root and renders rows', () => {
  const { doc, created, container } = stubDoc();
  const rite = makeRite(new FakeStorage(), { document: doc, container });
  const styleEl = created.find((c) => c.className === 'bmb-ritestyle');
  const rootEl = created.find((c) => c.className === 'bmb-dailyrite');
  assert.ok(styleEl && rootEl, 'style + root created');
  assert.match(String(styleEl.textContent), /[.]bmb-dailyrite [{]/);
  assert.equal(rootEl.styleProps.display, 'none', 'born hidden');

  rite.show();
  assert.equal(rootEl.styleProps.display, 'block');
  rite.hide();
  assert.equal(rootEl.styleProps.display, 'none');

  const rows = rootEl.children.filter((c) => c.className === 'bmb-dailyrite-row');
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.textContent.includes('[ ] READ 3 NOTES 0/3')), rows.map((r) => r.textContent).join('|'));
  assert.ok(rows.some((r) => r.textContent.includes('[ ] VISIT A LANDMARK')));
  assert.ok(rows.some((r) => r.textContent.includes('[ ] SURVIVE A BLACKOUT')));
});

check('rows re-render on completion and on rollover', () => {
  const { doc, created, container } = stubDoc();
  const store = new FakeStorage();
  const clock = { d: new Date(Date.UTC(2026, 7, 23)) };
  const rite = new DailyRite({ storage: store, document: doc, container, now: () => clock.d });
  const rootEl = created.find((c) => c.className === 'bmb-dailyrite');
  // Stub remove() does not detach from parent.children; live rows are the
  // non-removed ones.
  const liveRows = () => rootEl.children.filter((c) => c.className === 'bmb-dailyrite-row' && !c.removed);
  for (let i = 0; i < 3; i++) rite.report('notes');
  let rows = liveRows();
  assert.equal(rows.length, 3, 'stale rows retire on rerender');
  const notesRow = rows.find((r) => r.textContent.includes('READ 3 NOTES'));
  assert.match(notesRow.textContent, /\[x\] READ 3 NOTES 3\/3/);
  assert.equal(notesRow.styleProps.color, 'rgba(120, 220, 150, 1)', 'done rows recolor');

  clock.d = new Date(Date.UTC(2026, 7, 24));
  rite.tick();
  rows = liveRows();
  const resetRow = rows.find((r) => r.textContent.includes('READ 3 NOTES'));
  assert.match(resetRow.textContent, /\[ \] READ 3 NOTES 0\/3/);
});

check('headless mode runs model-only without a document', () => {
  const rite = makeRite(new FakeStorage());
  assert.equal(rite.hasOverlay, false);
  assert.doesNotThrow(() => { rite.show(); rite.hide(); rite.disposeOverlay(); });
  assert.equal(rite.report('landmark'), true);
});

console.log('passed:', passed);
rmSync(BUILT, { force: true });
process.exit(failures === 0 ? 0 : 1);
