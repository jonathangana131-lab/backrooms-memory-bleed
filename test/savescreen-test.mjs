/*
 * SaveScreen unit verification.
 * Runs standalone in Node (v22+, --experimental-strip-types) against a
 * minimal DOM shim; no browser or dev server required.
 */
import { strict as assert } from 'node:assert';

/* ------------------------------------------------------------- DOM shim --- */
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.attrs = {};
    this.listeners = new Map();
    this.value = '';
    this.files = null;
    this.href = '';
    this.download = '';
    this.type = '';
    this.accept = '';
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  appendChild(child) {
    if (child.parentElement) {
      const i = child.parentElement.children.indexOf(child);
      if (i >= 0) child.parentElement.children.splice(i, 1);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    assert.ok(i >= 0, 'removeChild: not a child');
    this.children.splice(i, 1);
    child.parentElement = null;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  setAttribute(name, val) {
    this.attrs[name] = String(val);
    if (name === 'style') this.styleText = String(val);
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const fns = this.listeners.get(type);
    if (fns) this.listeners.set(type, fns.filter((f) => f !== fn));
  }
  dispatch(type, arg) {
    for (const fn of this.listeners.get(type) ?? []) fn(arg);
  }
  click() {
    this.dispatch('click', { preventDefault() {} });
  }
  scrollIntoView() {}
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    const walk = (el) => {
      for (const c of el.children) {
        if (c.className === cls) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this);
  }
}

const winListeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  },
  removeEventListener(type, fn) {
    const fns = winListeners.get(type);
    if (fns) winListeners.set(type, fns.filter((f) => f !== fn));
  },
};
function fireKey(key) {
  const ev = { key, preventDefault() { ev.defaulted = true; } };
  for (const fn of winListeners.get('keydown') ?? []) fn(ev);
  return ev;
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  body: new FakeElement('body'),
};

const { SaveScreen, formatTimestamp, formatPlaytime, validateCheckpoint,
  validateCheckpointFile, slotExportJson, exportFileName } =
  await import('../src/ui/savescreen.ts');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

/* ------------------------------------------------------- pure helpers ----- */
check('formatTimestamp renders YYYY-MM-DD HH:MM:SS', () => {
  // 2026-08-23T10:20:30 local
  const d = new Date(2026, 7, 23, 10, 20, 30);
  assert.equal(formatTimestamp(d.getTime()), '2026-08-23 10:20:30');
});

check('formatPlaytime renders H:MM:SS', () => {
  assert.equal(formatPlaytime(0), '0:00:00');
  assert.equal(formatPlaytime(59), '0:00:59');
  assert.equal(formatPlaytime(60 * 5 + 9), '0:05:09');
  assert.equal(formatPlaytime(2 * 3600 + 61), '2:01:01');
  assert.equal(formatPlaytime(-3), '0:00:00');
});

check('validateCheckpoint accepts a well-formed save', () => {
  const v = validateCheckpoint({ seed: 42, px: 1.5, pz: -3.25 });
  assert.equal(v.ok, true);
  assert.equal(v.slot.seed, 42);
});

check('validateCheckpoint rejects junk', () => {
  assert.equal(validateCheckpoint(null).ok, false);
  assert.equal(validateCheckpoint([1]).ok, false);
  assert.equal(validateCheckpoint({}).ok, false);
  assert.equal(validateCheckpoint({ seed: 'x', px: 0, pz: 0 }).ok, false);
  assert.equal(validateCheckpoint({ seed: 1, px: NaN, pz: 0 }).ok, false);
  assert.equal(validateCheckpoint({ seed: 1, px: 0 }).ok, false);
});

check('validateCheckpointFile gates bad JSON before the host sees it', async () => {
  const bad = { name: 'broken.json', text: async () => '{not json' };
  assert.equal((await validateCheckpointFile(bad)).ok, false);
  const missing = { name: 'thin.json', text: async () => JSON.stringify({ hello: 1 }) };
  assert.equal((await validateCheckpointFile(missing)).ok, false);
  const good = {
    name: 'good.json',
    text: async () => JSON.stringify({ seed: 7, px: 0, pz: 0 }),
  };
  assert.equal((await validateCheckpointFile(good)).ok, true);
});

check('slotExportJson prefers the full payload', () => {
  const data = { seed: 9, px: 1, pz: 2 };
  const parsed = JSON.parse(slotExportJson({ name: 'auto', timestamp: 0,
    discoveries: 0, playtimeSec: 0, data }));
  assert.equal(parsed.seed, 9);
});

check('exportFileName is slug + stamp', () => {
  const name = exportFileName({ name: 'Checkpoint 3!', timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
    discoveries: 0, playtimeSec: 0 });
  assert.match(name, /^backrooms-checkpoint-3-2026-01-02T03-04-05\.json$/);
});

/* ------------------------------------------------------- SaveScreen ------- */
function makeHarness(slots) {
  const container = new FakeElement('div');
  const calls = { load: [], del: [], imports: [] };
  const screen = new SaveScreen(container, {
    onLoad: (s) => calls.load.push(s),
    onDelete: (n) => calls.del.push(n),
    onImport: (f) => calls.imports.push(f),
  });
  return { container, screen, calls };
}

function listRows(screen) {
  return screen.listEl.children;
}

const slots = [
  { name: 'checkpoint-1', timestamp: 1000, discoveries: 2, playtimeSec: 600 },
  { name: 'auto', timestamp: 3000, discoveries: 9, playtimeSec: 7200 },
  { name: 'auto-backup', timestamp: 2000, discoveries: 8, playtimeSec: 7000 },
];

// Await helper for async import flow.
const tick = () => new Promise((r) => setTimeout(r, 0));

check('show() opens sorted newest-first with meta lines', () => {
  const h = makeHarness();
  assert.equal(h.screen.isOpen, false);
  h.screen.show(slots);
  assert.equal(h.screen.isOpen, true);
  assert.equal(h.container.children.length, 1); // overlay attached
  const rows = listRows(h.screen);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].children[0].children[0].textContent, 'AUTO');
  assert.equal(rows[2].children[0].children[0].textContent, 'CHECKPOINT-1');
  const meta = rows[1].children[0].children[1].textContent;
  assert.match(meta, /discoveries 8/);
  assert.match(meta, /1:56:40/);
  h.screen.dispose();
});

check('arrow keys move selection; Enter loads and closes', () => {
  const h = makeHarness();
  h.screen.show(slots);
  fireKey('ArrowDown');
  fireKey('ArrowDown');
  const rows = listRows(h.screen);
  assert.match(rows[2].getAttribute('style'), /background:#14120c/);
  fireKey('Enter');
  assert.equal(h.calls.load.length, 1);
  assert.equal(h.calls.load[0].name, 'checkpoint-1');
  assert.equal(h.screen.isOpen, false);
  h.screen.dispose();
});

check('delete requires a second confirm press', () => {
  const h = makeHarness();
  h.screen.show(slots);
  fireKey('d'); // arm on selected row 0 ('auto')
  assert.equal(h.calls.del.length, 0);
  const delBtn = listRows(h.screen)[0].querySelector('.bmb-savescreen-delete');
  assert.equal(delBtn.textContent, 'CONFIRM?');
  fireKey('d'); // confirm
  assert.deepEqual(h.calls.del, ['auto']);
  h.screen.dispose();
});

check('moving selection disarms an armed delete', () => {
  const h = makeHarness();
  h.screen.show(slots);
  fireKey('d');
  fireKey('ArrowDown');
  fireKey('d'); // now targets row 1, fresh arm
  assert.deepEqual(h.calls.del, []);
  fireKey('d');
  assert.deepEqual(h.calls.del, ['auto-backup']);
  h.screen.dispose();
});

check('Escape closes without acting', () => {
  const h = makeHarness();
  h.screen.show(slots);
  fireKey('Escape');
  assert.equal(h.screen.isOpen, false);
  assert.equal(h.calls.load.length, 0);
  assert.equal(h.calls.del.length, 0);
  h.screen.dispose();
});

check('ingestFile validates before offering to the host', async () => {
  const h = makeHarness();
  h.screen.show(slots);
  const bad = { name: 'junk.json', text: async () => 'nope' };
  assert.equal(await h.screen.ingestFile(bad), false);
  assert.deepEqual(h.calls.imports, []);
  const good = {
    name: 'shared.json',
    text: async () => JSON.stringify({ seed: 5, px: 0, pz: 0 }),
  };
  assert.equal(await h.screen.ingestFile(good), true);
  assert.equal(h.calls.imports.length, 1);
  assert.equal(h.calls.imports[0].name, 'shared.json');
  h.screen.dispose();
});

check('dispose detaches overlay and window listener', () => {
  const h = makeHarness();
  h.screen.show(slots);
  h.screen.dispose();
  assert.equal(h.container.children.length, 0);
  // No lingering handler: firing a key must not throw through disposed state.
  fireKey('Enter');
  assert.equal(h.calls.load.length, 0);
});

await tick();
console.log('savescreen-test: ' + passed + ' checks passed');


