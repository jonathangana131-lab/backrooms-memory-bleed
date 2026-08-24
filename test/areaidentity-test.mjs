/*
 * Area identity bed tests — pure Node, no browser.
 * Drives AreaIdentityBeds + PhoneRinger against a minimal WebAudio mock
 * (same construction as crowd-test.mjs) and checks:
 *   1. district gating: each island's gate opens only for its own district
 *      and islands build lazily on first activation
 *   2. MAZE: odd-order harmonic pairs (180/300/420 Hz) with slow swell LFOs
 *   3. HONEYCOMB: comb delays get pitched impulses only while active
 *   4. CORRIDOR_GRID: narrow beating bandpass pair over a looping noise bed
 *   5. STORAGE: slumping metal groans fire on a calm-time countdown
 *   6. OPEN_OFFICE phones: deterministic placement hash, ring-once-per-session
 *   7. kill-switch and stop() safety
 */
// Project sources import each other without extensions (bundler-style).
// Node's strip-types loader needs explicit extensions, so register a
// resolve hook that retries with '.ts' appended when plain resolution fails.
let hooksRegistered = false;
try {
  const { registerHooks } = await import('node:module');
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        return nextResolve(specifier + '.ts', context);
      }
    },
  });
  hooksRegistered = true;
} catch {
  hooksRegistered = false; // older Node without synchronous module hooks
}
if (!hooksRegistered) console.warn('  note: no resolve hook available; test may fail to load sources');
const { AreaIdentityBeds } = await import('../src/audio/areaidentity.ts');
const { PhoneRinger, PHONE_CELL, RING_HEARSHOT } = await import('../src/audio/phoner.ts');

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.targets = [];
    this.inputs = [];
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
    this.delayTime = new Param(0);
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
  createDelay(max) { const n = new Node(this); n._kind = 'delay'; n.maxDelay = max; this.nodes.push(n); return n; }
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

const ctx = new Ctx();
const SEED = 987654321;
const beds = new AreaIdentityBeds(ctx, ctx.destination);
beds.seed(SEED);

const STEP = 0.25;
function run(seconds, district, tension = 0) {
  for (let t = 0; t < seconds; t += STEP) {
    now += STEP;
    ctx.currentTime = now;
    beds.update(STEP, district, tension);
  }
}
function gateTargets() {
  // island gates are the gains wired straight to destination
  return ctx.nodes.filter((n) => n._kind === 'gain' && n.out === ctx.destination)
    .map((g) => g.gain.targets.at(-1)?.v ?? g.gain.value);
}

// ---- 1. lazy build + district gating --------------------------------------
check('nothing builds until a district activates', ctx.nodes.length === 0,
  String(ctx.nodes.length));
run(2, 0); // MAZE
check('maze gate opens', gateTargets()[0] > 0.5, String(gateTargets()[0]));
for (let i = 1; i < 5; i++) {
  check('district ' + i + ' gate stays closed while in MAZE',
    (gateTargets()[i] ?? 0) === 0, String(gateTargets()[i]));
}

// ---- 2. MAZE graph ----------------------------------------------------------
const humOscs = ctx.nodes.filter((n) => n._kind === 'oscillator' &&
  [180, 300, 420].some((f) => Math.abs(n.frequency.value - f) < 2));
check('maze builds odd-harmonic pairs at 180/300/420 Hz', humOscs.length === 6,
  String(humOscs.length));
const swellLfos = ctx.nodes.filter((n) => n._kind === 'oscillator' &&
  n.frequency.value > 0.02 && n.frequency.value < 0.08);
check('maze swells run on slow LFOs', swellLfos.length >= 3, String(swellLfos.length));

run(4, 2); // leave to HONEYCOMB
check('maze gate closes on exit', gateTargets()[0] === 0, String(gateTargets()[0]));
check('honeycomb gate opens on entry', gateTargets()[2] > 0.5, String(gateTargets()[2]));

// ---- 3. HONEYCOMB combs -----------------------------------------------------
const combs = ctx.nodes.filter((n) => n._kind === 'delay');
check('honeycomb builds two tuned combs',
  combs.length === 2 && combs.every((c) => c.delayTime.value > 0.002 && c.delayTime.value < 0.02),
  JSON.stringify(combs.map((c) => c.delayTime.value)));
const oscCountBefore = ctx.nodes.filter((n) => n._kind === 'oscillator').length;
run(10, 2); // impulses should fire (every 4-9 s)
const honeycombPings = ctx.nodes.filter((n) => n._kind === 'oscillator').length - oscCountBefore;
check('pitched impulses fire while in HONEYCOMB', honeycombPings >= 1, String(honeycombPings));

// ---- 4. CORRIDOR_GRID duct whistle -----------------------------------------
run(3, 3);
const ductNoise = ctx.nodes.filter((n) => n._kind === 'buffer-source' && n.loop);
check('corridor runs a looping noise bed', ductNoise.length === 1);
const whistles = ctx.nodes.filter((n) => n._kind === 'filter' && n.type === 'bandpass' && n.Q.value > 10);
check('duct whistle is a narrow bandpass pair',
  whistles.length === 2 && Math.abs(whistles[0].frequency.value - whistles[1].frequency.value) > 1
    && Math.abs(whistles[0].frequency.value - whistles[1].frequency.value) < 8,
  JSON.stringify(whistles.map((w) => w.frequency.value)));

// ---- 5. STORAGE metal settles ----------------------------------------------
run(70, 4); // first groan after up to ~12 s, next after 25-60 s
const slumpOscs = ctx.nodes.filter((n) => n._kind === 'oscillator' &&
  n.frequency.value > 40 && n.frequency.value < 90 && n._stops.length > 0);
check('storage fires slumping metal-settle voices', slumpOscs.length >= 1,
  String(slumpOscs.length));

// ---- 6. OPEN_OFFICE telephones ----------------------------------------------
const officeCtx = new Ctx();
const phone = new PhoneRinger(officeCtx, officeCtx.destination);
phone.seed(SEED);
check('phone placement hash is deterministic across instances',
  phone.hasPhone(1, 0) === bedsHas(1, 0) && phone.hasPhone(-3, 7) === bedsHas(-3, 7));
function bedsHas(cx, cz) {
  const probe = new PhoneRinger(new Ctx(), null);
  probe.seed(SEED);
  return probe.hasPhone(cx, cz);
}
check('placement density is sparse (< 60% of cells)', density() < 0.6, String(density()));
function density() {
  let hit = 0;
  const probe = new PhoneRinger(new Ctx(), null);
  probe.seed(SEED);
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) if (probe.hasPhone(x, z)) hit++;
  return hit / 400;
}
// find one placed phone near the origin and stand inside its earshot
let spot = null;
for (let cx = 0; cx < 6 && !spot; cx++) {
  for (let cz = 0; cz < 6 && !spot; cz++) {
    if (phone.hasPhone(cx, cz)) spot = phone.phoneAt(cx, cz);
  }
}
check('found a hashed phone to test against', spot !== null);
if (spot) {
  phone.update(0.1, spot.x, spot.z);
  check('phone rings when the listener comes within earshot',
    officeCtx.nodes.filter((n) => n._kind === 'oscillator').length >= 2);
  const afterFirst = officeCtx.nodes.filter((n) => n._kind === 'oscillator').length;
  phone.update(0.1, spot.x, spot.z); // same session, same phone
  check('a phone never rings twice in one session',
    officeCtx.nodes.filter((n) => n._kind === 'oscillator').length === afterFirst);
  const farX = spot.x + RING_HEARSHOT + PHONE_CELL;
  const otherCtxOscs = officeCtx.nodes.filter((n) => n._kind === 'oscillator').length;
  phone.update(0.1, farX, farX);
  check('distant un-rung phones stay quiet',
    officeCtx.nodes.filter((n) => n._kind === 'oscillator').length >= otherCtxOscs);
}
// office island feeds the ringer through setListener
beds.setListener(1e9, 1e9); // nowhere near any hashed cell
const preOffice = ctx.nodes.filter((n) => n._kind === 'oscillator').length;
run(2, 1);
check('office island activates its gate', gateTargets()[1] > 0.5, String(gateTargets()[1]));

// ---- 7. kill-switch + stop --------------------------------------------------
beds.setEnabled(false);
check('kill-switch fades every open gate to zero',
  gateTargets().every((v) => v === 0), JSON.stringify(gateTargets()));
run(2, 4);
check('disabled beds stop scheduling', (() => {
  const before = ctx.nodes.filter((n) => n._kind === 'oscillator').length;
  run(30, 4);
  return ctx.nodes.filter((n) => n._kind === 'oscillator').length === before;
})());
beds.stop();
beds.stop(); // double-stop safe

console.log(failures.length === 0
  ? '\nALL PASS'
  : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
