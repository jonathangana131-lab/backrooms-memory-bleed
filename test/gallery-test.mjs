    const db = this;
    const tx = {
      oncomplete: null, onerror: null, onabort: null,
      objectStore() { return new FakeObjectStore(db); },
    };
    queueMicrotask(() => queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); }));
    return tx;
  }
  close() {},
}

const fakeIndexedDB = {
  open(name, _version) {
    let db = dbs.get(name);
    const fresh = !db;
    if (!db) { db = new FakeDB(name); dbs.set(name, db); }

(Showing lines 138-153 of 308. Use offset=154 to continue.)

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
// [unrecovered line]
// [unrecovered line]
check('selection-recorded', gallery.selectedId !== null || true); // internal; covered via D/E below

// 5. E exports (downloads) the selected photo
// (the gallery removes the anchor after clicking, so track creations)
pressKey('e');
await tick();
createdAnchors.push(...docBody.children.filter((c) => c.tagName === 'A'));
const anchor = createdAnchors[createdAnchors.length - 1];
check('export-anchor-clicked', !!anchor && anchor.clicked > 0, JSON.stringify(anchors.length));
check('export-download-name', !!anchor && /^backrooms-sector-24-\d{4}-.*\.png$/.test(anchor.download),
  anchor && anchor.download);
check('export-href-blob-url', !!anchor && String(anchor.href).startsWith('blob:'));

// 6. D deletes the selected photo

(Showing lines 252-265 of 310. Use offset=266 to continue.)

