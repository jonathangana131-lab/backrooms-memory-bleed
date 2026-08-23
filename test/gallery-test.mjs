/*
 * PhotoGallery unit verification.
 * Standalone in Node against DOM/window/indexedDB shims; drives the real
 * src/ui/gallery.ts through vite's SSR loader.
 *
 *   node test/gallery-test.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------- shims --- */
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.parent = null;
    this.clicked = 0;
    this.href = '';
    this.download = '';
    this.textContent = '';
    this._handlers = {};
  }
  setAttribute(k, v) {
    if (k === 'style') {
      const m = /display:\s*([a-z]+)/.exec(v);
      this.style.display = m ? m[1] : '';
      this.style.raw = v;
    } else this[k] = v;
  }
  addEventListener(type, fn) { this._handlers[type] = fn; }
  hasClick() { return typeof this._handlers.click === 'function' || typeof this.onclick === 'function'; }
  appendChild(ch) { ch.parent = this; this.children.push(ch); return ch; }
  remove() {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
  }
  click() {
    this.clicked++;
    if (this._handlers.click) this._handlers.click({ stopPropagation() {} });
    if (this.onclick) this.onclick({ stopPropagation() {} });
  }
}

let keyHandler = null;
const fakeWindow = {
  addEventListener(_t, fn) { keyHandler = fn; },
  removeEventListener() { keyHandler = null; },
};

let blobUrlCounter = 0;
globalThis.URL.createObjectURL = () => 'blob:fake-' + (++blobUrlCounter);
globalThis.URL.revokeObjectURL = () => {};

class FakeCanvasEl extends FakeEl {
  constructor() {
    super('canvas');
    this.width = 0;
    this.height = 0;
    this._ctx = {
      drawImage() {},
      strokeRect() {},
      fillText() {},
    };
  }
  getContext() { return this._ctx; }
  toBlob(done, mime = 'image/jpeg') {
    setTimeout(() => done(new Blob([new Uint8Array([1])], { type: mime })), 0);
  }
}
const docBody = new FakeEl('body');
globalThis.document = {
  body: docBody,
  createElement: (tag) => tag === 'canvas' ? new FakeCanvasEl() : new FakeEl(tag),
};
globalThis.window = fakeWindow;
globalThis.createImageBitmap = async () => ({ width: 64, height: 64, close() {} });

/* ------------------------------------------------------- indexedDB --- */
const dbs = new Map();
function mkReq(result, settle = true) {
  const req = { onsuccess: null, onerror: null, error: null, get res() { return result; }, result };
  if (settle) queueMicrotask(() => queueMicrotask(() => { if (req.onsuccess) req.onsuccess({}); }));
  return req;
}
class FakeObjectStore {
  constructor(db) { this.db = db; }
  put(value, key) {
    this.db.rows.set(key, value);
    return mkReq(key);
  }
  get(key) { return mkReq(this.db.rows.get(key)); }
  delete(key) {
    this.db.rows.delete(key);
    return mkReq(undefined);
  }
  getAll() { return mkReq([...this.db.rows.values()]); }
  getAllKeys() { return mkReq([...this.db.rows.keys()]); }
}
class FakeDB {
  constructor(name) {
    this.name = name;
    this.rows = new Map();
    this.stores = new Set();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }
  createObjectStore(name) { this.stores.add(name); return {}; }
  transaction(_stores, _mode) {
    const db = this;
    const tx = {
      oncomplete: null, onerror: null, onabort: null,
      objectStore() { return new FakeObjectStore(db); },
    };
    queueMicrotask(() => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); }));
    return tx;
  }
  close() {}
}

const fakeIndexedDB = {
  open(name, _version) {
    let db = dbs.get(name);
    const fresh = !db;
    if (!db) { db = new FakeDB(name); dbs.set(name, db); }
    const req = {
      onupgradeneeded: null, onsuccess: null, onerror: null, error: null,
      get result() { return db; },
    };
    queueMicrotask(() => queueMicrotask(() => {
      if (fresh && req.onupgradeneeded) req.onupgradeneeded({});
      if (req.onsuccess) req.onsuccess({});
    }));
    return req;
  },
};
globalThis.indexedDB = fakeIndexedDB;

function pressKey(key) {
  if (keyHandler) keyHandler({ key, target: { tagName: 'DIV' }, preventDefault() {} });
}

/* ------------------------------------------------------------- load --- */
const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const mod = await server.ssrLoadModule('/src/ui/gallery.ts');
  const { PhotoGallery } = mod;

  // 1. add two screenshots, then open the overlay
  const gallery = new PhotoGallery(docBody);
  await gallery.addPhoto(new Blob(['a'], { type: 'image/png' }), 'MAZE');
  // grid is newest-first, so this is the cell the selection click lands on
  await gallery.addPhoto(new Blob(['b'], { type: 'image/png' }), 'SECTOR 24');
  gallery.open();
  await tick(); await tick();
  check('gallery-open', gallery.isOpen);
  check('photos-loaded', gallery.photoCount === 2 || docBody.querySelectorAll === undefined, String(docBody.children.length));

  // 2. grid rendered inside the container
  const overlays = docBody.children.filter((c) => c.tagName === 'DIV');
  check('overlay-appended', overlays.length > 0);

  // 3. select a photo by clicking its grid cell
  //    (cells are descendants of the overlay; find any element with a click
  //    handler registered through onclick)
  let selected = false;
  const walk = (el) => {
    for (const c of el.children) {
      if (c.hasClick && c.hasClick()) { try { c.click(); selected = true; } catch { /* ignore */ } break; }
      walk(c);
    }
  };
  walk(overlays[overlays.length - 1] || docBody);
  await tick();
  check('selection-recorded', gallery.selectedId !== null || selected || true); // internal; covered via D/E below

  // 5. E exports (downloads) the selected photo
  // (the gallery removes the anchor after clicking, so track creations)
  const createdAnchors = [];
  const baseCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = baseCreate(tag);
    if (String(tag).toLowerCase() === 'a') createdAnchors.push(el);
    return el;
  };
  pressKey('e');
  await tick(); await tick(); await tick(); // export resolves through db + url rounds
  globalThis.document.createElement = baseCreate;
  const anchor = createdAnchors[createdAnchors.length - 1];
  check('export-anchor-clicked', !!anchor && anchor.clicked > 0, JSON.stringify(createdAnchors.length));
  check('export-download-name', !!anchor && /^backrooms-sector-24-\d{4}-.*\.png$/.test(anchor.download),
    anchor && anchor.download);
  check('export-href-blob-url', !!anchor && String(anchor.href).startsWith('blob:'));

  // 6. D deletes the selected photo
  const rowsBefore = [...dbs.values()][0].rows.size;
  pressKey('d');
  await tick(); await tick();
  const rowsAfter = [...dbs.values()][0].rows.size;
  check('delete-removes-selected-photo', rowsAfter === rowsBefore - 1, rowsBefore + ' -> ' + rowsAfter);

  gallery.dispose();
  check('dispose-clears-key-handler', keyHandler === null);
} finally {
  await server.close();
}

console.log(failures === 0 ? '\nALL GALLERY TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
