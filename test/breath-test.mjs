/*
 * Player breath layer tests — pure Node, no browser.
 * Drives PlayerBreath / mountPlayerBreath against a minimal WebAudio mock
 * (same construction as crowd-test.mjs) and checks:
 *   1. BREATH_QUALITY self-audit: envelope shape, rate/loudness-vs-effort,
 *      and spectral flatness of the voiced band all pass headlessly
 *   2. graph shape: noise voice through chest peaking + drifting mouth
 *      formant, with a 7 Hz tremor LFO summed into the envelope param
 *   3. exertion: sprint footsteps raise envelope peaks above the resting mix;
 *      tension floors the effort too
 *   4. blackout: held-breath pins the envelope to a shallow hold
 *   5. kill-switch: setEnabled(false) cuts the layer out immediately and
 *      updates become no-ops; mount/dispose is safe to call in any order
 */
import {
  PlayerBreath,
  mountPlayerBreath,
  auditBreathQuality,
  breathRate,
  breathLoudness,
  BREATH_RATE_MIN,
  BREATH_RATE_MAX,
} from '../src/audio/breath.ts';

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.targets = []; // {v, t} from setTargetAtTime
    this.inputs = [];  // connected source nodes (tremor LFO etc.)
  }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v, t) { this.targets.push({ v, t }); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.out = null;
    this.gain = new Param(1); this.frequency = new Param(440);
    this.pan = new Param(0); this.Q = new Param(1);
    this.type = ''; this.buffer = null; this.loop = false;
    this._starts = []; this._stops = [];
  }
  connect(dest) {
    if (dest && typeof dest === 'object' && 'targets' in dest && 'inputs' in dest) {
      dest.inputs.push(this);
    } else {
      this.out = dest;
    }
    return dest;
  }
  disconnect() { this.out = null; }
  start(at) { this._starts.push(at ?? this.ctx.currentTime); }
  stop(at) { this._stops.push(at ?? this.ctx.currentTime); }
}
class Ctx {
  constructor() {
    this.currentTime = now; this.nodes = []; this.sampleRate = 48000;
    this.destination = new Node(this);
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

// ---- 1. quality self-audit ------------------------------------------------
const audit = auditBreathQuality();
for (const [name, ok] of Object.entries(audit.checks)) check('audit: ' + name, ok);
check('audit passes overall', audit.pass, 'flatness=' + audit.flatness.toFixed(3));
check('rate constants are 0.55/0.85 Hz',
  BREATH_RATE_MIN === 0.55 && BREATH_RATE_MAX === 0.85 &&
  Math.abs(breathRate(0.5) - 0.7) < 1e-9);
check('loudness scales up with effort', breathLoudness(1) > breathLoudness(0));

// ---- graph + behavior ------------------------------------------------------
const ctx = new Ctx();
const breath = new PlayerBreath(ctx, ctx.destination);
const STEP = 0.25;
function run(seconds) {
  for (let t = 0; t < seconds; t += STEP) {
    now += STEP;
    ctx.currentTime = now;
    breath.update(STEP);
  }
}
run(1); // build

// ---- 2. graph shape --------------------------------------------------------
const noise = ctx.nodes.find((n) => n._kind === 'buffer-source' && n.buffer !== null && n.loop);
check('loops a noise buffer as the breath voice', noise !== undefined);
const peak = ctx.nodes.find((n) => n._kind === 'filter' && n.type === 'peaking');
check('chest resonance peaking filter near 120 Hz',
  peak !== undefined && peak.frequency.value > 90 && peak.frequency.value < 160,
  peak ? String(peak.frequency.value) : 'missing');
const mouth = ctx.nodes.find((n) => n._kind === 'filter' && n.type === 'bandpass');
check('mouth formant sits in speech-band range',
  mouth !== undefined && mouth.frequency.value > 300 && mouth.frequency.value < 950);
const tremor = ctx.nodes.find((n) => n._kind === 'oscillator' &&
  n.frequency.value >= 6 && n.frequency.value <= 8);
check('anxiety tremor LFO exists at ~7 Hz', tremor !== undefined);
const envGain = ctx.nodes.find((n) => n._kind === 'gain' && n.gain.inputs.length > 0);
check('tremor path sums into an envelope param', envGain !== undefined);

// ---- 3. exertion: resting vs sprint ---------------------------------------
const envNode = () => ctx.nodes.find((n) => n._kind === 'gain' && n.gain.inputs.length > 0);
const env = envNode();
env.gain.targets.length = 0;
run(8); // settle at rest
const restPeak = Math.max(...env.gain.targets.map((x) => x.v));
for (let i = 0; i < 24; i++) breath.notifyFootstep(true);
env.gain.targets.length = 0;
run(4);
const sprintPeak = Math.max(...env.gain.targets.map((x) => x.v));
check('sprint steps push envelope peaks above resting', sprintPeak > restPeak * 1.15,
  `rest=${restPeak.toFixed(3)} sprint=${sprintPeak.toFixed(3)}`);

// ---- 4. blackout held breath ----------------------------------------------
breath.setBlackout(true);
env.gain.targets.length = 0;
run(1.5);
const heldMax = Math.max(...env.gain.targets.map((x) => x.v));
check('blackout pins the envelope to a shallow hold', heldMax <= 0.08, String(heldMax));
breath.setBlackout(false);
env.gain.targets.length = 0;
run(1.5);
check('envelope resumes after the blackout lifts',
  Math.max(...env.gain.targets.map((x) => x.v)) > heldMax * 2);

// ---- 5. kill-switch + mount lifecycle -------------------------------------
const out = ctx.nodes.find((n) => n._kind === 'gain' && n.out === ctx.destination); // master gate
breath.setEnabled(false);
check('kill-switch ramps the master gate to zero immediately',
  out.gain.targets.at(-1)?.v === 0);
env.gain.targets.length = 0;
run(2);
check('disabled instance stops automating the envelope', env.gain.targets.length === 0);

// mount: event subscription, dispose safety
let emitted = 0;
const listeners = new Set();
const playerEvents = {
  on(key, fn) {
    if (key !== 'footstep') throw new Error('unexpected key ' + key);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
function emitFootstep(running) {
  emitted++;
  for (const fn of [...listeners]) fn({ running });
}
const ctx2 = new Ctx();
const handle = mountPlayerBreath({
  ctx: ctx2,
  destination: ctx2.destination,
  playerEvents,
  tension: () => 0.5,
  blackout: () => false,
});
now += 1; ctx2.currentTime = now;
emitFootstep(false);
handle.update(0.1);
check('mounted layer builds exactly one noise voice',
  ctx2.nodes.filter((n) => n._kind === 'buffer-source').length === 1);
check('footsteps reach the mounted layer', emitted === 1);
handle.dispose();
check('dispose unsubscribes the footstep listener', listeners.size === 0);
emitFootstep(true); // must not throw or reach anything
handle.update(0.5); // must be a silent no-op after dispose
const mounts = ctx2.nodes.filter((n) => n._kind === 'buffer-source');
check('dispose stopped the noise voice', mounts.every((n) => n._stops.length > 0));
handle.dispose(); // double-dispose is safe

console.log(failures.length === 0
  ? '\nALL PASS'
  : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
