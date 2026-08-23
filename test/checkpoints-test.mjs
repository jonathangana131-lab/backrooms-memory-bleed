/**
 * Manual checkpoint system tests -- pure Node against a fake IndexedDB.
 *
 * src/story/checkpoints.ts (+ the real src/save/db.ts migration) are
 * transpiled on the fly into a temp dir; globalThis.indexedDB is replaced
 * with an in-memory stand-in whose backing Maps rawStore() exposes.
 * Run: node test/checkpoints-test.mjs
 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-checkpoints-'));
fsMod.mkdirSync(path.join(tmp, 'src/story'), { recursive: true });
fsMod.mkdirSync(path.join(tmp, 'src/save'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    // Node ESM needs explicit extensions on the relative cross-file import.
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/save/db.ts', 'src/save/db.mjs');
emit('src/story/checkpoints.ts', 'src/story/checkpoints.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---- in-memory IndexedDB ----------------------------------------------------
let checkpointMap = new Map();
let currentDB = null;

class FakeRequest {
  constructor(exec) {
    this.result = undefined; this.error = null;
    this.onsuccess = null; this.onerror = null;
    queueMicrotask(() => {
      try { this.result = exec(); if (this.onsuccess) this.onsuccess({ target: this }); }
      catch (e) { this.error = e; if (this.onerror) this.onerror({ target: this }); }
    });
  }
}

class FakeTx {
  constructor() { this.oncomplete = null; this.onerror = null; this.onabort = null; }
  // requests run as microtasks; settle the tx once they have drained
  _settle() { queueMicrotask(() => queueMicrotask(() => { if (this.oncomplete) this.oncomplete(); })); }
  objectStore(name) {
    const map = currentDB.stores.get(name);
    if (!map) throw new Error('no store ' + name);
    const tx = this;
    return {
      get: (k) => { const r = new FakeRequest(() => map.get(k)); tx._settle(); return r; },
      getAll: () => { const r = new FakeRequest(() => [...map.values()]); tx._settle(); return r; },
      getAllKeys: () => { const r = new FakeRequest(() => [...map.keys()]); tx._settle(); return r; },
      put: (v, k) => { const r = new FakeRequest(() => map.set(k, structuredClone(v))); tx._settle(); return r; },
      delete: (k) => { const r = new FakeRequest(() => map.delete(k)); tx._settle(); return r; },
    };
  }
}

class FakeDB {
  constructor(version) { this.version = version; this.stores = new Map(); }
  get objectStoreNames() {
    const stores = this.stores;
    return { contains: (n) => stores.has(n) };
  }
  createObjectStore(n) { this.stores.set(n, new Map()); }
  transaction(_name, _mode) { return new FakeTx(); }
  close() {}
}

const fakeIndexedDB = {
  open(name, version) {
    return new FakeRequest(() => {
      let db = currentDB;
      if (!db) { db = new FakeDB(1); currentDB = db; }
      if (version !== undefined && version > db.version) {
        db.version = version; // upgrade path: caller adds stores in onupgradeneeded
      }
      return db;
    });
  },
};

/** Direct access to the backing checkpoints store for test setup/teardown. */
function rawStore() {
  return {
    get keys() { return [...checkpointMap.keys()]; },
    map: checkpointMap,
  };
}

beforeEach(() => {
  checkpointMap = new Map();
  currentDB = new FakeDB(1);
  currentDB.createObjectStore('slots');
  currentDB.createObjectStore('kv');
  currentDB.createObjectStore('checkpoints');
  checkpointMap = currentDB.stores.get('checkpoints');
  globalThis.indexedDB = fakeIndexedDB;
});

const { CheckpointManager, validateName, validateRecord, MAX_CHECKPOINTS, QUICK_SLOTS } =
  await import(pathToFileURL(path.join(tmp, 'src/story/checkpoints.mjs')).href);

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
  // seed the store directly with controlled timestamps
  rawStore().map.set('old', { name: 'old', savedAt: 1000, slot: mkSlot({ discoveries: 1 }) });
  rawStore().map.set('new', { name: 'new', savedAt: 9000, slot: mkSlot({ discoveries: 7 }) });
  rawStore().map.set('mid', { name: 'mid', savedAt: 4000, slot: mkSlot({ discoveries: 4 }) });
  const list = await m.listCheckpoints();
  assert.deepEqual(list.map((c) => c.name), ['new', 'mid', 'old']);
  assert.deepEqual(list.map((c) => c.discoveries), [7, 4, 1]);
});
await test('overwriting a name replaces instead of duplicating', async () => {
  const m = new CheckpointManager();
  await m.createCheckpoint('dup', mkSlot({ seed: 1 }));
  await m.createCheckpoint('dup', mkSlot({ seed: 2 }));
  assert.equal(rawStore().keys.length, 1);
  const loaded = await m.loadCheckpoint('dup');
  assert.equal(loaded.seed, 2);
});
await test('deleteCheckpoint reports whether something was removed', async () => {
  const m = new CheckpointManager();
  await m.createCheckpoint('Gone Soon', mkSlot());
  assert.equal(await m.deleteCheckpoint('Gone Soon'), true);
  assert.equal(await m.deleteCheckpoint('Gone Soon'), false);
  assert.equal(await m.loadCheckpoint('Gone Soon'), null);
});

// 3. corruption handling ------------------------------------------------------
await test('corrupt records are skipped, pruned, never loaded', async () => {
  const m = new CheckpointManager();
  rawStore().map.set('ok', { name: 'ok', savedAt: 5000, slot: mkSlot() });
  rawStore().map.set('garbage', 'not even json');
  rawStore().map.set('nosave', { name: 'nosave', slot: mkSlot() }); // no savedAt
  rawStore().map.set('badslot', { name: 'badslot', savedAt: 6000, slot: { px: 1 } }); // fails migration
  assert.equal(await m.loadCheckpoint('garbage'), null);
  assert.equal(await m.loadCheckpoint('badslot'), null);
  const list = await m.listCheckpoints();
  assert.deepEqual(list.map((c) => c.name), ['ok']);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!rawStore().keys.includes('garbage'), 'pruned from the store');
});

await test('validateRecord accepts legacy JSON strings', async () => {
  const rec = { name: 'legacy', savedAt: 1234, slot: mkSlot() };
  const ok = validateRecord(JSON.stringify(rec));
  assert.ok(ok);
  assert.equal(ok.name, 'legacy');
  assert.equal(ok.slot.seed, 1234);
  assert.equal(validateRecord('['), null);
  assert.equal(validateRecord(null), null);
});

// 4. cap + eviction -------------------------------------------------------------
await test('oldest checkpoints are evicted past MAX_CHECKPOINTS', async () => {
  const m = new CheckpointManager();
  for (let i = 0; i < MAX_CHECKPOINTS; i++) {
    rawStore().map.set('cp-' + i, { name: 'cp-' + i, savedAt: 1000 + i, slot: mkSlot() });
  }
  // the just-written checkpoint must survive regardless of age ordering
  assert.equal(await m.createCheckpoint('fresh', mkSlot()), true);
  const keys = rawStore().keys.sort();
  assert.equal(keys.length, MAX_CHECKPOINTS);
  assert.ok(keys.includes('fresh'));
  assert.ok(!keys.includes('cp-0'), 'oldest evicted first');
  const list = await m.listCheckpoints();
  assert.equal(list.length, MAX_CHECKPOINTS);
});

// 5. quick slots ------------------------------------------------------------------
await test('quick saves cycle quick-1..3 and quickLoad takes the newest', async () => {
  const m = new CheckpointManager();
  assert.deepEqual([...QUICK_SLOTS], ['quick-1', 'quick-2', 'quick-3']);
  await m.quickSave(mkSlot({ seed: 11 }));
  await new Promise((r) => setTimeout(r, 5));
  await m.quickSave(mkSlot({ seed: 22 }));
  await new Promise((r) => setTimeout(r, 5));
  await m.quickSave(mkSlot({ seed: 33 }));
  assert.deepEqual(rawStore().keys.sort(), ['quick-1', 'quick-2', 'quick-3']);
  // round-robin wraps onto quick-1 again
  await m.quickSave(mkSlot({ seed: 44 }));
  assert.equal(rawStore().keys.length, 3, 'still three quick slots');
  const loaded = await m.quickLoad();
  assert.equal(loaded.seed, 44, 'most recent quick save wins');
  assert.equal(await m.lastQuickSlot(), 'quick-1');

  // manual listing ignores quick slots entirely
  const list = await m.listCheckpoints();
  assert.equal(list.length, 0);
});
