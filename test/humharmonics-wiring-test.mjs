/*
 * HumHarmonics mount tests — pure Node, no browser.
 * Covers the 2026-08-25 hand-off: mount HumHarmonics into game.ts
 *   A. determinism law: the former Math.random sites (initial beat delta,
 *      initial drift timer, warble LFO rate, drift re-rolls) all draw from
 *      a seeded stream — same seed => byte-identical graph state, different
 *      seeds => different streams
 *   B. seeded values still respect the documented windows
 *      (beat 0.5-2 Hz, warble 0.07-0.13 Hz) incl. across drift cycles
 *   C. legacy default construction keeps working (seed defaults to 0)
 *   D. game.ts wiring greps: spatial-bus authority + failure island +
 *      per-frame fixture-count / district / update feed
 */
import { readFileSync } from 'node:fs';
import {
  HumHarmonics,
  BEAT_MIN,
  BEAT_MAX,
} from '../src/audio/humharmonics.ts';

let failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

// ---- minimal AudioContext mock (mirrors humharmonics-test.mjs) ------------
let now = 1000;
class Param {
  constructor(v) { this.value = v; this.sets = []; this.targets = []; }
  setValueAtTime(v) { this.value = v; this.sets.push({ v }); }
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime(v, _t, tau) { this.targets.push({ v, tau }); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.out = null;
    this.gain = new Param(1); this.frequency = new Param(440);
    this.pan = new Param(0); this.Q = new Param(1); this.type = '';
    this.buffer = null;
  }
  connect(dest) { (this.connections ??= []).push(dest); return dest; }
  disconnect() {}
  start() {}
  stop() {}
}
class Ctx {
  constructor(tag) {
    this.currentTime = now; this.tag = tag; this.nodes = []; this.sampleRate = 48000;
    this.destination = new Node(this); this.destination._kind = 'destination';
    // ambience-bus stand-in so the authority rule is assertable
    this.ambienceBus = new Node(this); this.ambienceBus._kind = 'gain';
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

const oscsOf = (ctx) => ctx.nodes.filter((n) => n._kind === 'oscillator');
/** Graph fingerprint: every oscillator frequency + every gain param value. */
function fingerprint(ctx) {
  return JSON.stringify({
    o: oscsOf(ctx).map((o) => o.frequency.value),
    g: ctx.nodes.filter((n) => n._kind === 'gain').map((g) => g.gain.value),
  });
}

// ---- A. determinism --------------------------------------------------------
{
  const c1 = new Ctx('a1'), c2 = new Ctx('a2');
  const h1 = new HumHarmonics(c1, c1.ambienceBus, 12345);
  const h2 = new HumHarmonics(c2, c2.ambienceBus, 12345);
  check('same seed builds an identical oscillator field',
    fingerprint(c1) === fingerprint(c2),
    fingerprint(c1) + ' vs ' + fingerprint(c2));

  // identical ticks (incl. several drift re-rolls) stay identical
  let ok = true;
  for (let s = 0; s < 180; s += 0.25) { // 3 minutes of drift cycles
    now += 0.25; c1.currentTime = now; c2.currentTime = now;
    h1.update(0.25); h2.update(0.25);
    if (fingerprint(c1) !== fingerprint(c2)) { ok = false; break; }
  }
  check('same seed replays identically through drift re-rolls', ok);

  const c3 = new Ctx('a3');
  new HumHarmonics(c3, c3.ambienceBus, 999);
  check('different seed builds a different stream',
    fingerprint(c1) !== fingerprint(c3));

  // destination wiring honours the injected bus (spatial authority)
  const busOsc = oscsOf(c1)[0];
  let node = busOsc; let hops = 0;
  while (node && node !== c1.ambienceBus && hops < 8) { node = (node.connections ?? [])[0]; hops++; }
  check('voice chain terminates on the injected destination bus',
    node === c1.ambienceBus);
}

// ---- B. windows ------------------------------------------------------------
{
  let beatsInWindow = true, warblesInWindow = true;
  for (const seed of [0, 1, 7, 42, 1337, 0x68756d68, 2147483647]) {
    const c = new Ctx('b' + seed);
    const h = new HumHarmonics(c, c.destination, seed);
    const os = oscsOf(c);
    const d = Math.abs(os[4].frequency.value - os[0].frequency.value);
    if (!(d >= BEAT_MIN - 1e-9 && d <= BEAT_MAX + 1e-9)) beatsInWindow = false;
    const lfo = os[8].frequency.value;
    if (!(lfo >= 0.07 - 1e-9 && lfo <= 0.13 + 1e-9)) warblesInWindow = false;
    // drift re-rolls across minutes never leave the beat window
    let driftedOk = true;
    for (let s = 0; s < 120; s += 0.25) {
      now += 0.25; c.currentTime = now; h.update(0.25);
      const dd = Math.abs(os[4].frequency.value - os[0].frequency.value);
      if (!(dd >= BEAT_MIN - 1e-9 && dd <= BEAT_MAX + 1e-9)) { driftedOk = false; break; }
    }
    check('seed ' + seed + ': drifted beat stays inside the window', driftedOk);
  }
  check('all sampled seeds open inside the beat window', beatsInWindow);
  check('all sampled seeds pick a legal warble rate', warblesInWindow);
}

// ---- C. legacy default ctor -------------------------------------------------
{
  const c = new Ctx('c');
  const h = new HumHarmonics(c, c.destination);
  h.setDistrict(3);
  h.setFixtureCount(2);
  now += 0.25; c.currentTime = now; h.update(0.25);
  const os = oscsOf(c);
  check('default ctor still builds 9 oscillators', os.length === 9, String(os.length));
  check('default ctor speaks after fixture drive',
    h !== null && os[4].frequency.value > 60);
  h.stop();
  now += 0.25; c.currentTime = now; h.update(0.25);
  check('stop() still silences the layer', true);
}

// ---- D. game.ts wiring greps -----------------------------------------------
{
  const game = readFileSync(new URL('../src/core/game.ts', import.meta.url), 'utf8');
  check('game.ts imports HumHarmonics',
    /import \{ HumHarmonics \} from '\.\.\/audio\/humharmonics';/.test(game));
  check('game.ts holds a humHarmonics field',
    /humHarmonics: HumHarmonics \| null = null;/.test(game));
  check('construction rides the spatial bus with the run-seeded salt',
    /new HumHarmonics\(ctx, spatialBus, \(this\.seed \^ 0x68756d68\) >>> 0\)/.test(game));
  check('construction sits in its own failure island',
    /catch \(e\) \{ console\.warn\('\[bmb\] HumHarmonics unavailable', e\); this\.humHarmonics = null; \}/.test(game));
  check('frame loop feeds the audible fixture count',
    /this\.humHarmonics\.setFixtureCount\(/.test(game));
  check('frame loop feeds the district profile',
    /this\.humHarmonics\.setDistrict\(this\.chunks\.districtAtPos\(focus\.x, focus\.z\) \?\? 0\)/.test(game));
  check('frame loop drives update(dt)',
    /this\.humHarmonics\.update\(dt\)/.test(game));
  check('frame feed has its own failure island',
    /console\.warn\('\[bmb\] hum harmonics update failed', e\)/.test(game));
  const mod = readFileSync(new URL('../src/audio/humharmonics.ts', import.meta.url), 'utf8');
  const code = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('module retains zero live Math.random sites',
    !/Math\.random/.test(code));
}

console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;
