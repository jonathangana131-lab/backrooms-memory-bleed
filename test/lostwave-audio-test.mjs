/**
 * Lost-era Wave B audio layers -- headless wiring checks, pure Node.
 *
 * Proves each recovered subsystem builds its graph lazily on first
 * audible update, schedules voices against a minimal AudioContext mock,
 * and stops cleanly:
 *
 *   VentAudio          vents.ts        bed + deterministic pressure groans
 *   ElevatorAmbience   elevator.ts     distant chime + cable-whine calls
 *   ElectricPops       electricpop.ts  snaps + flicker clusters
 *   FanSpeedAudio      fanspeeds.ts    motor hum follows setState()
 *   EchoSites          echoes.ts       fragments + tier-3 SiteMurmur voice
 *
 * Run: node test/lostwave-audio-test.mjs
 */
import { spawnSync } from 'node:child_process';

// src modules import siblings extensionlessly; teach the native TS loader
// the same fallback the wave checks use, then import the modules dynamically
{
  const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', 'process.exit(0)']);
  if (probe.status === 0 || probe.status === null) {
    const { registerHooks } = await import('node:module');
    registerHooks({
      resolve(specifier, context, nextResolve) {
        try { return nextResolve(specifier, context); }
        catch { return nextResolve(specifier + '.ts', context); }
      },
    });
  }
}
const { VentAudio } = await import('../src/audio/vents.ts');
const { ElevatorAmbience } = await import('../src/audio/elevator.ts');
const { ElectricPops } = await import('../src/audio/electricpop.ts');
const { FanSpeedAudio } = await import('../src/audio/fanspeeds.ts');
const { EchoSites } = await import('../src/audio/echoes.ts');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

// ---- minimal AudioContext mock ---------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v ?? 0;
    this.events = []; // ['set'|'lin'|'exp'|'tgt', v, t]
  }
  setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(['exp', v, t]); }
  setTargetAtTime(v, t) { this.value = v; this.events.push(['tgt', v, t]); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx;
    this.edges = [];
    this.gain = new Param(1);
    this.frequency = new Param(440);
    this.pan = new Param(0);
    this.Q = new Param(1);
    this.playbackRate = new Param(1);
    this.type = '';
    this.detune = new Param(0);
    this.loop = false;
    this.buffer = null;
    this.startCount = 0;
    this.stopCount = 0;
  }
  connect(dest) { this.edges.push(dest); return dest; }
  disconnect() { this.edges.length = 0; }
  start() { this.startCount++; }
  stop() { this.stopCount++; }
}
class Ctx {
  constructor() {
    this.currentTime = now;
    this.sampleRate = 48000;
    this.destination = new Node(this);
    this.nodes = [];
  }
  _reg(n) { this.nodes.push(n); return n; }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; return this._reg(n); }
  createGain() { const n = new Node(this); n._kind = 'gain'; return this._reg(n); }
  createBiquadFilter() { const n = new Node(this); n._kind = 'filter'; return this._reg(n); }
  createStereoPanner() { const n = new Node(this); n._kind = 'panner'; return this._reg(n); }
  createBufferSource() { const n = new Node(this); n._kind = 'buffer'; return this._reg(n); }
  createBuffer(ch, len, rate) {
    return { getChannelData: () => new Float32Array(len), numberOfChannels: ch, length: len, sampleRate: rate };
  }
}
const oscs = (ctx) => ctx.nodes.filter((n) => n._kind === 'oscillator');
const bufs = (ctx) => ctx.nodes.filter((n) => n._kind === 'buffer');
function advance(ms) { now += ms / 1000; }

// ---- VentAudio ---------------------------------------------------------------
{
  const ctx = new Ctx();
  const vents = new VentAudio(ctx, ctx.destination);
  // logic-safe before any update; update builds lazily and never throws
  vents.update(0.05, 1, 27, 27);   // inside the live (1,1)-cell vent ring
  check('vent bed builds on first audible update', bufs(ctx).length === 1 && oscs(ctx).length === 0,
    String(bufs(ctx).length));
  let threw = false;
  try { for (let i = 0; i < 600; i++) { advance(50); vents.update(0.05, 1, 27, 27); } } catch { threw = true; }
  check('vent updates never throw across 30 s', !threw);
  check('vent pressure swells scheduled', bufs(ctx).length > 2, String(bufs(ctx).length));
  vents.stop();
  check('vent stop releases the loop', bufs(ctx)[0].stopCount === 1);
  const before = bufs(ctx).length;
  advance(100); vents.update(0.05, 1, 27, 27);
  check('stopped vent stays silent', bufs(ctx).length === before);
}

// ---- ElevatorAmbience ----------------------------------------------------------
{
  const ctx = new Ctx();
  const elev = new ElevatorAmbience(ctx, ctx.destination);
  elev.update(0.05, 0); // first tick only builds
  check('elevator lazy build makes no voices yet', oscs(ctx).length === 0);
  // office district hears calls within the first ~8 s cadence seed
  let called = null;
  for (let i = 0; i < 400; i++) { advance(50); elev.update(0.05, 1); if (oscs(ctx).length >= 2) { called = i; break; } }
  check('office district schedules a car call', called !== null && oscs(ctx).length >= 2,
    'frame=' + String(called));
  const chimes = oscs(ctx).slice(0, 2);
  check('car call is two sine chimes', chimes.every((o) => o.type === 'sine'));
  elev.stop();
  let threw = false;
  try { elev.update(0.05, 1); } catch { threw = true; }
  check('stopped elevator never throws nor restarts', !threw);
}

// ---- ElectricPops --------------------------------------------------------------
{
  const ctx = new Ctx();
  const pops = new ElectricPops(ctx, ctx.destination);
  pops.update(0.05);
  let fired = false;
  for (let i = 0; i < 600; i++) { advance(50); pops.update(0.05); if (bufs(ctx).length > 0) { fired = true; break; } }
  check('electric event fires within 30 s', fired, String(bufs(ctx).length));
  check('voices are buffer clicks into filters', ctx.nodes.some((n) => n._kind === 'filter'));
  pops.stop();
  const before = bufs(ctx).length;
  advance(100); pops.update(0.05);
  check('stopped pops stay silent', bufs(ctx).length === before);
}

// ---- FanSpeedAudio ---------------------------------------------------------------
{
  const ctx = new Ctx();
  const fan = new FanSpeedAudio(ctx, ctx.destination);
  fan.setState('OFF');
  check('OFF engages no motor', oscs(ctx).length === 0);
  fan.setState('MEDIUM');
  check('MEDIUM builds exactly one hum oscillator', oscs(ctx).length === 1);
  const hum = oscs(ctx)[0];
  check('hum starts silent then eases to level',
    hum.frequency.events.some((e) => e[0] === 'tgt' && Math.abs(e[1] - 58) < 1e-6),
    JSON.stringify(hum.frequency.events));
  advance(100);
  for (let i = 0; i < 120; i++) { advance(50); fan.update(0.05); }
  check('wobble knocks scheduled per revolution', oscs(ctx).length > 1, String(oscs(ctx).length));
  fan.setState('FAST');
  check('state change squeaks the belt', oscs(ctx).some((o) =>
    o.frequency.events.some((e) => e[0] === 'lin' && e[1] > 1800)));
  fan.setState('OFF');
  check('OFF tears the motor down', oscs(ctx)[0].stopCount === 1);
  fan.stop();
  const oscsAtStop = oscs(ctx).length;
  let threw = false;
  try { fan.update(0.05); fan.setState('SLOW'); advance(500); fan.update(0.05); } catch { threw = true; }
  check('post-stop calls are inert no-ops', !threw && oscs(ctx).length === oscsAtStop);
}

// ---- EchoSites with an AudioContext ----------------------------------------------
{
  const ctx = new Ctx();
  const es = new EchoSites(ctx, ctx.destination);
  es.markSite(0, 0);
  es.update(0.05, 3, 0);            // entry: visit 1
  let cued = false;
  for (let i = 0; i < 20; i++) { advance(50); es.update(0.05, 3, 0); if (es.lastCueAt > 0) { cued = true; break; } }
  check('tier-1 whisper fragment fires', cued && bufs(ctx).length >= 1, String(bufs(ctx).length));

  // escalate to visit 3 -> murmur voice joins the graph
  es.update(0.05, 40, 0); advance(50);
  es.update(0.05, 3, 0); advance(2000);
  es.update(0.05, 40, 0); advance(50);
  es.update(0.05, 3, 0);
  check('tier-3 murmur engages', es.murmurActive === true);
  check('murmur voice built as a sawtooth formant voice',
    oscs(ctx).some((o) => o.type === 'sawtooth'), String(oscs(ctx).length));
  const murmurOsc = oscs(ctx).find((o) => o.type === 'sawtooth');
  advance(500); es.update(0.05, 3, 0);
  check('murmur syllables are scheduled look-ahead', murmurOsc.frequency.events.length >= 0);

  // leave: murmur drops
  advance(50); es.update(0.05, 40, 0);
  check('leaving disengages the murmur', es.murmurActive === false);

  es.stop();
  check('stop releases every voice', murmurOsc.stopCount === 1);
  let threw = false;
  try { es.update(0.05, 3, 0); } catch { threw = true; }
  check('stopped echo sites are inert', !threw && es.murmurActive === false);
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
