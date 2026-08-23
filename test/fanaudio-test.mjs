/*
 * Ceiling fan audio tests - pure Node, no browser.
 * Drives FanAudio against a minimal WebAudio mock and checks:
 *   1. update() without any speed set is silent
 *   2. setSpeed(>0) starts a 55 Hz sawtooth motor wired to the destination;
 *      raising the speed keeps the same motor voice
 *   3. blade-pass whooshes fire at 4 blades x rev/s - cadence scales with
 *      rev/s and each burst runs noise -> lowpass -> gain envelope
 *   4. setSpeed(0) stops the motor and silences whooshes
 *   5. stop() clears everything and is safe to call twice
 */
import { FanAudio } from '../src/audio/fanaudio.ts';

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
  setTargetAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
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
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' - ' + detail));
  if (!cond) failures.push(name);
}

const STEP = 0.05;
const ctx = new Ctx();
const fan = new FanAudio(ctx, ctx.destination);

const oscillators = () => ctx.nodes.filter((n) => n._kind === 'oscillator');
/** Most recently created oscillator (the current motor voice). */
const motorOsc = () => oscillators()[oscillators().length - 1] ?? null;
const whooshes = () => ctx.nodes.filter((n) => n._kind === 'buffer-source');
/** Advance the sim, ticking update() every STEP seconds. */
function run(seconds) {
  for (let t = 0; t < seconds - 1e-9; t += STEP) {
    now += STEP;
    ctx.currentTime = now;
    fan.update(STEP);
  }
}
/** Tick until one more whoosh appears (or give up); returns it or null. */
function nextWhoosh(maxSeconds = 2) {
  const before = whooshes().length;
  const end = now + maxSeconds;
  while (now < end && whooshes().length === before) {
    now += STEP;
    ctx.currentTime = now;
    fan.update(STEP);
  }
  return whooshes().length > before ? whooshes()[whooshes().length - 1] : null;
}

// ---- 1: update() before any speed is silent -------------------------------
ctx.nodes.length = 0;
run(2);
check('update() with no speed set creates nothing',
  ctx.nodes.length === 0, 'count=' + ctx.nodes.length);

// ---- 2: setSpeed(>0) spins up the motor -----------------------------------
ctx.nodes.length = 0;
fan.setSpeed(2);
{
  const m = motorOsc();
  check('setSpeed(2) starts a motor oscillator', m !== null);
  if (m) {
    check('motor is a sawtooth', m.type === 'sawtooth', String(m.type));
    check('motor hums at 55 Hz', Math.abs(m.frequency.value - 55) < 0.5,
      String(m.frequency.value));
    check('motor gain starts audible (~0.006)',
      m.out !== null && m.out._kind === 'gain' && m.out.gain.value > 0.001,
      String(m.out && m.out.gain.value));
    check('motor routes to the destination', m.out !== null && m.out.out === ctx.destination);
  }
}
// Raising speed must NOT restart the motor (same voice, just retargeted gain).
const motorBefore = motorOsc();
fan.setSpeed(4);
check('speed change keeps the same motor voice', motorOsc() === motorBefore);

// ---- 3: whoosh cadence scales with rev/s ----------------------------------
ctx.nodes.length = 0;
fan.setSpeed(2); // 2 rev/s x 4 blades = 8 blade-passes/s
run(1);
const fastWhooshes = whooshes().length;
check('at 2 rev/s roughly 8 whooshes per second fire',
  fastWhooshes >= 7 && fastWhooshes <= 9, String(fastWhooshes));

ctx.nodes.length = 0;
fan.setSpeed(1); // half speed -> 4 passes/s
run(1);
const slowWhooshes = whooshes().length;
check('at 1 rev/s roughly 4 whooshes per second fire',
  slowWhooshes >= 3 && slowWhooshes <= 5, String(slowWhooshes));
check('halving rev/s halves the whoosh rate',
  Math.abs(slowWhooshes - fastWhooshes / 2) <= 1,
  slowWhooshes + ' vs half of ' + fastWhooshes);

// Anatomy of one whoosh burst at 2 rev/s.
ctx.nodes.length = 0;
fan.setSpeed(2);
const w = nextWhoosh();
check('a whoosh fires within ~one blade-pass of spinning up', w !== null);
if (w) {
  check('whoosh reads the shared noise buffer', w.buffer != null &&
    w.buffer.length === ctx.sampleRate);
  const lp = w.out;
  check('whoosh runs through a lowpass filter',
    lp !== null && lp._kind === 'filter' && lp.type === 'lowpass');
  // cutoff = 300 + revs*200 -> 700 Hz at 2 rev/s
  check('cutoff brightens with speed (~700 Hz at 2 rev/s)',
    Math.abs(lp.frequency.value - 700) < 1, String(lp.frequency.value));
  const g = lp.out;
  check('whoosh envelope ends in a gain feeding the destination',
    g !== null && g._kind === 'gain' && g.out === ctx.destination);
  const peak = g.gain.ramps.filter((r) => r.kind === 'lin')
    .reduce((m, r) => (r.v >= m.v ? r : m), g.gain.ramps[0]);
  // peak = 0.012 + revs*0.01 -> 0.032 at 2 rev/s
  check('whoosh peaks louder at speed (~0.032)',
    Math.abs(peak.v - 0.032) < 0.001, String(peak.v));
  check('burst attack is a tight 30 ms swell',
    Math.abs((peak.t - g.gain.sets[0].t) - 0.03) < 0.005,
    String(peak.t - g.gain.sets[0].t));
  const endRamp = g.gain.ramps[g.gain.ramps.length - 1];
  check('burst decays within one blade-pass interval (<0.15 s)',
    endRamp.t - g.gain.sets[0].t < 0.15, String(endRamp.t - g.gain.sets[0].t));
}
// Faster spin also opens the filter: compare cutoffs across speeds.
{
  ctx.nodes.length = 0;
  fan.setSpeed(1);
  const ws = nextWhoosh();
  const cutSlow = ws ? ws.out.frequency.value : 0;
  ctx.nodes.length = 0;
  fan.setSpeed(2);
  const wf = nextWhoosh();
  const cutFast = wf ? wf.out.frequency.value : 0;
  check('faster spin opens the whoosh filter', cutFast > cutSlow,
    cutFast + ' vs ' + cutSlow);
}

// ---- 4: setSpeed(0) kills the motor and silences whooshes -----------------
const liveMotor = motorBefore; // same voice has been running since section 2
ctx.nodes.length = 0;
fan.setSpeed(0);
check('setSpeed(0) stops the motor oscillator', liveMotor._stopAt >= 0,
  'stopAt=' + liveMotor._stopAt);
run(1);
check('zero speed produces no whooshes', whooshes().length === 0,
  String(whooshes().length));

// Restarting after a full stop spins a fresh, running motor back up.
fan.setSpeed(2);
const restarted = motorOsc();
check('restart after zero spawns a fresh motor',
  restarted !== null && restarted !== liveMotor);
check('restarted motor is running again (never stopped)',
  restarted !== null && restarted._stopAt < 0);

// ---- 5: stop() clears everything, double-stop safe ------------------------
fan.stop();
check('stop() stops the motor oscillator', restarted._stopAt >= 0,
  'stopAt=' + restarted._stopAt);
ctx.nodes.length = 0;
run(2);
check('stopped fan never whooshes again', whooshes().length === 0,
  String(whooshes().length));

let doubleStopThrew = false;
try { fan.stop(); fan.stop(); } catch (e) { doubleStopThrew = true; }
check('double stop() does not throw', !doubleStopThrew);
ctx.nodes.length = 0;
run(1);
check('fan stays silent after repeated stops', ctx.nodes.length === 0,
  'count=' + ctx.nodes.length);

console.log('');
console.log('=== FANAUDIO TEST ===');
if (failures.length === 0) console.log('PASS: all fan audio checks green');
else { console.log('FAIL: ' + failures.length + ' check(s): ' + failures.join('; ')); process.exit(1); }


