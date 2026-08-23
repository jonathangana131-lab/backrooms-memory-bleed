/*
 * Door creak ambience tests — pure Node, no browser.
 * Drives DoorCreaks against a minimal WebAudio mock and checks:
 *   1. a creak builds the expected sawtooth -> lowpass -> gain -> pan graph
 *   2. scheduler fires every 45-90 s of calm time only
 *   3. never two consecutive creaks from the same compass quadrant
 *   4. torch toward the origin within 3 s schedules a softer answer creak
 */
import { DoorCreaks } from '../src/audio/doors.ts';

// ---- minimal AudioContext mock -------------------------------------------
let now = 100;
class Param {
  constructor(v) { this.value = v; this.max = 0; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; if (v > this.max) this.max = v; }
  exponentialRampToValueAtTime(v) { if (v > 0) this.value = v; }
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.inputs = []; this.out = null;
    this.gain = new Param(1); this.frequency = new Param(440);
    this.pan = new Param(0); this.Q = new Param(1); this.type = '';
  }
  connect(dest) { dest.inputs.push(this); this.out = dest; return dest; } // forward edge in .out
  start() {}
  stop() {}
}
class Ctx {
  constructor() {
    this.currentTime = now; this.nodes = [];
    this.destination = new Node(this); this.destination._kind = 'destination';
  }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new Node(this); n._kind = 'filter'; this.nodes.push(n); return n; }
  createStereoPanner() { const n = new Node(this); n._kind = 'panner'; this.nodes.push(n); return n; }
}

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

// Advance in small steps so each potential creak lands at a known instant.
const STEP = 0.25;
function advance(creaks, seconds, tension = 0) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    now += STEP;
    ctx.currentTime = now;
    creaks.update(STEP, tension);
  }
}
// Advance until exactly one more creak has fired (or timeout); returns its osc.
function nextDoor(creaks, maxSeconds) {
  const startCount = countCreaks();
  for (let t = 0; t < maxSeconds; t += STEP) {
    now += STEP;
    ctx.currentTime = now;
    creaks.update(STEP, 0);
    if (countCreaks() > startCount) return lastOsc();
  }
  return null;
}
let oscs = [];
function countCreaks() { oscs = ctx.nodes.filter((n) => n._kind === 'oscillator'); return oscs.length; }
function lastOsc() { return oscs[oscs.length - 1]; }

// Graph walkers follow forward edges (mock stores them in .out).
function downstream(osc, kind) {
  let cur = osc.out;
  while (cur && cur._kind !== kind) cur = cur.out;
  return cur ?? null;
}
const peakOf = (osc) => downstream(osc, 'gain')?.gain.max ?? 0;
const panOf = (osc) => downstream(osc, 'panner')?.pan.value ?? null;

// ---- 1+3: first scheduled creak, graph shape ------------------------------
const ctx = new Ctx();
const creaks = new DoorCreaks(ctx, ctx.destination);
const door1 = nextDoor(creaks, 30);
check('a creak fired within ~30 s of calm', door1 !== null);
if (door1) {
  check('voice is a sawtooth', door1.type === 'sawtooth', String(door1.type));
  check('sweep starts near 80 Hz', door1.frequency.value >= 60 && door1.frequency.value <= 110,
    String(door1.frequency.value));
  const lp = downstream(door1, 'filter');
  const g = downstream(door1, 'gain');
  const p = downstream(door1, 'panner');
  check('graph is osc->lowpass->gain->panner->out',
    lp?._kind === 'filter' && lp.type === 'lowpass'
      && g?._kind === 'gain' && p?._kind === 'panner' && p.out === ctx.destination,
    JSON.stringify({ lp: lp?.type, g: !!g, p: !!p }));
  check('lowpass keeps it muffled', lp && lp.frequency.value >= 400 && lp.frequency.value <= 1400,
    String(lp?.frequency.value));
  check('panner is in stereo range', p !== null && Math.abs(p.pan.value) <= 1);
  check('creak is quiet (< 0.12 peak)', peakOf(door1) > 0 && peakOf(door1) < 0.12, String(peakOf(door1)));
  check('quadrant recorded', creaks.lastDoorQuadrant >= 0 && creaks.lastDoorQuadrant <= 3);

  // ---- 4: torch response — beam immediately, window must be open --------
  check('beam window open right after creak', creaks.awaitingBeam === true);
  const beforeAnswer = countCreaks();
  creaks.torchToward(panOf(door1));
  check('matching beam accepted', creaks.awaitingBeam === false);
  advance(creaks, 2);
  check('answer creak sounded within ~1.5 s of beam', countCreaks() === beforeAnswer + 1,
    'before=' + beforeAnswer + ' after=' + countCreaks());
  const ans = lastOsc();
  check('answer comes from the same bearing', Math.abs(panOf(ans) - panOf(door1)) < 0.01,
    panOf(ans) + ' vs ' + panOf(door1));
  check('answer is softer than the door creak', peakOf(ans) <= peakOf(door1),
    peakOf(ans) + ' vs ' + peakOf(door1));

  // wrong-direction beam does nothing (fresh door first)
  ctx.nodes.length = 0;
  const door2 = nextDoor(creaks, 95);
  check('door creaked again before wrong-beam test', door2 !== null);
  const preWrong = countCreaks();
  // far across the stereo field, guaranteed > 0.45 away from the door
  const away = panOf(door2) >= 0 ? -1 : 1;
  creaks.torchToward(Math.max(-1, Math.min(1, panOf(door2) + 1.3 * (away)))) ;
  advance(creaks, 2);
  check('wrong-direction beam gets no answer', countCreaks() === preWrong);

  // stale beam (> 3 s after the creak) does nothing either
  ctx.nodes.length = 0;
  const door3 = nextDoor(creaks, 95);
  check('door creaked again before late-beam test', door3 !== null);
  advance(creaks, 4); // let the 3 s window lapse without beaming
  check('beam window closed after 3 s', creaks.awaitingBeam === false);
  const preLate = countCreaks();
  creaks.torchToward(panOf(door3));
  advance(creaks, 2);
  check('late beam (> 3 s) gets no answer', countCreaks() === preLate);
}

// ---- 2: pacing — gap between doors stays within 45-90 s -------------------
ctx.nodes.length = 0;
const gaps = [];
let lastFire = now;
for (let guard = 0; guard < 6; guard++) {
  const d = nextDoor(creaks, 95);
  if (!d) break;
  gaps.push(now - lastFire);
  lastFire = now;
}
check('measured several inter-door gaps', gaps.length >= 3, String(gaps.length));
check('all gaps within 45-90 s (plus one step of slop)',
  gaps.every((x) => x >= 45 - STEP && x <= 90 + STEP), JSON.stringify(gaps));

// tension suppresses creaks entirely
ctx.nodes.length = 0;
advance(creaks, 200, 0.8);
check('tense phases never creak', countCreaks() === 0, 'count=' + countCreaks());

// ---- 3: quadrant never repeats across many doors --------------------------
ctx.nodes.length = 0;
let repeats = false;
let prev = creaks.lastDoorQuadrant;
for (let i = 0; i < 20; i++) {
  const d = nextDoor(creaks, 95);
  if (!d) { repeats = 'stalled'; break; }
  const q = creaks.lastDoorQuadrant;
  if (q === prev) repeats = true;
  prev = q;
}
check('never same quadrant twice in a row over ~20 doors', repeats === false, String(repeats));

console.log('\n=== DOORS TEST ===');
if (failures.length === 0) console.log('PASS: all door creak ambience checks green');
else { console.log('FAIL: ' + failures.length + ' check(s): ' + failures.join('; ')); process.exit(1); }


