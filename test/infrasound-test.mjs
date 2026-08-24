/**
 * Unit test for infrasound beds (src/audio/infrasound.ts, F33).
 * Standalone (no browser): transpiles the module (+ its deps) into a temp
 * dir and drives it with a minimal WebAudio mock + fake clock.
 *
 * Acceptance:
 *   1. proxy test — the pure envelope's zero-crossing period matches the
 *      descriptor's modHz within ±2% across 10 s simulated, per district
 *   2. depth bounded [0.15, 0.45] across districts and seeds
 *   3. determinism per seed — identical seeds replay identical descriptors
 *   4. kill-switch ramps to silence (linear ramp reaching exactly 0)
 *   5. graph wiring — LFO runs at modHz through depth/2 into an AM gain
 *      centred at 1 - depth/2; every carrier is an audible harmonic rumble
 *
 * Run: node test/infrasound-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-infrasound-'));
fs.mkdirSync(path.join(tmp, 'audio'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/audio/infrasound.ts', 'audio/infrasound.mjs');
emit('src/core/rng.ts', 'core/rng.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'audio', 'infrasound.mjs')));
const {
  InfrasoundBed,
  env,
  DISTRICT_MOD_HZ,
  MOD_JITTER_HZ,
  DEPTH_MIN,
  DEPTH_MAX,
  KILL_RAMP_S,
} = mod;

// ---- minimal AudioContext mock ---------------------------------------------
let now = 100;
class Param {
  constructor(v) {
    this.value = v;
    this.sets = [];
    this.ramps = [];
    this.targets = [];
    this.cancelled = 0;
  }
  setValueAtTime(v, t) { this.value = v; this.sets.push({ v, t }); }
  linearRampToValueAtTime(v, t) { this.ramps.push({ v, t }); this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v, t) { this.value = v; this.targets.push({ v, t }); }
  cancelScheduledValues() { this.cancelled++; }
}
class Node {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this._kind = kind;
    this.gain = new Param(1);
    this.frequency = new Param(440);
    this.type = '';
    this.connectedFrom = null;
  }
  connect(dest) { dest.connectedFrom = this; return dest; }
  disconnect() {}
  start() {}
  stop(t) { this.stopAt = t; }
}
class Ctx {
  constructor() { this.currentTime = now; this.nodes = []; this.destination = new Node(this, 'destination'); }
  createOscillator() { const n = new Node(this, 'oscillator'); this.nodes.push(n); return n; }
  createGain() { const n = new Node(this, 'gain'); this.nodes.push(n); return n; }
}

function makeBed(seed, district) {
  const ctx = new Ctx();
  ctx.currentTime = ++now;
  const bed = new InfrasoundBed(ctx, ctx.destination, seed, district);
  return { ctx, bed };
}

// ---- 1. envelope zero-crossing period vs descriptor modHz ------------------
(() => {
  const SAMPLE_HZ = 2000;
  const DURATION = 10;
  for (let d = 0; d <= 4; d++) {
    const { bed } = makeBed(0xc0ffee + d, d);
    const desc = bed.descriptor();
    // sample env across 10 s and measure upward zero crossings of the
    // alternating component (env minus its mean)
    const mean = 1 - desc.depth / 2;
    let crossings = 0;
    let sumInterval = 0;
    let lastUp = null;
    let prev = null;
    for (let i = 0; i <= DURATION * SAMPLE_HZ; i++) {
      const t = i / SAMPLE_HZ;
      const v = env(desc, t) - mean;
      if (prev !== null && prev < 0 && v >= 0) {
        if (lastUp !== null) sumInterval += t - lastUp;
        lastUp = t;
        crossings++;
      }
      prev = v;
    }
    const measuredHz = (crossings - 1) / sumInterval;
    const err = Math.abs(measuredHz - desc.modHz) / desc.modHz;
    check('district ' + d + ': zero-crossing period matches modHz ±2% over 10 s',
      err <= 0.02, 'measured=' + measuredHz.toFixed(4) + ' desc=' + desc.modHz.toFixed(4));
    // the descriptor itself stays near the district's lawful base rate
    check('district ' + d + ': rate sits on base ' + DISTRICT_MOD_HZ[d] +
      ' Hz within seeded jitter', Math.abs(desc.modHz - DISTRICT_MOD_HZ[d]) <= MOD_JITTER_HZ + 1e-9);
  }
})();

// ---- 2. depth bounds ---------------------------------------------------------
(() => {
  let inBounds = true;
  let sawVariety = new Set();
  for (let seed = 0; seed < 40; seed++) {
    for (let d = 0; d <= 4; d++) {
      const { bed } = makeBed(seed * 7919 + d, d);
      const { depth, modHz } = bed.descriptor();
      if (!(depth >= DEPTH_MIN && depth <= DEPTH_MAX)) inBounds = false;
      if (!(modHz > 0 && modHz < 20)) inBounds = false; // sub-20 Hz by law
      sawVariety.add(depth.toFixed(3));
    }
  }
  check('depth stays within [' + DEPTH_MIN + ', ' + DEPTH_MAX + '] across 200 beds', inBounds);
  check('seeds actually vary the depth (not one constant)', sawVariety.size > 5,
    String(sawVariety.size));
})();

// ---- 3. determinism per seed -------------------------------------------------
(() => {
  const snap = (seed, d) => {
    const { bed } = makeBed(seed, d);
    return JSON.stringify(bed.descriptor());
  };
  let same = true;
  for (const seed of [1, 0xdeadbeef, 987654321]) {
    for (let d = 0; d <= 4; d++) {
      if (snap(seed, d) !== snap(seed, d)) same = false;
    }
  }
  check('identical seed+district replay identical descriptors', same);
  const a = snap(11, 2); let differs = false;
  for (let s = 12; s < 60; s++) { if (snap(s, 2) !== a) { differs = true; break; } }
  check('different seeds yield different jitter draws', differs);
})();

// ---- 4. kill-switch ramps to silence ------------------------------------------
(() => {
  const { ctx, bed } = makeBed(42, 3);
  // kill() ramps the bed's own master gain, the node wired to destination
  const master = ctx.destination.connectedFrom;
  check('the bed exposes exactly one node into the destination', !!master && master._kind === 'gain');
  bed.kill();
  const ramp = master.gain.ramps.at(-1);
  check('kill schedules a linear ramp to exactly zero',
    !!ramp && ramp.v === 0 && Math.abs(ramp.t - (ctx.currentTime + KILL_RAMP_S)) < 1e-9,
    JSON.stringify(ramp));
  check('kill cancels prior automation first', master.gain.cancelled === 1);
  bed.kill(); // idempotent
  check('second kill is a no-op', master.gain.ramps.length === 1);
  check('carriers are stopped after the ramp tail',
    ctx.nodes.every((n) => n._kind !== 'oscillator' || typeof n.stopAt === 'number'));
})();

// ---- 5. graph wiring ------------------------------------------------------------
(() => {
  const { ctx, bed } = makeBed(777, 1);
  const oscs = ctx.nodes.filter((n) => n._kind === 'oscillator');
  const gains = ctx.nodes.filter((n) => n._kind === 'gain');
  const desc = bed.descriptor();
  // LFO is the oscillator running at the modulation rate
  const lfo = oscs.find((o) => Math.abs(o.frequency.value - desc.modHz) < 1e-6);
  check('an LFO oscillator runs at exactly descriptor.modHz', !!lfo,
    JSON.stringify(oscs.map((o) => o.frequency.value)));
  // depth/2 swing gain hangs off the LFO
  const swing = gains.find((g) => Math.abs(g.gain.value - desc.depth / 2) < 1e-9);
  check('a gain of depth/2 scales the LFO onto the AM stage', !!swing);
  // AM gain sits at the envelope midpoint 1 - depth/2
  const am = gains.find((g) => Math.abs(g.gain.value - (1 - desc.depth / 2)) < 1e-9);
  check('AM gain rests at the envelope midpoint 1 - depth/2', !!am);
  // carriers: audible harmonics above 20 Hz of one sub-audible fundamental
  const carriers = oscs.filter((o) => o !== lfo).map((o) => o.frequency.value);
  check('three harmonic carriers present, all audible (>20 Hz)',
    carriers.length === 3 && carriers.every((f) => f > 20), JSON.stringify(carriers));
  const sorted = [...carriers].sort((a, b) => a - b);
  const lo = sorted[0];
  check('carriers sit on integer multiples of one shared fundamental',
    sorted.every((f) => {
      const k = (f / lo) * 3; // lowest carrier is the 3rd harmonic
      return Math.abs(k - Math.round(k)) < 1e-6;
    }), JSON.stringify(sorted));
  // retuning moves the LFO, not the carriers
  ctx.currentTime += 1;
  bed.setDistrict(777, 4);
  const next = bed.descriptor();
  check('setDistrict retunes the LFO toward the new district rate',
    Math.abs(lfo.frequency.targets.at(-1).v - next.modHz) < 1e-9 &&
    Math.abs(next.modHz - DISTRICT_MOD_HZ[4]) <= MOD_JITTER_HZ + 1e-9);
  check('carrier frequencies survive district changes untouched',
    oscs.filter((o) => o !== lfo).map((o) => o.frequency.value).join() === carriers.join());
  // district clamping never explodes
  const edge = makeBed(7, 99);
  check('out-of-range district ordinals clamp instead of crashing',
    Math.abs(edge.bed.descriptor().modHz - DISTRICT_MOD_HZ[4]) <= MOD_JITTER_HZ + 1e-9);
})();

process.exit(failures === 0 ? 0 : 1);
