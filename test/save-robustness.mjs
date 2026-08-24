/* Save robustness: v1->v2 migration, corruption recovery, quota eviction, auto-backup.
   Runs standalone under Node >=22.18 (native TS type-stripping); no browser needed. */
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB shim (event-callback shaped, like the real API),
// with quota-failure injection and a __dbs handle for direct corruption tests.
// ---------------------------------------------------------------------------
class Req {
  constructor() { this.onsuccess = null; this.onerror = null; this.result = undefined; this.error = null; }
  _ok(result) { this.result = result; queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this })); }
  _fail(err) { this.error = err; queueMicrotask(() => this.onerror && this.onerror({ target: this })); }
}

function makeShim() {
  const dbs = new Map();
  const quotaFailKeys = new Map(); // storeKey -> remaining failures
  let currentTx = null;

  class Store {
    constructor(data) { this.data = data; }
    put(val, key) {
      const req = new Req();
      queueMicrotask(() => {
        const fails = quotaFailKeys.get(String(key)) ?? 0;
        if (fails > 0) {
          quotaFailKeys.set(String(key), fails - 1);
          const err = new DOMException('quota exceeded', 'QuotaExceededError');
          currentTx.error = err; // real IDB surfaces the request error on the tx
          req._fail(err);
          queueMicrotask(() => {
            if (currentTx.onerror) currentTx.onerror({ target: currentTx });
            if (currentTx.onabort) currentTx.onabort({ target: currentTx });
          });
          return;
        }
        this.data.set(String(key), structuredClone(val));
        req._ok(undefined);
        queueMicrotask(() => { if (currentTx.oncomplete) currentTx.oncomplete(); });
      });
      return req;
    }
    get(key) {
      const req = new Req();
      queueMicrotask(() => req._ok(this.data.has(String(key)) ? this.data.get(String(key)) : undefined));
      return req;
    }
    delete(key) {
      const req = new Req();
      queueMicrotask(() => {
        this.data.delete(String(key));
        req._ok(undefined);
        queueMicrotask(() => { if (currentTx.oncomplete) currentTx.oncomplete(); });
      });
      return req;
    }
    getAll() {
      const req = new Req();
      queueMicrotask(() => req._ok([...this.data.values()]));
      return req;
    }
    getAllKeys() {
      const req = new Req();
      queueMicrotask(() => req._ok([...this.data.keys()]));
      return req;
    }
  }

  class DB {
    constructor(stores) { this.stores = stores; }
    get objectStoreNames() { return { contains: (n) => this.stores.has(n) }; }
    /** Real IDB allows createObjectStore only inside the upgrade transaction; the
        shim enforces nothing beyond existence, which is all callers rely on. */
    createObjectStore(name) {
      if (!this.stores.has(name)) this.stores.set(name, new Map());
    }
    transaction(name /* , mode */) {
      const tx = {
        objectStore: () => new Store(this.stores.get(name)),
        error: null,
        oncomplete: null, onerror: null, onabort: null,
      };
      currentTx = tx;
      return tx;
    }
    close() { /* noop */ }
  }

  return {
    quotaFailKeys,
    __dbs: dbs,
    open(_name, _ver) {
      const req = new Req();
      req.onupgradeneeded = null;
      queueMicrotask(() => {
        if (!dbs.has('bmb')) {
          // Schema starts empty, like a fresh browser DB: src/save/db.ts's
          // onupgradeneeded creates 'slots', 'kv', and 'checkpoints' itself.
          const db = new DB(new Map());
          dbs.set('bmb', db);
          req.result = db; // real IDB sets result before upgrade callbacks


          if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
          req._ok(db);
        } else {
          req._ok(dbs.get('bmb'));
        }
      });
      return req;
    },
  };
}

globalThis.DOMException ??= class extends Error {};
const shim = makeShim();
globalThis.indexedDB = shim;

let warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };

const { SaveDB, migrateSlot } = await import('../src/save/db.ts');
const freshImport = () => import('../src/save/db.ts?' + Math.random());

let pass = 0;
const ok = (label) => { pass++; console.log('PASS', label); };
const slotsStore = () => shim.__dbs.get('bmb').stores.get('slots');
const resetShim = () => { shim.__dbs.clear(); shim.quotaFailKeys.clear(); };

// ---------------------------------------------------------------------------
// 1. migrateSlot: v1 -> v2 defaults
// ---------------------------------------------------------------------------
const base = { px: 1.5, pz: -2.5, yaw: 0, playtimeSec: 60 };
const v1 = { ...base, seed: 1234, savedAt: 100 };
const m = migrateSlot(v1);
assert.equal(m.version, 2);
assert.equal(m.stability, 1);
assert.equal(m.relocations, 0);
assert.deepEqual(m.landmarksSeen, []);
assert.deepEqual(m.pathEcho, []);
assert.equal(m.seed, 1234);
ok('migrateSlot fills v2 defaults on a v1 save');

const v2full = { ...v1, stability: 0.42, relocations: 7, landmarksSeen: ['CHAPEL'], pathEcho: [{ x: 1, z: 2 }] };
const m2 = migrateSlot(v2full);
assert.equal(m2.stability, 0.42);
assert.equal(m2.relocations, 7);
assert.deepEqual(m2.landmarksSeen, ['CHAPEL']);
ok('migrateSlot preserves existing v2 fields (backward compatible)');

assert.equal(migrateSlot('{not json'), null);
assert.equal(migrateSlot(null), null);
assert.equal(migrateSlot(42), null);
assert.equal(migrateSlot({ px: 1, pz: 2 }), null, 'missing seed');
assert.equal(migrateSlot({ seed: 1, pz: 2 }), null, 'missing px');
assert.equal(migrateSlot({ seed: 1, px: 2 }), null, 'missing pz');
ok('migrateSlot rejects corrupt / field-less payloads');

const m3 = migrateSlot(JSON.stringify(v1));
assert.ok(m3 && m3.seed === 1234 && m3.version === 2);
ok('legacy JSON-string saves still load through migration');

// ---------------------------------------------------------------------------
// 2. corruption recovery through SaveDB.loadGame
// ---------------------------------------------------------------------------
{
  const mod = await freshImport();
  await mod.SaveDB.saveGame({ ...v1 });
  assert.notEqual(await mod.SaveDB.loadGame(), null);

  // Poison 'auto' with unparseable garbage (e.g. an aborted legacy write).
  warns.length = 0;
  slotsStore().set('auto', '{broken json from a crashed write');
  assert.equal(await mod.SaveDB.loadGame(), null, 'unparseable entry -> null');
  assert.ok(warns.some((w) => w.includes('corrupt')), 'warning logged for corrupt entry');

  // Structured clone survived but required fields lost.
  warns.length = 0;
  slotsStore().set('auto', { pz: 5, yaw: 0, playtimeSec: 1, savedAt: 1, version: 2 });
  assert.equal(await mod.SaveDB.loadGame(), null, 'slot missing seed -> null');
  assert.ok(warns.some((w) => w.includes('seed/px/pz')), 'warning names missing required fields');
  ok('loadGame returns null + warning instead of throwing on corruption');
}

// ---------------------------------------------------------------------------
// 3. quota handling: evict oldest non-current slot, retry once
// ---------------------------------------------------------------------------
{
  resetShim();
  const mod = await freshImport();
  const old = { ...base, seed: 111, savedAt: 500 };
  await mod.SaveDB.saveGame(old);
  await mod.SaveDB.saveGame({ ...base, seed: 222, savedAt: 900 }); // old -> auto-backup
  assert.equal((await mod.SaveDB.loadBackup()).seed, 111);

  // Force one quota failure on the next 'auto' write: the oldest non-current
  // entry ('auto-backup', savedAt 500) must be evicted, then the write retried.
  shim.quotaFailKeys.set('auto', 1);
  warns.length = 0;
  await mod.SaveDB.saveGame({ ...base, seed: 333, savedAt: 1200 }); // must not throw
  assert.equal((await mod.SaveDB.loadGame()).seed, 333, 'new save persisted after eviction+retry');
  assert.equal(await mod.SaveDB.hasBackup(), false, 'oldest slot was the eviction victim');
  ok('quota-exceeded write evicts oldest non-current slot and retries once');
}
{
  resetShim();
  const mod = await freshImport();
  await mod.SaveDB.saveGame({ ...base, seed: 1, savedAt: 10 });
  shim.quotaFailKeys.set('auto', 99); // fail initial attempt AND retry
  await assert.rejects(() => mod.SaveDB.saveGame({ ...base, seed: 2, savedAt: 20 }));
  shim.quotaFailKeys.clear();
  ok('persistent quota errors propagate after the single retry');
}

// ---------------------------------------------------------------------------
// 4. backup slot: pre-overwrite snapshot + restore
// ---------------------------------------------------------------------------
{
  resetShim();
  const mod = await freshImport();
  assert.equal(await mod.SaveDB.loadBackup(), null, 'no backup before any save');
  await mod.SaveDB.saveGame({ ...base, seed: 777, savedAt: 1 });
  assert.equal(await mod.SaveDB.loadBackup(), null, 'first save has nothing to back up');
  await mod.SaveDB.saveGame({ ...base, seed: 888, savedAt: 2 });
  const bak = await mod.SaveDB.loadBackup();
  assert.equal(bak.seed, 777, 'backup holds the pre-overwrite snapshot');
  assert.ok(bak.version === 2 && Array.isArray(bak.pathEcho), 'backup passes through migration');
  assert.ok(await mod.SaveDB.hasBackup());
  const restored = await mod.SaveDB.restoreBackup();
  assert.equal(restored.seed, 777);
  assert.equal((await mod.SaveDB.loadGame()).seed, 777, "auto restored from 'auto-backup'");
  ok("pre-overwrite 'auto' copied to 'auto-backup'; restoreBackup recovers it");
}

console.warn = origWarn;
console.log('\nALL ' + pass + ' SAVE-ROBUSTNESS CHECKS PASSED');


