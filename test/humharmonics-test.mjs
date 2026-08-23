/*
 * Hum harmonic enrichment tests — pure Node, no browser.
 * Drives HumHarmonics against a minimal WebAudio mock and checks:
 *   1. the layer builds fundamental + odd harmonics at 60/180/300/420 Hz
 *      with -12/-18/-24 dB relative gains
 *   2. it starts silent and only speaks after setFixtureCount + update
 *   3. one fixture: lead voice only; two fixtures: twin voice fades in
 *      with its fundamental detuned 0.5-2 Hz (the beat window)
 *   4. age warble: a slow LFO feeds both fundamentals, depth scales with
 *      district age and never exceeds +/-0.5% of 60 Hz
 *   5. older districts grow hotter harmonics; unknown districts fall back
 *   6. update() drifts the beat but keeps it inside the window;
 *      setFixtureCount(0) mutes everything again; stop() silences
 */
import {
  HumHarmonics,
  HUM_FUNDAMENTAL,
  HUM_REF_LEVEL,
  ODD_HARMONICS,
  dbToGain,
} from '../src/audio/humharmonics.ts';

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.sets = [];    // {v}
    this.ramps = [];   // {v, kind}
    this.targets = []; // {v, tau}
    this.out = null;   // node/param connected TO us via connect()
  }
  setValueAtTime(v) { this.value = v; this.sets.push({ v }); }
  linearRampToValueAtTime(v) { this.ramps.push({ v, kind: 'lin' }); }
  exponentialRampToValueAtTime(v) { this.ramps.push({ v, kind: 'exp' }); }
  setTargetAtTime(v, _t, tau) { this.targets.push({ v, tau }); }
  cancelScheduledValues() {}
}
/** Most recent setTargetAtTime target, or the static value. */
const lastTarget = (p) => (p.targets.length ? p.targets[p.targets.length - 1].v : p.value);


class Node {
  constructor(ctx) {
    this.ctx = ctx; this.out = null;
    this.gain = new Param(1); this.frequency = new Param(440);
    this.pan = new Param(0); this.Q = new Param(1); this.type = '';
    this.buffer = null; this._startAt = -1; this._stopAt = -1;
  }
  connect(dest) { dest.out = this; this.out = dest; (this.connections ??= []).push(dest); return dest; }
  disconnect() { this.out = null; }
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

const oscsOf = (ctx) => ctx.nodes.filter((n) => n._kind === 'oscillator');
const freqsOf = (ctx) => oscsOf(ctx).map((o) => o.frequency.value);
function tick(ctx, hum, dt = 0.25) {
  now += dt;
  ctx.currentTime = now;
  hum.update(dt);
}

const ctx = new Ctx();
const hum = new HumHarmonics(ctx, ctx.destination);

// ---- 1. harmonic series construction -------------------------------------
check('builds exactly two voices x 4 partials + 1 warble LFO',
  oscsOf(ctx).length === 9, 'got ' + oscsOf(ctx).length);
check('every oscillator is a sine',
  oscsOf(ctx).every((o) => o.type === 'sine'));

const [aF, a3, a5, a7] = oscsOf(ctx).slice(0, 4);
check('lead partials at 60/180/300/420 Hz',
  [aF, a3, a5, a7].map((o) => o.frequency.value).join() === '60,180,300,420',
  JSON.stringify(freqsOf(ctx)));

// each oscillator feeds its own dedicated gain node:
const wOf = (osc) => osc.out.gain.value;
const w0 = wOf(aF), w1 = wOf(a3), w2 = wOf(a5), w3 = wOf(a7);
check('fundamental at reference weight 1.0', Math.abs(w0 - 1) < 1e-9, String(w0));
check('180 Hz sits near -12 dB relative (default-age boosted)',
  Math.abs(w1 - dbToGain(-12) * (1 + 0.4 * 0.5)) < 1e-6,
  String(w1));
check('180 Hz stays inside the aged range [-12 dB .. -12+40% dB]',
  w1 >= dbToGain(-12) - 1e-12 && w1 <= dbToGain(-12) * 1.4 + 1e-12,
  String(w1));
check('300 Hz sits near -18 dB relative (default-age boosted)',
  Math.abs(w2 - dbToGain(-18) * (1 + 0.4 * 0.5)) < 1e-6,
  String(w2));
check('300 Hz stays inside the aged range [-18 dB .. -18+40% dB]',
  w2 >= dbToGain(-18) - 1e-12 && w2 <= dbToGain(-18) * 1.4 + 1e-12,
  String(w2));
check('420 Hz sits near -24 dB relative (default-age boosted)',
  Math.abs(w3 - dbToGain(-24) * (1 + 0.4 * 0.5)) < 1e-6,
  String(w3));
check('420 Hz stays inside the aged range [-24 dB .. -24+40% dB]',
  w3 >= dbToGain(-24) - 1e-12 && w3 <= dbToGain(-24) * 1.4 + 1e-12,
  String(w3));
check('harmonics are genuinely subtle (< -11 dB)',
  ODD_HARMONICS.every((h) => h.db <= -12));

// ---- 2. silent until driven ----------------------------------------------
const rootA = aF.out.out; // partial gain -> voice root -> out
check('voice root starts muted', rootA.gain.value === 0, String(rootA?.gain?.value));
tick(ctx, hum);
check('still silent with zero fixtures', lastTarget(rootA.gain) === 0,
  String(lastTarget(rootA.gain)));
check('layer routes into destination',
  rootA.out !== null && rootA.out.out === ctx.destination,
  String(rootA?.out?.out?._kind));

// ---- 3. one fixture vs two fixtures --------------------------------------
hum.setDistrict(0); // pristine wiring: level trim 1.0 makes the formula exact
hum.setFixtureCount(1);
tick(ctx, hum);
const lvl1 = lastTarget(rootA.gain);
check('one fixture brings up the lead voice', lvl1 > 0, String(lvl1));
check('one-fixture level matches ref formula',
  Math.abs(lvl1 - HUM_REF_LEVEL * Math.sqrt(1) / 2) < 1e-9, String(lvl1));
const rootB = oscsOf(ctx)[4].out.out;
check('no beating voice with a single fixture', lastTarget(rootB.gain) === 0,
  String(lastTarget(rootB.gain)));
hum.setFixtureCount(3);
tick(ctx, hum);
check('more fixtures are louder (saturating curve)',
  lastTarget(rootA.gain) > lvl1 && lastTarget(rootA.gain) <= HUM_REF_LEVEL + 1e-12,
  String(lastTarget(rootA.gain)));

hum.setFixtureCount(2);
tick(ctx, hum);
const lvl2 = lastTarget(rootB.gain);
check('two fixtures fade in the beating twin voice', lvl2 > 0, String(lvl2));
const bF = oscsOf(ctx)[4].frequency.value;
const delta = Math.abs(bF - aF.frequency.value);
check('beat offset inside 0.5-2 Hz window', delta >= 0.5 && delta <= 2.0, String(delta));
check('twin harmonics track the same series',
  Math.abs(oscsOf(ctx)[6].frequency.value / bF - 5) < 1e-6);

// ---- 4. warble ------------------------------------------------------------
const lfo = oscsOf(ctx)[8];
check('warble LFO is very slow (< 0.2 Hz)', lfo.frequency.value > 0 && lfo.frequency.value < 0.2,
  String(lfo.frequency.value));
const depthNode = lfo.connections?.[0];
check('warble routes through its depth gain into BOTH fundamentals',
  !!depthNode && depthNode._kind === 'gain' &&
    (depthNode.connections ?? []).includes(aF.frequency) &&
    (depthNode.connections ?? []).includes(oscsOf(ctx)[4].frequency));
hum.setDistrict(0);
tick(ctx, hum);
const depthNew = lastTarget(lfo.out.gain);
check('new district warble small', depthNew >= 0 && depthNew <= HUM_FUNDAMENTAL * 0.005 + 1e-12,
  String(depthNew));
hum.setDistrict(3);
tick(ctx, hum);
const depthOld = lastTarget(lfo.out.gain);
check('old district warbles more', depthOld > depthNew + 1e-6, depthOld + ' vs ' + depthNew);
check('warble never exceeds +/-0.5% of fundamental',
  depthOld <= HUM_FUNDAMENTAL * 0.005 + 1e-9, String(depthOld));
check('unknown district falls back to a middle profile', (() => {
  hum.setDistrict(99);
  tick(ctx, hum);
  const d = lastTarget(lfo.out.gain);
  return d > 0 && d < HUM_FUNDAMENTAL * 0.005;
})());

// ---- 5. aged fixtures grow hotter harmonics -------------------------------
(() => {
  hum.setDistrict(0);
  tick(ctx, hum);
  const hotNew = Math.max(lastTarget(a3.out.gain), a3.out.gain.value);
  hum.setDistrict(3);
  tick(ctx, hum);
  const hotOld = lastTarget(a3.out.gain);
  check('aged district boosts harmonic dirt', hotOld > hotNew + 1e-6, hotOld + ' vs ' + hotNew);
})();

// ---- 6. drift, mute, stop --------------------------------------------------
(() => {
  hum.setFixtureCount(2);
  hum.setDistrict(1);
  let ok = true;
  for (let s = 0; s < 120; s += 0.25) { // 2 minutes: several drift cycles
    tick(ctx, hum, 0.25);
    const d = Math.abs(oscsOf(ctx)[4].frequency.value - oscsOf(ctx)[0].frequency.value);
    if (!(d >= 0.5 - 1e-9 && d <= 2.0 + 1e-9)) { ok = false; break; }
  }
  check('drifted beat stays inside 0.5-2 Hz across minutes', ok);
})();

(() => {
  hum.setFixtureCount(0);
  tick(ctx, hum);
  check('zero fixtures mutes both voices',
    lastTarget(rootA.gain) === 0 && lastTarget(rootB.gain) === 0);
  const d = lastTarget(lfo.out.gain);
  check('warble collapses when nothing is lit', d === 0, String(d));
  hum.stop();
  tick(ctx, hum);
  check('update() after stop() is inert', lastTarget(rootA.gain) === 0);
})();

console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;


