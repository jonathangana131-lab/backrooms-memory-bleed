/*
 * Wave B audio subsystem tests -- pure Node, no browser.
 * Drives all six layers against a minimal WebAudio mock (crowd-test idiom):
 *
 *   ElevatorAmbience  distant car calls build lazily and schedule chime
 *                     notes + cable noise through a wall lowpass
 *   FanSpeedAudio     motor hum tracks state changes, belt squeak on live
 *                     transitions, wobble knocks while spinning, OFF tears down
 *   VentAudio         deterministic vent field opens the air bed near a live
 *                     vent and schedules pressure swells
 *   ElectricPops      snaps / flicker clusters schedule on cadence
 *   EchoSites         revisits escalate; tier 3 builds the SiteMurmur formant
 *                     voice bound to one site (crowd.ts technique)
 *   CabinetCreaks     entering a cabinet radius fires one hinge whine;
 *                     hysteresis + cooldown pace repeats
 *
 * Also proves the determinism law: Math.random appears ONLY in DSP buffer
 * fills.
 *
 * Run: node test/waveb-audio-test.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// src modules import siblings extensionlessly; teach the native TS loader
// the same fallback the other wave tests use, then import dynamically
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
const { ElevatorAmbience } = await import('../src/audio/elevator.ts');
const { FanSpeedAudio } = await import('../src/audio/fanspeeds.ts');
const { VentAudio } = await import('../src/audio/vents.ts');
const { ElectricPops } = await import('../src/audio/electricpop.ts');
const { EchoSites } = await import('../src/audio/echoes.ts');
const { CabinetCreaks } = await import('../src/audio/cabinetcreak.ts');
const { rand2 } = await import('../src/core/rng.ts');

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (!cond) failures.push(name);
}

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.targets = []; // {v, t} from setTargetAtTime
    this.inputs = [];  // connected source nodes
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
    this.buffer = null; this.loop = false; this.playbackRate = new Param(1);
    this._starts = []; this._stops = []; this._disconnected = false;
  }
  connect(dest) {
    if (dest && typeof dest === 'object' && 'targets' in dest && 'inputs' in dest) {
      dest.inputs.push(this);
    } else {
      this.out = dest;
    }
    return dest;
  }
  disconnect() { this.out = null; this._disconnected = true; }
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

const STEP = 0.25;
/** Advance the mock clock, ticking 'fn' every step against 'ctx'. */
function simulate(ctx, seconds, fn) {
  for (let t = 0; t < seconds; t += STEP) {
    now += STEP;
    ctx.currentTime = now;
    fn();
  }
}

// ---- 0. determinism law ---------------------------------------------------
{
  const here = join(dirname(fileURLToPath(import.meta.url)), '../src/audio');
  for (const f of ['elevator.ts', 'fanspeeds.ts', 'vents.ts', 'electricpop.ts', 'echoes.ts', 'cabinetcreak.ts']) {
    const src = readFileSync(join(here, f), 'utf8');
    // strip block + line comments, then every surviving Math.random must be
    // a DSP buffer-fill assignment of the form data[i] = Math.random()*...
    const code = src.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '');
    const bad = code.split('\n').filter((l) => l.includes('Math.random') && !/data\[\w+\]\s*=\s*Math\.random/.test(l));
    check(f + ': Math.random only in DSP buffer fills', bad.length === 0, bad.join(' | ').slice(0, 120));
  }
}

// ---- 1. ElevatorAmbience ---------------------------------------------------
{
  const ctx = new Ctx();
  const el = new ElevatorAmbience(ctx, ctx.destination);
  el.update(0.05, 1); // lazy-build tick
  simulate(ctx, 8.4, () => el.update(STEP, 1)); // burn the initial 8 s countdown
  const lowpass = ctx.nodes.find((n) => n._kind === 'filter' && n.type === 'lowpass');
  check('elevator: wall lowpass built lazily at 500 Hz',
    !!lowpass && lowpass.frequency.value === 500,
    lowpass ? String(lowpass.frequency.value) : 'missing');
  const oscs = ctx.nodes.filter((n) => n._kind === 'oscillator');
  check('elevator: chime pair scheduled', oscs.length >= 2 && oscs.every((o) => o._starts.length === 1),
    oscs.length + ' oscs');
  const cables = ctx.nodes.filter((n) => n._kind === 'buffer-source' && n._starts.length > 0);
  check('elevator: cable-noise voice scheduled', cables.length >= 1, String(cables.length));

  const quietCtx = new Ctx();
  const quiet = new ElevatorAmbience(quietCtx, quietCtx.destination);
  let threw = false;
  try { quiet.update(30, 3); } catch { threw = true; } // far district: heavily throttled
  check('elevator: far-district update survives', !threw);

  el.stop();
  check('elevator: stop disconnects wall filter', !!lowpass && lowpass._disconnected);
  el.stop(); // double-stop safe
}

// ---- 2. FanSpeedAudio ------------------------------------------------------
{
  const ctx = new Ctx();
  const fan = new FanSpeedAudio(ctx, ctx.destination);
  fan.setState('MEDIUM'); // engages from OFF -> lazy motor build
  const hum = ctx.nodes.find((n) => n._kind === 'oscillator');
  check('fan: motor triangle hum built on first running state',
    !!hum && hum.type === 'triangle' && hum.frequency.value === 58,
    hum ? hum.type + '@' + hum.frequency.value : 'missing');
  check('fan: hum started', !!hum && hum._starts.length === 1);

  simulate(ctx, 2, () => fan.update(STEP));
  fan.setState('FAST'); // live transition -> belt squeak gliss
  const squeak = ctx.nodes.filter((n) => n._kind === 'oscillator' &&
    n.frequency.value >= 1400 && n.frequency.value <= 1900);
  check('fan: belt squeak gliss on live transition', squeak.length === 1, String(squeak.length));

  simulate(ctx, 1, () => fan.update(STEP)); // wobble cadence fires knocks
  const knocks = ctx.nodes.filter((n) => n._kind === 'oscillator' &&
    n.frequency.value <= 95 && n.frequency.value >= 45);
  check('fan: bent-rod knock scheduled while spinning', knocks.length >= 1, String(knocks.length));

  const oscCountBefore = ctx.nodes.filter((n) => n._kind === 'oscillator').length;
  fan.setState('OFF');
  check('fan: OFF stops the motor oscillator', !!hum && hum._stops.length === 1,
    JSON.stringify(hum ? hum._stops : []));
  fan.stop();
  fan.setState('SLOW'); // stopped instance refuses further states
  check('fan: stopped instance ignores setState',
    ctx.nodes.filter((n) => n._kind === 'oscillator').length === oscCountBefore);
}

// ---- 3. VentAudio ----------------------------------------------------------
{
  // find an active vent cell on the deterministic field
  let cx = 0, cz = 0;
  outer:
  for (let gz = -50; gz <= 50; gz++) {
    for (let gx = -50; gx <= 50; gx++) {
      if (rand2(gx, gz, 0x7e17) < 0.4) { cx = gx; cz = gz; break outer; }
    }
  }
  const px = cx * 18 + 9;
  const pz = cz * 18 + 9;

  const ctx = new Ctx();
  const vents = new VentAudio(ctx, ctx.destination);
  vents.update(STEP, 1, px, pz); // lazy build + proximity feed
  const bed = ctx.nodes.find((n) => n._kind === 'buffer-source' && n.loop);
  check('vent: looping air bed built on first audible update', !!bed && bed._starts.length === 1);
  const bedFilter = ctx.nodes.find((n) => n._kind === 'filter' && n.type === 'bandpass' && n.Q.value === 1.1);
  check('vent: bed resonates near 70 Hz', !!bedFilter && bedFilter.frequency.value === 70,
    bedFilter ? String(bedFilter.frequency.value) : 'missing');

  simulate(ctx, 6.5, () => vents.update(STEP, 1, px, pz)); // 6 s swell timer expires
  const groans = ctx.nodes.filter((n) => n._kind === 'buffer-source' && n !== bed && n._starts.length > 0);
  check('vent: pressure swell scheduled in earshot', groans.length >= 1, String(groans.length));

  simulate(ctx, 8, () => vents.update(STEP, 1, px + 400, pz + 400)); // walk away, let the bed ease shut
  const bedGain = ctx.nodes.find((n) => n._kind === 'gain' && n.gain.targets.length > 0);
  const lastTarget = bedGain ? bedGain.gain.targets.at(-1).v : -1;
  check('vent: bed target eases toward zero away from live vents',
    lastTarget >= 0 && lastTarget < 0.001, String(lastTarget));
  vents.stop();
  check('vent: stop kills the bed source', !!bed && bed._stops.length === 1);
}

// ---- 4. ElectricPops -------------------------------------------------------
{
  const ctx = new Ctx();
  const pops = new ElectricPops(ctx, ctx.destination);
  pops.update(STEP, 0); // lazy build
  simulate(ctx, 3.5, () => pops.update(STEP, 0)); // initial 3 s countdown expires
  let clicks = ctx.nodes.filter((n) => n._kind === 'buffer-source' && n._starts.length > 0);
  check('pops: first electrical event scheduled', clicks.length >= 1, String(clicks.length));
  const bp = ctx.nodes.filter((n) => n._kind === 'filter' && n.type === 'bandpass');
  check('pops: voices band in arcing-metal range',
    bp.length >= 1 && bp.every((f) => f.frequency.value >= 800 && f.frequency.value <= 6000));

  simulate(ctx, 15, () => pops.update(STEP, 0)); // well past EVENT_MAX_S
  const total = ctx.nodes.filter((n) => n._kind === 'buffer-source' && n._starts.length > 0);
  check('pops: cadence keeps firing events', total.length > clicks.length,
    total.length + ' vs ' + clicks.length);
  clicks = total;

  pops.stop();
  const tStop = now;
  simulate(ctx, 20, () => pops.update(STEP, 0)); // stopped instance stays silent
  check('pops: stopped instance never schedules again',
    ctx.nodes.filter((n) => n._kind === 'buffer-source').every((n) =>
      n._starts.length === 0 || n._starts[0] <= tStop),
    'scheduled after stop');
}

// ---- 5. EchoSites tier-3 SiteMurmur ---------------------------------------
{
  const ctx = new Ctx();
  const echoes = new EchoSites(ctx, ctx.destination);
  echoes.markSite(0, 0);
  check('echoes: site registered with null murmur',
    echoes.sites.length === 1 && echoes.sites[0].murmur === null);

  const inside = () => simulate(ctx, STEP, () => echoes.update(STEP, 3, 2, 0));
  const leave = () => simulate(ctx, STEP, () => echoes.update(STEP, 3, 60, 60));
  // three visits with full exits between them so each re-entry escalates
  inside(); inside(); inside(); inside();
  leave(); leave();
  inside(); inside(); inside(); inside();
  leave(); leave();
  inside(); inside(); inside(); inside();
  check('echoes: third revisit reaches escalation tier 3', echoes.sites[0].visits >= 3,
    String(echoes.sites[0].visits));
  check('echoes: murmurActive reported at tier 3', echoes.murmurActive);

  const glottal = ctx.nodes.find((n) => n._kind === 'oscillator' && n.type === 'sawtooth' &&
    n.frequency.value >= 60 && n.frequency.value <= 110);
  check('echoes: SiteMurmur glottal sawtooth built lazily',
    !!glottal, glottal ? String(glottal.frequency.value) : 'missing');
  const formants = ctx.nodes.filter((n) => n._kind === 'filter' && n.type === 'bandpass' &&
    n.frequency.value >= 250 && n.frequency.value <= 2200 && n.Q.value >= 6);
  check('echoes: two parallel vowel formants (crowd.ts technique)', formants.length >= 2,
    String(formants.length));
  check('echoes: murmur panned by site bearing', ctx.nodes.some((n) => n._kind === 'panner'));

  simulate(ctx, 1, () => echoes.update(STEP, 3, 2, 0)); // syllable look-ahead runs
  const gatedGains = ctx.nodes.filter((n) => n._kind === 'gain' && n.gain.targets.some((t) => t.v > 0));
  check('echoes: syllable envelopes scheduled while audible', gatedGains.length >= 1,
    String(gatedGains.length));

  const intensity = echoes.getIntensity(2, 0);
  check('echoes: getIntensity blends proximity x escalation', intensity > 0.5 && intensity <= 1,
    String(intensity));

  echoes.stop();
  check('echoes: stop releases every site murmur',
    echoes.sites.every((s) => s.murmur === null) && glottal && glottal._stops.length === 1);
  echoes.stop(); // double-stop safe
}

// ---- 6. CabinetCreaks ------------------------------------------------------
{
  const ctx = new Ctx();
  const cabs = new CabinetCreaks(ctx, ctx.destination);
  cabs.setCabinets([{ x: 0, z: 0 }, { x: 40, z: 40 }]);
  cabs.update(STEP, 30, 30); // nothing in range yet
  check('cabinet: no voice outside trigger radius',
    ctx.nodes.filter((n) => n._kind === 'oscillator').length === 0);

  cabs.update(STEP, 0.5, 0.5); // step inside cabinet #1
  const whine = ctx.nodes.find((n) => n._kind === 'oscillator');
  // mock Param collapses the sweep to its final value: 400 Hz start -> 600 Hz top
  check('cabinet: hinge whine sweeps and starts once inside 2 m',
    !!whine && whine.frequency.value === 600 && whine._starts.length === 1,
    whine ? String(whine.frequency.value) : 'missing');
  const panner = ctx.nodes.find((n) => n._kind === 'panner');
  check('cabinet: pan mirrors approach side', !!panner && panner.pan.value > 0);

  cabs.update(STEP, 0.4, 0.4); // loitering inside: cooldown holds
  check('cabinet: cooldown blocks immediate retriggers',
    ctx.nodes.filter((n) => n._kind === 'oscillator').length === 1);
  cabs.update(6, 0.4, 0.4); // still inside past the cooldown: hysteresis keeps it disarmed
  check('cabinet: staying inside never refires',
    ctx.nodes.filter((n) => n._kind === 'oscillator').length === 1);
  cabs.update(STEP, 10, 10); // leave past the release ring
  cabs.update(STEP, 0.5, 0.5); // re-enter after the cooldown elapsed
  check('cabinet: exit + re-entry fires a second creak',
    ctx.nodes.filter((n) => n._kind === 'oscillator').length === 2);
  cabs.stop();
  cabs.update(STEP, 0.5, 0.5);
  check('cabinet: stopped instance refuses updates',
    ctx.nodes.filter((n) => n._kind === 'oscillator').length === 2);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log('FAIL (' + failures.length + '): ' + failures.join(' | '));
  process.exit(1);
}
console.log('ALL PASS: six Wave-B audio layers build, schedule, and stop headless');
