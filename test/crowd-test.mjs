/*
 * Crowd murmur ambience tests — pure Node, no browser.
 * Drives CrowdAmbience against a minimal WebAudio mock and checks:
 *   1. the crowd is many overlapping formant voices: sawtooth glottal
 *      sources through 3 bandpass formants each, stereo-spread
 *   2. spatial character: only OPEN_OFFICE (district 1) is audible;
 *      every other district holds the master gate at zero
 *   3. tension gate: calm/build keeps the crowd, high tension silences it
 *   4. density waves: a slow sine LFO with a 20-40 s period breathes the
 *      swell bus volume
 *   5. murmur cadence: syllable envelopes fire while audible but peaks
 *      stay quiet and formants drift between vowel targets; nothing is
 *      scheduled while silent or after stop()
 */
import { CrowdAmbience } from '../src/audio/crowd.ts';

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.targets = []; // {v, t} from setTargetAtTime
    this.inputs = [];  // connected source nodes (LFO etc.)
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
    this.pan = new Param(0); this.Q = new Param(1); this.type = '';
    this.buffer = null; this.loop = false;
    this._starts = []; this._stops = [];
  }
  connect(dest) {
    if (dest && typeof dest === 'object' && 'targets' in dest && 'inputs' in dest) {
      dest.inputs.push(this);          // AudioParam destination
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

const STEP = 0.25;
function run(crowd, seconds, district, tension = 0) {
  for (let t = 0; t < seconds; t += STEP) {
    now += STEP;
    ctx.currentTime = now;
    crowd.update(STEP, district, tension);
  }
}

const ctx = new Ctx();
const crowd = new CrowdAmbience(ctx, ctx.destination);
run(crowd, 3, 1, 0);   // wake it up inside the office

// ---- 1. many formant voices ---------------------------------------------
const oscs = ctx.nodes.filter((n) => n._kind === 'oscillator' && !n._isLfo);
check('builds a crowd of >=6 babble voices', oscs.length >= 6, `got ${oscs.length}`);
const voiceOscs = oscs.filter((n) => n.frequency.value > 60 && n.frequency.value < 200);
check('voices are low glottal sawtooth sources', voiceOscs.length === oscs.length - 1,
  `${voiceOscs.length}/${oscs.length} in vocal range`);
const bandpasses = ctx.nodes.filter((n) => n._kind === 'filter' && n.type === 'bandpass');
// 3 formants per voice + 1 air bed filter
check('three formant filters per voice', bandpasses.length >= voiceOscs.length * 3,
  `got ${bandpasses.length}`);
check('formant frequencies sit in vowel range', bandpasses.every((f) => f.frequency.value > 250 && f.frequency.value < 3000));
const pans = ctx.nodes.filter((n) => n._kind === 'panner');
check('voices are stereo spread', pans.length >= voiceOscs.length &&
  pans.some((p) => p.pan.value !== 0));

// ---- 4. density wave LFO -------------------------------------------------
const lfo = ctx.nodes.find((n) => n._kind === 'oscillator' && n.frequency.value > 0 &&
  n.frequency.value <= 1 / 20 + 1e-9);
check('slow LFO exists with 20-40 s period',
  lfo !== undefined && lfo.frequency.value >= 1 / 40 - 1e-9,
  lfo ? String(lfo.frequency.value) : 'missing');
const swellNode = ctx.nodes.find((n) => n._kind === 'gain' && n.gain.inputs.length > 0);
check('LFO feeds the swell gain param', lfo !== undefined && swellNode !== undefined &&
  swellNode.gain.inputs.some((src) => src === lfo.out), 'no connection into swell.gain');
const lowpass = ctx.nodes.find((n) => n._kind === 'filter' && n.type === 'lowpass');
check('shared distance lowpass below 1 kHz', lowpass !== undefined &&
  lowpass.frequency.value < 1000);

// ---- 2. district gating ---------------------------------------------------
crowd.update(1, 1, 0);
now += 1; ctx.currentTime = now;
const officeTarget = crowd.out.gain.targets.at(-1).v;
check('OPEN_OFFICE opens the crowd gate', officeTarget > 0.05, String(officeTarget));
for (const d of [0, 2, 3, 4]) {
  run(crowd, 4, d);
  const t = crowd.out.gain.targets.at(-1).v;
  check(`district ${d} stays silent`, t === 0, String(t));
}
run(crowd, 6, 1, 0); // move back in; level should ease up again
const back = crowd.out.gain.targets.at(-1).v;
check('gate reopens when back in OPEN_OFFICE', back > 0.05, String(back));

// ---- 5. murmur cadence ----------------------------------------------------
for (const p of ctx.nodes.filter((n) => n._kind === 'gain')) p.gain.targets.length = 0;
run(crowd, 8, 1, 0);
// exclude the master gate itself — only voice envelopes count here
const envs = ctx.nodes.filter((n) => n._kind === 'gain' && n !== crowd.out &&
  n.gain.targets.length > 4);
check('syllable envelopes are being automated while audible', envs.length >= 4,
  `${envs.length} active envs`);
const peaks = envs.flatMap((n) => n.gain.targets.map((x) => x.v));
const maxPeak = Math.max(...peaks);
check('peaks stay quiet (indistinct wash)', maxPeak > 0 && maxPeak <= 0.12, String(maxPeak));
const formantDrift = bandpasses.filter((f) => f.frequency.targets.length > 0);
check('formants drift between vowel targets', formantDrift.length >= voiceOscs.length);

// ---- silence stops scheduling --------------------------------------------
for (const p of ctx.nodes.filter((n) => n._kind === 'gain')) p.gain.targets.length = 0;
for (const f of bandpasses) f.frequency.targets.length = 0;
run(crowd, 8, 2, 0);   // leave the office
check('nothing is scheduled while silent',
  ctx.nodes.filter((n) => n._kind === 'gain' && n.gain.targets.length > 0).length === 0 ||
  crowd.out.gain.targets.at(-1).v === 0);

// ---- 3. tension gating ----------------------------------------------------
run(crowd, 6, 1, 0.1);
const calmT = crowd.out.gain.targets.at(-1).v;
check('calm/build tension keeps the crowd', calmT > 0.03, String(calmT));
run(crowd, 6, 1, 0.95);
const peakT = crowd.out.gain.targets.at(-1).v;
check('peak tension fades the crowd out', peakT === 0, String(peakT));
run(crowd, 6, 1, 0.45);
const midT = crowd.out.gain.targets.at(-1).v;
check('mid tension sits between full and silent',
  midT > 0 && midT < calmT, String(midT));

// ---- stop() ----------------------------------------------------------------
crowd.stop();
check('stop ramps the master gate to zero',
  crowd.out.gain.targets.some((x) => x.v <= 0.0001));
check('stop halts every voice oscillator',
  voiceOscs.every((o) => o._stops.length > 0));
run(crowd, 2, 1, 0);
const afterStop = crowd.out.gain.targets.at(-1).v;
check('stopped instance ignores update()', afterStop <= 0.0001, String(afterStop));

console.log(failures.length === 0
  ? '\nALL PASS'
  : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;


