/*
 * RadioTuner unit verification: hidden-station band math, lore pool
 * hygiene, tuning hysteresis and the discovery moment.
 * Standalone in Node against the real src/ui/radiotune.ts (vite SSR).
 *
 *   node test/radiotune-test.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok -', name);
  } catch (e) {
    failures++;
    console.error('FAIL -', name, '::', e.message);
  }
}

// ---- minimal DOM harness ----
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    children: [],
    textContent: '',
    style: { setProperty(name, value) { this[name] = value; } },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    remove() {
      if (this.parent) {
        const i = this.parent.children.indexOf(this);
        if (i >= 0) this.parent.children.splice(i, 1);
        this.parent = null;
      }
    },
    addEventListener(_t, fn) { this.onclick = fn; },
    parent: null,
    onclick: null,
  };
}

/** Build a fake document; returns it for direct assertions too. */
function makeDoc() {
  const doc = {
    head: makeEl('head'),
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
  };
  return { doc };
}

/** Depth-first search for the first element with a given class. */
function findByClass(root, cls) {
  if (root.className === cls) return root;
  for (const child of root.children) {
    const hit = findByClass(child, cls);
    if (hit) return hit;
  }
  return null;
}

/** Audio backend that records every intention for assertions. */
function audioRecorder() {
  const rec = {
    staticLevels: [],
    voiceLevels: [],
    pings: 0,
    suspended: 0,
    resumed: 0,
    lastStatic: -1,
    setStatic(v) {
      rec.lastStatic = v;
      rec.staticLevels.push(v);
    },
    setVoice(v) { rec.voiceLevels.push(v); },
    ping() { rec.pings++; },
    suspend() { rec.suspended++; },
    resume() { rec.resumed++; },
  };
  return rec;
}

// ---- module under test ----
const mod = await server.ssrLoadModule('/src/ui/radiotune.ts');
const {
  RadioTuner,
  FREQ_MIN, FREQ_MAX, LOCK_RANGE, TUNE_SPEED, STATIC_RAMP,
  LORE_POOL, hashSeed, targetFreqFor, clampFreq, isLocked,
  staticVolume, needlePercent, loreIndexFor,
} = mod;

/** Open a tuner against a fake doc + recording audio for one radio seed. */
function makeTuner(seed) {
  const audio = audioRecorder();
  const { doc } = makeDoc();
  const tuner = new RadioTuner({ document: doc, createAudio: () => audio });
  tuner.open(seed);
  return { tuner, audio, doc };
}

/** Hold a tune direction until update() reports discovery or budget dies. */
function tuneUntilFound(tuner, key) {
  tuner.pressKey(key);
  try {
    const seen = [];
    for (let i = 0; i < 400; i++) {
      const out = tuner.update(0.05);
      if (out !== null) return seen.concat([out]);
      seen.push(out);
    }
    throw new Error('never locked onto hidden station');
  } finally {
    tuner.releaseKey(key);
  }
}

const readoutOf = (t) => findByClass(t.root, 'bmb-radiotune-freq').textContent;

/* ------------------------------------------------------------------ */
/* Lore pool                                                           */
/* ------------------------------------------------------------------ */

check('lore pool holds ten fragments', () => {
  assert.equal(LORE_POOL.length, 10);
});

check('every fragment is short, non-empty prose (1-2 sentences)', () => {
  for (const f of LORE_POOL) {
    assert.ok(f.trim().length > 20, 'too short: ' + f);
    // strip decimal points inside coordinates so they don't fake a split
    const sentences = f.replace(/(\d)\.(\d)/g, '$1$2').split(/[.!?]/).map((s) => s.trim()).filter(Boolean);
    assert.ok(sentences.length >= 1 && sentences.length <= 3,
      'sentence count ' + sentences.length + ': ' + f);
  }
});

check('pool mixes coordinates, corridor warnings, personal mail', () => {
  const joined = LORE_POOL.join(' ').toLowerCase();
  assert.match(joined, /grid|degrees north|datum/, 'coordinates');
  assert.match(joined, /corridor/, 'corridor warning');
  assert.match(joined, /jamie|mara/, 'personal message');
});

/* ------------------------------------------------------------------ */
/* Pure band math                                                      */
/* ------------------------------------------------------------------ */

check('band edges are 88/108 MHz', () => {
  assert.equal(FREQ_MIN, 88);
  assert.equal(FREQ_MAX, 108);
});

check('hidden carriers sit inside the padded band, one decimal', () => {
  for (const seed of ['alpha', 'bravo', 'CHURCH-12', '', 'zzzz']) {
    const f = targetFreqFor(seed);
    assert.ok(f >= FREQ_MIN + 1.5 && f <= FREQ_MAX - 1.5, 'in band: ' + f);
    assert.equal(f, Math.round(f * 10) / 10, 'one decimal');
    assert.equal(targetFreqFor(seed), f, 'deterministic');
  }
});

check('clampFreq bounds the dial and rescues NaN', () => {
  assert.equal(clampFreq(-5), FREQ_MIN);
  assert.equal(clampFreq(500), FREQ_MAX);
  assert.equal(clampFreq(NaN), FREQ_MIN);
  assert.equal(clampFreq(95.5), 95.5);
});

check('lock window matches LOCK_RANGE exactly', () => {
  assert.equal(isLocked(100, 100 + LOCK_RANGE), true);
  assert.equal(isLocked(100, 100 + LOCK_RANGE + 0.001), false);
});

check('static silences at the carrier and ramps out to full', () => {
  assert.equal(staticVolume(100, 100), 0);
  assert.equal(staticVolume(100.2, 100), 0, 'inside lock range');
  const mid = staticVolume(100 + LOCK_RANGE + STATIC_RAMP / 2, 100);
  assert.ok(mid > 0.4 && mid < 0.6, 'half ramp ~ half volume: ' + mid);
  assert.equal(staticVolume(100 + LOCK_RANGE + STATIC_RAMP + 1, 100), 1);
  assert.equal(staticVolume(80, 20, true), 0, 'found stations stay silent');
});

check('needlePercent spans the band edge to edge and clamps', () => {
  assert.equal(needlePercent(FREQ_MIN), 0);
  assert.equal(needlePercent(FREQ_MAX), 100);
  assert.equal(needlePercent(70), 0);
  assert.equal(needlePercent(200), 100);
});

check('loreIndexFor walks forward past taken indices', () => {
  const h = hashSeed('seed');
  const n = LORE_POOL.length;
  const start = ((h % n) + n) % n;
  assert.equal(loreIndexFor(h, new Set()), start);
  const taken = new Set([start]);
  assert.equal(loreIndexFor(h, taken), (start + 1) % n);
  // everything taken falls back to the hashed start
  const all = new Set(Array.from({ length: n }, (_, i) => i));
  assert.equal(loreIndexFor(h, all), start);
});

/* ------------------------------------------------------------------ */
/* Tuning flow                                                         */
/* ------------------------------------------------------------------ */

check('opening a radio reveals the dial and its readout', () => {
  const { tuner } = makeTuner('test-seed');
  assert.ok(findByClass(tuner.root, 'bmb-radiotune-freq'));
  assert.match(readoutOf(tuner), /\d/, 'readout shows a frequency');
});

check('holding a tune direction locks onto the hidden station', () => {
  const seed = 'discovery-test';
  const target = targetFreqFor(seed);
  const key = target > 95 ? 'd' : 'a'; // tune up or down toward the carrier
  const { tuner } = makeTuner(seed);
  const lore = tuneUntilFound(tuner, key);
  assert.ok(LORE_POOL.includes(lore[lore.length - 1]), 'discovery surfaces pool lore');
  assert.ok(isLocked(clampFreq(parseFloat(readoutOf(tuner))), target),
    'readout rests at the carrier');
});

check('static clears as the needle approaches the carrier', () => {
  const seed = 'static-test';
  const target = targetFreqFor(seed);
  const { tuner, audio } = makeTuner(seed);
  tuner.pressKey(target > 95 ? 'd' : 'a');
  let found = false;
  for (let i = 0; i < 400 && !found; i++) {
    tuner.update(0.02);
    if (tuner.update ? false : false) break;
    if (i > 380) break;
    // stop condition handled by level inspection below
    found = audio.lastStatic === 0 && i > 5;
  }
  tuner.releaseKey(target > 95 ? 'd' : 'a');
  void found;
  assert.ok(audio.staticLevels.length > 10, 'static was driven while tuning');
  assert.equal(audio.lastStatic, 0, 'static silent at the lock');
});

await server.close();
console.log(failures === 0 ? '\nALL RADIOTUNE TESTS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
