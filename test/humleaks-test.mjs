/*
 * Hum melody-leak tests (F36).
 *
 * Proves the AC against a minimal WebAudio mock:
 *   1. motif persistence — deriveMotifNotes is a pure function of the seed
 *      (same list of prior-run seeds always yields the same motif set),
 *      motifs are 4-7 notes, never unison
 *   2. injection off by default — without enableMotifLeaks() the twin
 *      glide target never leaves the beat window and lastQuotedMotif()
 *      stays null (zero behavior change)
 *   3. quote probability honored statistically over many draws
 *   4. deterministic per seed-list: two instances configured identically
 *      produce identical quote timelines
 *   5. a quoted note holds for a seeded duration, then the plain beat
 *      detune resumes
 *
 * Run: node test/humleaks-test.mjs
 */
import {
  HumHarmonics,
  HUM_FUNDAMENTAL,
  BEAT_MIN,
  BEAT_MAX,
  deriveMotifNotes,
} from '../src/audio/humharmonics.ts';

// ---- minimal AudioContext mock (idiom of humharmonics-test.mjs) -----------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.sets = [];
    this.targets = [];
  }
  setValueAtTime(v) { this.value = v; this.sets.push({ v, t: now }); }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; this.targets.push({ v }); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx;
    this.gain = new Param(1);
    this.frequency = new Param(440);
    this.type = '';
  }
  connect() { return this; }
  disconnect() {}
  start() {}
  stop() {}
}
class Ctx {
  constructor() {
    this.currentTime = now;
    this.nodes = [];
    this.destination = new Node(this);
  }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
}

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

// The twin voice's fundamental is the only oscillator that STARTS strictly
// inside the beat window (lead sits exactly on 60 Hz, harmonics >= 180 Hz).
// It must be resolved ONCE per instance, immediately after construction,
// because quotes legitimately retune it outside that window later.
function makeHum(seeds, p) {
  const ctx = new Ctx();
  const hum = new HumHarmonics(ctx, ctx.destination);
  const twin = ctx.nodes.find(
    (n) => n._kind === 'oscillator' &&
      n.frequency.value > HUM_FUNDAMENTAL &&
      n.frequency.value <= HUM_FUNDAMENTAL + BEAT_MAX + 1,
  );
  hum.setFixtureCount(2);
  if (seeds !== null) hum.enableMotifLeaks({ priorSeeds: seeds, quoteProbability: p });
  return { ctx, hum, twin };
}

const inBeatWindow = (hz) =>
  hz >= HUM_FUNDAMENTAL + BEAT_MIN - 1e-9 && hz <= HUM_FUNDAMENTAL + BEAT_MAX + 1e-9;

function drive(hum, twin, dt, ticks) {
  const outOfWindow = [];
  for (let i = 0; i < ticks; i++) {
    const before = twin.frequency.sets.length;
    now += dt;
    ctxNow(twin.ctx, now);
    hum.update(dt);
    for (let k = before; k < twin.frequency.sets.length; k++) {
      const v = twin.frequency.sets[k].v;
      if (!inBeatWindow(v)) outOfWindow.push({ v, t: twin.frequency.sets[k].t });
    }
  }
  return outOfWindow;
}
function ctxNow(ctx, t) { ctx.currentTime = t; }

// ---- 1. motif persistence --------------------------------------------------
(() => {
  const SEEDS = [11, 0xdeadbeef, -42, 777];
  const a = SEEDS.map(deriveMotifNotes);
  const b = SEEDS.map(deriveMotifNotes);
  check('same seeds derive identical motif sets', JSON.stringify(a) === JSON.stringify(b));
  check('every motif has 4-7 notes', a.every((m) => m.length >= 4 && m.length <= 7),
    JSON.stringify(a.map((m) => m.length)));
  check('no motif note is unison (ratio 1)',
    a.every((m) => m.every((r) => Math.abs(r - 1) > 1e-9)));
  check('motif ratios stay within one octave of the fundamental',
    a.every((m) => m.every((r) => r >= Math.pow(2, -12 / 12) - 1e-9 && r <= Math.pow(2, 12 / 12) + 1e-9)));
  check('different seeds derive different motifs',
    JSON.stringify(deriveMotifNotes(1)) !== JSON.stringify(deriveMotifNotes(2)));
})();

// ---- 2. injection off by default -------------------------------------------
(() => {
  const { hum, twin } = makeHum(null, 0);
  const leaked = drive(hum, twin, 10, 60);
  check('no quotes without enableMotifLeaks()', leaked.length === 0,
    JSON.stringify(leaked.slice(0, 3)));
  check('lastQuotedMotif() stays null when disabled', hum.lastQuotedMotif() === null);
})();

// ---- 3. probability honored statistically ----------------------------------
// One decision per fresh instance (first opportunity fires within dt=10),
// each instance keyed on its own seed so the draw streams differ.
(() => {
  const quoteCount = (p) => {
    let q = 0;
    for (let k = 0; k < 400; k++) {
      const { hum, twin } = makeHum([1000 + k * 7919], p);
      q += drive(hum, twin, 10, 1).length;
    }
    return q;
  };
  check('probability 0 quotes nothing', quoteCount(0) === 0);
  check('probability 1 quotes every one of 400 opportunities', quoteCount(1) === 400);
  const pm = quoteCount(0.45);
  check('probability 0.45 lands within ±0.09 over 400 draws',
    Math.abs(pm / 400 - 0.45) <= 0.09, String(pm));
})();

// ---- 4. determinism per seed list ------------------------------------------
(() => {
  const timeline = () => {
    const { hum, twin } = makeHum([90210, 4242], 0.8);
    drive(hum, twin, 10, 80);
    const quotes = twin.frequency.sets.filter((s) => !inBeatWindow(s.v));
    return {
      // quote sets only: the legacy beat drift is Math.random-timed by design
      // and is not part of the F36 determinism surface
      sets: quotes.map((s) => [s.t - quotes[0].t, s.v.toFixed(6)].join(':')),
      last: hum.lastQuotedMotif(),
    };
  };
  const t1 = timeline();
  const t2 = timeline();
  check('identical seed lists produce identical quote timelines',
    JSON.stringify(t1.sets) === JSON.stringify(t2.sets));
  check('identical seed lists produce identical final quote record',
    t1.last !== null && t2.last !== null &&
    t1.last.seed === t2.last.seed && t1.last.noteIndex === t2.last.noteIndex &&
    JSON.stringify(t1.last.notesHz) === JSON.stringify(t2.last.notesHz));
})();

// ---- 5. hold then restore ----------------------------------------------------
(() => {
  const { ctx, hum, twin } = makeHum([31337], 1);
  now += 10;
  ctx.currentTime = now;
  hum.update(10); // fires the first opportunity immediately
  const quote = hum.lastQuotedMotif();
  check('a quote was recorded', quote !== null);
  check('quoted seed comes from the injected list', quote.seed === 31337);
  check('noteIndex points into the motif',
    quote.noteIndex >= 0 && quote.noteIndex < quote.notesHz.length);
  check('twin sits on the quoted pitch during hold',
    Math.abs(twin.frequency.value - HUM_FUNDAMENTAL * quote.notesHz[quote.noteIndex]) < 1e-6,
    String(twin.frequency.value));
  // step past the maximum hold (<= 2.8 s) in small increments
  for (let i = 0; i < 40; i++) { now += 0.1; ctx.currentTime = now; hum.update(0.1); }
  check('beat detune resumes after the hold', inBeatWindow(twin.frequency.value),
    String(twin.frequency.value));
  check('quote record survives the restore', hum.lastQuotedMotif() === quote);
})();

// ---- 6. junk configuration ---------------------------------------------------
(() => {
  const a = makeHum([], 0.9);
  let leaked = drive(a.hum, a.twin, 10, 30);
  check('empty seed list quotes nothing', leaked.length === 0);
  const b = makeHum([99], Number.NaN);
  leaked = drive(b.hum, b.twin, 10, 60);
  check('NaN probability treated as 0', leaked.length === 0,
    JSON.stringify(leaked.slice(0, 2)));
  check('still no crash after junk configs', b.hum.lastQuotedMotif() === null);
})();

console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;
