/*
 * EndStats unit verification.
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
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attrs;
  }
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  body: new FakeElement('body'),
};

const { EndStats, computeRank, formatStatLines, formatFooter,
  formatInt, formatDuration } = await import('../src/ui/endstats.ts');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sample(over) {
  return Object.assign({
    seed: 1337,
    durationSec: 1500,
    distanceM: 1234.6,
    uniqueChunks: 42,
    landmarkNames: ['Pool Rooms', 'The Atrium'],
    notesRead: 7,
    batteries: 4,
    relocations: 1,
    phaseTimePct: { calm: 40, build: 30, peak: 20, release: 10 },
    deepestM: 310.2,
    discoveries: 5,
  }, over);
}

/* ------------------------------------------------------- pure helpers ----- */
check('formatInt groups thousands and clamps negatives', () => {
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(999), '999');
  assert.equal(formatInt(1234), '1,234');
  assert.equal(formatInt(1234567), '1,234,567');
  assert.equal(formatInt(-50), '0');
  assert.equal(formatInt(12.4), '12');
});

check('formatDuration renders H:MM:SS', () => {
  assert.equal(formatDuration(0), '0:00:00');
  assert.equal(formatDuration(59.9), '0:00:59');
  assert.equal(formatDuration(3661), '1:01:01');
});

check('formatStatLines lists every tracked stat in order', () => {
  const lines = formatStatLines(sample());
  const labels = lines.map((l) => l.segments[0].text.trim());
  assert.deepEqual(labels, [
    'DISTANCE WALKED',
    'UNIQUE CHUNKS ENTERED',
    'LANDMARKS VISITED',
    'NOTES READ',
    'BATTERIES COLLECTED',
    'RELOCATIONS SURVIVED',
    'DIRECTOR PHASES //',
    'DEEPEST FROM SPAWN',
  ]);
  // Amber value segments carry the numbers.
  assert.equal(lines[0].segments[1].text, '1,235 m');
  assert.equal(lines[0].segments[1].tone, 'amber');
  assert.equal(lines[0].segments[0].tone, 'dim');
  // All four director phases present with percentages.
  const phaseText = lines[6].segments.map((s) => s.text).join('');
  for (const p of ['CALM 40%', 'BUILD 30%', 'PEAK 20%', 'RELEASE 10%']) {
    assert.ok(phaseText.includes(p), 'missing phase text ' + p);
  }
});



