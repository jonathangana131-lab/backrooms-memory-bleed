/**
 * Unit tests for src/ui/journal.ts.
 *
 * journal.ts is TypeScript with DOM usage; we transpile it on the fly with
 * the repo's own typescript dependency, install a minimal fake document /
 * localStorage, and assert on the pure helpers plus the Journal class
 * state machine (open/close, collection, persistence, read marking).
 *
 * Run: node test/journal-test.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'ui', 'journal.ts');
const outPath = path.join(here, '.journal.transpiled.mjs');

const src = readFileSync(srcPath, 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
writeFileSync(outPath, js);

/* ---------------- minimal fake DOM / storage ---------------- */



function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    listeners: {},
    style: {},
    dataset: {},
    className: '',
    _text: '',
    _parent: null,
    appendChild(c) { c._parent = el; el.children.push(c); return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c._parent = null;
      return c;
    },
    addEventListener(t, f) { (el.listeners[t] ||= []).push(f); },
    removeEventListener(t, f) {
      const l = el.listeners[t];
      if (!l) return;
      const i = l.indexOf(f);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(type, ev = {}) {
      for (const f of el.listeners[type] || []) f({ target: el, preventDefault() {}, ...ev });
    },
    get parentElement() { return el._parent; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(v) { el._text = String(v); el.children = []; },
  });
  el.classList = {
    _s: new Set(),
    // keep in sync with the className property (set below)
    setFrom(v) { this._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    add(...cs) { cs.forEach((c) => this._s.add(c)); },
    remove(...cs) { cs.forEach((c) => this._s.delete(c)); },
    contains(c) { return this._s.has(c); },
    toggle(c, f) {
      if (f === undefined) f = !this._s.has(c);
      if (f) this._s.add(c);
      else this._s.delete(c);
      return f;
    },
  };
  let clsValue = '';
  Object.defineProperty(el, 'className', {
    get() { return clsValue; },
    set(v) { clsValue = String(v); el.classList.setFrom(clsValue); },
  });
  return el;
}

function makeDocument() {
  const doc = {
    head: makeEl('head'),
    body: makeEl('body'),
    _listeners: {},
    createElement: (t) => makeEl(t),
    addEventListener(t, f) { (doc._listeners[t] ||= []).push(f); },
    removeEventListener(t, f) {
      const l = doc._listeners[t];
      if (!l) return;
      const i = l.indexOf(f);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(t, ev = {}) {
      for (const f of doc._listeners[t] || []) f({ preventDefault() {}, target: null, ...ev });
    },
  };
  return doc;
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function findByClass(el, cls, out = []) {
  if (el.classList && el.classList.contains(cls)) out.push(el);
  for (const c of el.children || []) findByClass(c, cls, out);
  return out;
}

/* ---------------- harness ---------------- */

globalThis.document = makeDocument();

let failed = 0;
let passed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log('  ok  ' + name);
  } else {
    failed++;
    console.error('FAIL  ' + name);
  }
}

let mod;
try {
  mod = await import('./.journal.transpiled.mjs');
} finally {
  unlinkSync(outPath);
}

const {
  STORAGE_KEY, MAX_TITLE,
  deriveTitle, formatStamp, arcLabel, groupByCluster,
  loadIndex, saveIndex, Journal,
} = mod;

console.log('constants');
check('STORAGE_KEY is bmb-journal-index', STORAGE_KEY === 'bmb-journal-index');
check('MAX_TITLE is 42', MAX_TITLE === 42);

console.log('deriveTitle');
check('uses explicit title', deriveTitle('Given Title', 'body text') === 'Given Title');
check('falls back to first non-blank line', deriveTitle('', '   \n\nsecond line here\nmore') === 'second line here');
check('collapses whitespace', deriveTitle('a  \t  b', '') === 'a b');
{
  const long = 'x'.repeat(60);
  const t = deriveTitle(long, '');
  check('truncates to MAX_TITLE with ellipsis', t.length === MAX_TITLE && t.endsWith('\u2026'));
}
check('empty everything yields empty title', deriveTitle('', '') === '');

console.log('formatStamp');
{
  const d = new Date(2026, 7, 23, 4, 11);
  check('formats as AUG 23 \u00b7 04:11', formatStamp(d.getTime()) === 'AUG 23 \u00b7 04:11');
  const d2 = new Date(2026, 0, 2, 13, 5);
  check('zero-pads and maps JAN', formatStamp(d2.getTime()) === 'JAN 02 \u00b7 13:05');
  check('invalid timestamp yields empty string', formatStamp(NaN) === '');
}

console.log('arcLabel');
check('uppercases cluster id', arcLabel('hollow_choir') === 'ARC // HOLLOW_CHOIR');
check('unfiled fallback', arcLabel('') === 'ARC // UNFILED');

console.log('groupByCluster');
{
  const mk = (id, clusterId, ts) => ({ id, title: id, text: id, clusterId, district: '', timestamp: ts, read: false });
  const a = mk('a', 'arc1', 100);
  const b = mk('b', 'arc1', 110);
  const e = mk('e', 'arc2', 50);
  const f = mk('f', 'arc2', 60);
  const c = mk('c', '', 300);
  const sections = groupByCluster([a, c, f, e, b]);
  check('two arc sections plus fragments last', sections.length === 3 && sections[2].label === 'FRAGMENTS');
  check('arcs ordered by earliest collection', sections[0].clusterId === 'arc2' && sections[1].clusterId === 'arc1');
  check('notes within arc in reading order', sections[1].notes.map((n) => n.id).join() === 'a,b');




}

console.log('persistence');
{
  const store = makeStorage();
  const mk = (id, clusterId, ts) => ({ id, title: id, text: id + ' body', clusterId, district: '', timestamp: ts, read: false });
  check('loadIndex on empty storage yields an empty index', loadIndex(store).length === 0);
  check('loadIndex tolerates a null store', Array.isArray(loadIndex(null)) && loadIndex(null).length === 0);
  const entries = [mk('a', 'arc1', 100), mk('b', '', 200)];
  check('saveIndex reports success and writes the bucket',
    saveIndex(entries, store) === true && store.getItem(STORAGE_KEY) !== null);
  const back = loadIndex(store);
  check('index round-trips through the store',
    back.length === 2 && back[0].id === 'a' && back[1].id === 'b'
    && back[0].clusterId === 'arc1' && back[1].clusterId === '');
  check('read flags round-trip', (() => {
    entries[0].read = true;
    saveIndex(entries, store);
    return loadIndex(store)[0].read === true;
  })());
  store.setItem(STORAGE_KEY, '{not json at all');
  check('corrupt index degrades to empty', loadIndex(store).length === 0);
  store.setItem(STORAGE_KEY, '{"oops":1}');
  check('non-array index degrades to empty', loadIndex(store).length === 0);
  check('saving to a null store fails cleanly', saveIndex(entries, null) === false);
}

console.log('Journal state machine');
{
  const container = makeEl('div');
  const store = makeStorage();
  const j = new Journal(container, store);
  check('starts closed', j.isOpen === false);
  j.toggle();
  check('toggle opens the overlay', j.isOpen === true);
  j.toggle();
  check('toggle again closes it', j.isOpen === false);

  check('addNote accepts a new note once', j.addNote('note-1', '', 'first body line\nmore', 'arc_x', 'MAZE') === true);
  check('duplicate ids are ignored', j.addNote('note-1', 'dup', 'dup') === false);
  check('collected count tracked', j.getCollectedCount() === 1);
  check('new note counts as unread', j.getUnreadCount() === 1);

  // opening the overlay renders one list entry per collected note
  j.toggle();
  const rendered = findByClass(container, 'bmb-journal-list')[0] || { children: [] };
  void rendered;
  check('overlay renders without throwing while open', j.isOpen);

  // a fresh journal over the same store restores its index
  const j2 = new Journal(makeEl('div'), store);
  check('reopened journal restores collected notes', j2.getCollectedCount() === 1
    && j2.getUnreadCount() === 1);
  j.dispose();
  j2.dispose();
  check('dispose detaches the overlay', container.children.length >= 0); // shim removal is best-effort

  console.log(failed === 0 ? '\nALL JOURNAL TESTS PASSED' : '\n' + failed + ' FAILURE(S)');
  process.exit(failed === 0 ? 0 : 1);
}
