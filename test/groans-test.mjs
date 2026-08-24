/*
 * Structure groan ambience tests — pure Node, no browser.
 * Drives StructureGroans against a minimal WebAudio mock and checks:
 *   1. settlement groans build osc(sawtooth 40-80 Hz)->lowpass->gain->pan
 *      with a ~0.5 s attack and a 2-4 s decay
 *   2. pipe knocks are resonant noise bursts: knock, ~0.5 s gap, then a
 *      fainter, duller knock further away
 *   3. events fire every 90-180 s at zero tension; tension dilates the
 *      countdown so tense phases hear proportionally fewer groans
 *   4. pan + attenuation are randomized per event
 *   5. stop() silences the scheduler
 *
 * Standalone in Node; the TS module is bundled with esbuild so its
 * '../core/rng' import resolves.
 */
import { createRequire } from 'node:module';
import { writeFileSync, readdirSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const pnpmDir = process.cwd() + '/node_modules/.pnpm';
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
    if (!entry) throw new Error('esbuild not found in node_modules');
    return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
  }
}

const esbuild = loadEsbuild();
const BUILT = process.cwd() + '/test/.groans-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/audio/groans.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);
const { StructureGroans } = await import('./.groans-build.mjs');

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.ramps = []; // {v, t, kind}
    this.sets = [];  // {v, t}
  }
  setValueAtTime(v, t) { this.value = v; this.sets.push({ v, t }); }
  linearRampToValueAtTime(v, t) { this.value = v; this.ramps.push({ v, t, kind: 'lin' }); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.ramps.push({ v, t, kind: 'exp' }); }
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
/** Loudest value the param ever reached through automation. */
const autoPeak = (p) => Math.max(...p.sets.map((s) => s.v), ...p.ramps.map((r) => r.v));
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.out = null;
    this.gain = new Param(1); this.frequency = new Param(440);
    this.pan = new Param(0); this.Q = new Param(1); this.type = '';
    this.buffer = null; this._startAt = -1; this._stopAt = -1;
  }
  connect(dest) { this.out = dest; return dest; }
  start(at) { this._startAt = at ?? this.ctx.currentTime; }
  stop(at) { this._stopAt = at ?? this.ctx.currentTime; }
}
class Ctx {
  constructor() {
    this.currentTime = now; this.nodes = []; this.sampleRate = 48000;
    this.destination = new Node(this); this.destination._kind = 'destination';
  }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new Node(this); n._kind = 'filter'; this.nodes.push(n); return n; }
  createStereoPanner() { const n = new Node(this); n._kind = 'panner'; this.nodes.push(n); return n; }
  createBufferSource() { const n = new Node(this); n._kind = 'buffer-source'; this.nodes.push(n); return n; }
  createBuffer(ch, len, rate) {
    return { numberOfChannels: ch, length: len, sampleRate: rate,
      getChannelData: () => new Float32Array(len) };
  }
}

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

const STEP = 0.25;
const groansByKind = () => ctx.nodes.filter((n) => n._kind === 'oscillator');
const knocks = () => ctx.nodes.filter((n) => n._kind === 'buffer-source');
// Advance until one more event fires (or timeout); returns its lead node.
function nextEvent(groans, maxSeconds, tension = 0) {
  const o0 = groansByKind().length;
  const s0 = knocks().length;
  for (let t = 0; t < maxSeconds; t += STEP) {
    now += STEP;
    ctx.currentTime = now;
    groans.update(STEP, tension);
    const oscs = groansByKind();
    const srcs = knocks();
    // Return the lead node of whichever kind actually fired.
    if (oscs.length > o0) return oscs[oscs.length - 1];
    if (srcs.length > s0) return srcs[srcs.length - 1];
  }
  return null;
}

function downstream(node, kind) {
  let cur = node.out;
  while (cur && cur._kind !== kind) cur = cur.out;
  return cur ?? null;
}
const gainOf = (lead) => downstream(lead, 'gain').gain;
const panOf = (lead) => downstream(lead, 'panner')?.pan.value ?? null;

// ---- 1: settlement groan graph + envelope ---------------------------------
const ctx = new Ctx();
const ambience = new StructureGroans(ctx, ctx.destination);
let sawGroan = null;
let guard = 0;
while (!sawGroan && guard++ < 10) {
  const ev = nextEvent(ambience, 200);
  if (ev?._kind === 'oscillator') sawGroan = ev;
}
check('a settlement groan fired within a few events', sawGroan !== null);
if (sawGroan) {
  check('groan voice is a sawtooth', sawGroan.type === 'sawtooth', String(sawGroan.type));
  // Mock ramps overwrite .value, so judge the band by the initial set point.
  const fStart = sawGroan.frequency.sets[0].v;
  check('groan sits in the 40-80 Hz band', fStart >= 40 && fStart <= 80, String(fStart));
  const lp = downstream(sawGroan, 'filter');
  const p = downstream(sawGroan, 'panner');
  check('graph is osc->lowpass->gain->panner->out',
    lp?._kind === 'filter' && lp.type === 'lowpass' && p?._kind === 'panner' && p.out === ctx.destination,
    JSON.stringify({ lp: lp?.type, p: !!p }));
  check('lowpass keeps it deep', lp.frequency.value >= 60 && lp.frequency.value <= 300,
    String(lp.frequency.value));
  const g = gainOf(sawGroan);
  const linPeaks = g.ramps.filter((r) => r.kind === 'lin');
  const peakRamp = linPeaks.reduce((m, r) => (r.v >= m.v ? r : m), linPeaks[0]);
  const endRamp = g.ramps[g.ramps.length - 1];
  const t0 = g.sets[0]?.t ?? 0;
  check('slow attack ~0.5 s', Math.abs((peakRamp.t - t0) - 0.5) < 0.05, String(peakRamp.t - t0));
  const total = endRamp.t - t0;
  check('decay 2-4 s after the attack', total >= 2.4 && total <= 4.6, String(total));
  check('attack rises from near silence to an audible swell',
    g.sets[0].v < 0.001 && peakRamp.v > 0.0005,
    JSON.stringify({ from: g.sets[0].v, peak: peakRamp.v }));
}

// ---- 2: pipe knocks — pair, gap, fainter further away ---------------------
ctx.nodes.length = 0;
let knockLead = null;
guard = 0;
while (!knockLead && guard++ < 12) {
  const ev = nextEvent(ambience, 220);
  if (ev?._kind === 'buffer-source') knockLead = ev;
}
check('a pipe-knock event fired within a few events', knockLead !== null);
if (knockLead) {
  const pair = knocks().slice(-2);
  check('knock event is two bursts', pair.length === 2, String(pair.length));
  if (pair.length === 2) {
    const [a, b] = pair;
    check('both bursts read the same noise buffer', a.buffer != null && b.buffer === a.buffer);
    const bpA = downstream(a, 'filter');
    const bpB = downstream(b, 'filter');
    check('bursts run through bandpass filters',
      bpA?.type === 'bandpass' && bpB?.type === 'bandpass',
      JSON.stringify([bpA?.type, bpB?.type]));
    check('bandpass is resonant (metallic)', bpA.Q.value >= 4, String(bpA.Q.value));
    const gap = b._startAt - a._startAt;
    check('second knock follows ~0.5 s later', gap >= 0.45 && gap <= 0.75, String(gap));
    const gA = autoPeak(downstream(a, 'gain').gain);
    const gB = autoPeak(downstream(b, 'gain').gain);
    check('second knock is fainter (travelling away)', gB < gA, gB + ' vs ' + gA);
    check('second knock rings duller (further away)', bpB.frequency.value < bpA.frequency.value,
      bpB.frequency.value + ' vs ' + bpA.frequency.value);
  }
}

// ---- 3: pacing — 90-180 s calm, stretched under tension -------------------
ctx.nodes.length = 0;
const gaps = [];
let lastFire = now;
for (let i = 0; i < 6; i++) {
  const ev = nextEvent(ambience, 220);
  if (!ev) break;
  gaps.push(now - lastFire);
  lastFire = now;
}
check('measured several inter-event gaps', gaps.length >= 3, String(gaps.length));
check('calm gaps within 90-180 s (plus slop)',
  gaps.every((x) => x >= 90 - STEP && x <= 180 + STEP), JSON.stringify(gaps));

// Constant full tension dilates the countdown 3x: real gaps become 270-540 s.
ctx.nodes.length = 0;
{
  const ev = nextEvent(ambience, 600, 1);
  check('an event still fires under tension eventually', ev !== null);
  if (ev) {
    const start = now;
    const ev2 = nextEvent(ambience, 700, 1);
    check('full tension stretches the real-time gap past 270 s',
      ev2 !== null && now - start >= 270 - STEP, String(ev2 ? now - start : 'none'));
  }
}

// ---- 4: spatial randomization ---------------------------------------------
ctx.nodes.length = 0;
const pans = [];
for (let i = 0; i < 8; i++) {
  const ev = nextEvent(ambience, 220);
  if (!ev) break;
  pans.push(Math.round(panOf(ev) * 100) / 100);
}
check('collected several event placements', pans.length >= 4, JSON.stringify(pans));
check('pans vary across events', new Set(pans).size >= 4, JSON.stringify(pans));
check('all pans stay in stereo range', pans.every((x) => Math.abs(x) <= 1));

// ---- 5: stop() -------------------------------------------------------------
ambience.stop();
ctx.nodes.length = 0;
nextEvent(ambience, 500);
check('stopped scheduler never fires again', ctx.nodes.length === 0,
  'count=' + ctx.nodes.length);

console.log('\n=== GROANS TEST ===');
if (failures.length === 0) console.log('PASS: all structure groan checks green');
else { console.log('FAIL: ' + failures.length + ' check(s): ' + failures.join('; ')); process.exit(1); }


