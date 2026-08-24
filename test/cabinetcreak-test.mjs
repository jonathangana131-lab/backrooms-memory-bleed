/**
 * Cabinet creak ambience tests -- pure Node, no browser.
 *
 * Drives CabinetCreaks against a minimal WebAudio mock and checks:
 *   1. silence far from every cabinet
 *   2. entering range fires exactly one voice per cabinet
 *   3. loitering never machine-guns; leaving rearms the cabinet
 *   4. pan mirrors which side the cabinet sits on (facing -Z, +X is left)
 *   5. closer cabinets creak louder
 *   6/7/8. creak character: sine hinge whine sweeping ~400 -> ~600 Hz over
 *      ~300 ms through gain -> stereo panner -> destination
 *
 * Run: node test/cabinetcreak-test.mjs
 */
import { CabinetCreaks } from '../src/audio/cabinetcreak.ts';

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}


// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.events = []; // ['set'|'lin'|'exp', v, t]
  }
  setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(['exp', v, t]); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.out = null; this.edges = [];
    this.gain = new Param(1); this.frequency = new Param(440);
    this.pan = new Param(0); this.Q = new Param(1); this.type = '';
    this.stoppedCount = 0;
  }
  connect(dest) { this.out = dest; this.edges.push(dest); return dest; }
  start(at) { void at; }
  stop(at) { void at; this.stoppedCount++; }
}
class Ctx {
  constructor() {
    this.currentTime = now; this.nodes = []; this.sampleRate = 48000;
    this.destination = new Node(this); this.destination._kind = 'destination';
  }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
  createStereoPanner() { const n = new Node(this); n._kind = 'panner'; this.nodes.push(n); return n; }
}

function close(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}
function downstream(node, kind) {
  let cur = node.out;
  while (cur && cur._kind !== kind) cur = cur.out;
  return cur ?? null;
}
function oscsSince(ctx, mark) { return ctx.nodes.slice(mark).filter((n) => n._kind === 'oscillator'); }

// A lone cabinet in its own room; the pair near the origin shares a pocket.
const CAB = { x: 4, z: -3 };
function freshCabinets(ctx) {
  const cc = new CabinetCreaks(ctx, ctx.destination);
  cc.setCabinets([
    { x: 0.9, z: 0.5 },
    { x: -0.7, z: 0.8 },
    { x: CAB.x, z: CAB.z },
  ]);
  return cc;
}

// ---- 1: silence far from every cabinet ---------------------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  cc.update(1 / 60, 40, 40);
  cc.update(1 / 60, -25, 18);
  check('no creaks far from every cabinet', oscsSince(ctx, 0).length === 0,
    String(oscsSince(ctx, 0).length));
}

// ---- 2: entering range fires exactly one voice per cabinet --------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  cc.update(1 / 60, CAB.x - 1, CAB.z);
  check('entering range fires exactly one creak', oscsSince(ctx, 0).length === 1,
    String(oscsSince(ctx, 0).length));
}

{
  const ctx2 = new Ctx();
  const cc2 = freshCabinets(ctx2);
  cc2.update(1 / 60, 0.25, 0);
  check('two simultaneous entries both fire', oscsSince(ctx2, 0).length === 2,
    String(oscsSince(ctx2, 0).length));
}

// ---- 3: loitering never machine-guns; leaving rearms ---------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  cc.update(1 / 60, CAB.x - 1, CAB.z);
  const first = oscsSince(ctx, 0).length;
  for (let i = 0; i < 120; i++) cc.update(1 / 60, CAB.x - 1, CAB.z);
  check('loitering inside range does not retrigger', oscsSince(ctx, 0).length === first,
    String(oscsSince(ctx, 0).length));
  // Step well past the hysteresis ring and let the cooldown elapse (8 s),
  // then come back: the cabinet creaks again.
  for (let i = 0; i < 60 * 8; i++) cc.update(1 / 60, CAB.x + 12, CAB.z);
  cc.update(1 / 60, CAB.x - 1, CAB.z);
  check('leaving and returning creaks again', oscsSince(ctx, 0).length === first + 1,
    String(oscsSince(ctx, 0).length));
}

// ---- 4: pan mirrors which side the cabinet is on -------------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  // Approach from the right (+X side): facing -Z that is the listener's
  // right hand, so pan must be positive.
  cc.update(1 / 60, CAB.x + 1.2, CAB.z);
  const o = oscsSince(ctx, 0)[0];
  check('voice exists from the right too', !!o);
  check('cabinet on the right pans positive', o && downstream(o, 'panner').pan.value > 0,
    o ? String(downstream(o, 'panner').pan.value) : 'no voice');
}

// ---- 5: distance ducks the voice -----------------------------------------------
{
  const loud = new Ctx();
  const cLoud = freshCabinets(loud);
  cLoud.update(1 / 60, CAB.x - 0.3, CAB.z);
  const far = new Ctx();
  const cFar = freshCabinets(far);
  cFar.update(1 / 60, CAB.x - 1.9, CAB.z);
  const peakOf = (ctx) => {
    const g = downstream(oscsSince(ctx, 0)[0], 'gain');
    return Math.max(...g.gain.events.filter((e) => e[0] === 'lin').map((e) => e[1]));
  };
  const nearPeak = peakOf(loud);
  const farPeak = peakOf(far);
  check('closer cabinets creak louder', nearPeak > farPeak,
    'near=' + nearPeak + ' far=' + farPeak);
  check('even point-blank stays under a whisper', nearPeak <= 0.1, String(nearPeak));
}

// ---- 6/7/8: creak character -------------------------------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  // Approach from the left so pan must be negative.
  cc.update(1 / 60, CAB.x - 1.2, CAB.z);
  const o = oscsSince(ctx, 0)[0];
  check('voice exists', !!o);
  check('hinge whine is a sine', o.type === 'sine', o.type);

  const f = o.frequency.events;
  const setEv = f.find((e) => e[0] === 'set');
  const linEvs = f.filter((e) => e[0] === 'lin');
  check('starts around 400 Hz', Math.abs(setEv[1] - 400) <= 10, String(setEv[1]));
  check('sweeps up to around 600 Hz', linEvs.length === 1 && Math.abs(linEvs[0][1] - 600) <= 10,
    JSON.stringify(linEvs));
  check('sweep lasts ~300 ms', close(linEvs[0][2] - setEv[2], 0.3, 1e-9),
    String(linEvs[0][2] - setEv[2]));
  check('sweep rises upward', linEvs[0][1] > setEv[1]);

  const g = downstream(o, 'gain');
  check('graph reaches destination via panner',
    !!downstream(o, 'panner') && downstream(o, 'panner').edges.includes(ctx.destination));
  // Peak gain: the loudest linear ramp target.
  const peaks = g.gain.events.filter((e) => e[0] === 'lin').map((e) => e[1]);
  check('envelope ramps up once then releases',
    peaks.length === 2 && peaks[0] > 0 && peaks[0] <= 0.1 && peaks[1] <= 0.001,
    JSON.stringify(peaks));

  // Left-hand approach pans left, per the section 4 convention.
  check('approach from the left pans negative', downstream(o, 'panner').pan.value < 0,
    String(downstream(o, 'panner').pan.value));
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
