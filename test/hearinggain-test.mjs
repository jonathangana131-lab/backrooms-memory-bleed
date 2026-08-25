/**
 * Adrenaline hearing-gain consumer tests (v1.1 debt payoff) - pure Node,
 * no audio device. Verifies that the stored-but-unconsumed
 * `adrenalineHearingGainMul` field finally drives an audio-layer
 * multiplier: AudioEngine grows a dedicated ambience gain bus sitting
 * between the wall-occlusion lowpass and master (occlusion -> ambience ->
 * master), `setHearingMul()` clamps to [1, HEARING_GAIN_MUL_MAX] and is
 * NaN-safe, pre-unlock requests are remembered and seeded into the bus,
 * live requests automate ONLY the ambience bus via setTargetAtTime with
 * tau HEARING_MUL_TAU_S (never master.gain - DreadSilence owns that),
 * AdrenalineSystem envelopes map monotonically onto bus levels and decay
 * back to unity, and game.ts actually feeds the field every frame plus
 * resets it on beginRun. Run: node test/hearinggain-test.mjs (prints ALL PASS)
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const audioSrc = readFileSync(path.join(here, '../src/audio/audio.ts'), 'utf8');
const gameSrc = readFileSync(path.join(here, '../src/core/game.ts'), 'utf8');

const { AudioEngine, HEARING_MUL_TAU_S } = await import('../src/audio/audio.ts');
const { AdrenalineSystem, HEARING_GAIN_MUL_MAX, ATTACK_S, DECAY_S } = await import('../src/player/adrenaline.ts');

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; console.log('  PASS', msg); }
  else { failures++; console.error('  FAIL', msg); }
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- minimal AudioContext mock (hungerpangs-consumer-test conventions) -----
class Param {
  constructor(v) {
    this.value = v;
    this.targets = []; // setTargetAtTime records
    this.ramps = [];
    this.sets = [];
  }
  setValueAtTime(v, t) { this.value = v; this.sets.push({ v, t }); }
  linearRampToValueAtTime(v, t) { this.value = v; this.ramps.push({ v, t, kind: 'lin' }); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.ramps.push({ v, t, kind: 'exp' }); }
  setTargetAtTime(v, t, tc) { this.targets.push({ v, t, tc }); return v; }
  cancelScheduledValues() {}
}
class GNode {
  constructor(ctx) {
    this.ctx = ctx; this.out = null; this.inputs = [];
    this.gain = new Param(1); this.frequency = new Param(20000);
    this.Q = new Param(0.4); this.pan = new Param(0);
    this.threshold = new Param(-18); this.ratio = new Param(6);
    this.type = ''; this.buffer = null; this.loop = false;
  }
  connect(dest) { this.out = dest; if (dest) dest.inputs?.push(this); return dest; }
  disconnect() { this.out = null; }
  start() {} stop() {}
}
class FakeCtx {
  constructor() {
    this.currentTime = 500;
    this.sampleRate = 48000;
    this.destination = new GNode(this);
    this.created = { gain: 0, filter: 0, other: 0 };
  }
  createGain() { this.created.gain++; return new GNode(this); }
  createBiquadFilter() { this.created.filter++; const n = new GNode(this); n.type = 'lowpass'; return n; }
  createStereoPanner() { return new GNode(this); }
  createDynamicsCompressor() { return new GNode(this); }
  createConvolver() { return new GNode(this); }
  createOscillator() { return new GNode(this); }
  createBufferSource() { return new GNode(this); }
  createBuffer(channels, length, sr) {
    return { channels, length, sampleRate: sr, getChannelData: () => new Float32Array(length) };
  }
}

globalThis.window = { AudioContext: FakeCtx };

// ---- stage A: clamp + storage semantics ------------------------------------
console.log('STAGE A: setHearingMul clamp/storage semantics');
{
  const eng = new AudioEngine();
  ok(eng.hearingMulLevel === 1, 'identity until any request');
  eng.setHearingMul(1.75);
  ok(close(eng.hearingMulLevel, 1.75), 'in-range value stored verbatim');
  eng.setHearingMul(0.5);
  ok(eng.hearingMulLevel === 1, 'below-range request clamps up to 1');
  eng.setHearingMul(50);
  ok(eng.hearingMulLevel === HEARING_GAIN_MUL_MAX && HEARING_GAIN_MUL_MAX === 2,
    'above-range request clamps down to HEARING_GAIN_MUL_MAX=2');
  eng.setHearingMul(NaN);
  ok(eng.hearingMulLevel === 1, 'NaN falls back to identity');
  eng.setHearingMul(Infinity);
  ok(eng.hearingMulLevel === 1, 'non-finite junk (Infinity) falls back to identity like NaN');
  // none of that threw without an unlocked ctx
}

// ---- stage B: graph shape + pre-unlock seeding ------------------------------
console.log('STAGE B: ambience bus graph + pre-unlock seeding');
let eng;
{
  eng = new AudioEngine();
  eng.setHearingMul(1.5); // requested while still cold
  eng.unlock();
  ok(eng.started && eng.ctx instanceof FakeCtx, 'unlock builds the fake graph');
  const amb = eng['ambience'];
  const occ = eng['occlusion'];
  const master = eng['master'];
  ok(amb && typeof amb.gain === 'object', 'ambience gain bus exists after unlock');
  ok(occ.out === amb, 'occlusion lowpass feeds the ambience bus (not master)');
  ok(amb.out === master, 'ambience bus feeds master');
  ok(close(amb.gain.value, 1.5), 'pre-unlock request seeds the bus gain (1.5)');
  // hum + room tone route through ambientOut() -> occlusion -> ambience chain
  ok(master.gain.targets.length === 0 && master.gain.sets.length === 0,
    'master.gain untouched by construction of the hearing bus');
}

// ---- stage C: live automation targets only the ambience bus -----------------
console.log('STAGE C: live automation, tau, master ownership');
{
  const amb = eng['ambience'];
  const master = eng['master'];
  const beforeTargets = amb.gain.targets.length;
  const beforeMasterTargets = master.gain.targets.length;
  const beforeMasterSets = master.gain.sets.length;
  eng.setHearingMul(2);
  ok(amb.gain.targets.length === beforeTargets + 1, 'live request schedules one target event');
  const ev = amb.gain.targets[amb.gain.targets.length - 1];
  ok(close(ev.v, 2), 'target value is the clamped multiplier');
  ok(ev.t === eng.ctx.currentTime, 'automation starts at ctx.currentTime');
  ok(close(ev.tc, HEARING_MUL_TAU_S) && HEARING_MUL_TAU_S === 0.25,
    'smoothing tau is HEARING_MUL_TAU_S=0.25');
  ok(master.gain.targets.length === beforeMasterTargets && master.gain.sets.length === beforeMasterSets,
    'setHearingMul never automates master.gain (DreadSilence owns it)');
  ok(!/setHearingMul[\s\S]{0,600}master\.gain/.test(audioSrc),
    'setHearingMul body never references master.gain in source');
  // repeated same-value requests stay idempotent-ish (still schedule, no drift)
  eng.setHearingMul(1);
  const ev2 = amb.gain.targets[amb.gain.targets.length - 1];
  ok(close(ev2.v, 1), 'decay-to-unity request lands as its own target event');
  ok(amb.gain.value === 1.5, 'Param.value snapshot untouched by setTargetAtTime (audio-thread owns motion)');
}

// ---- stage D: adrenaline envelope maps monotonically onto bus levels --------
console.log('STAGE D: AdrenalineSystem -> setHearingMul mapping');
{
  const sys = new AdrenalineSystem();
  ok(sys.hearingGainMul === 1, 'resting envelope is identity');
  sys.update(0.016);
  sys.pushNearMiss({ severity: 1 });
  sys.update(ATTACK_S); // end of attack: peak energy
  const peak = sys.hearingGainMul;
  ok(peak > 1 && peak <= HEARNING_GUARD(), `post-dump multiplier rises but never exceeds ceiling (${peak.toFixed(3)})`);
  sys.update(DECAY_S + ATTACK_S + 1); // fully expired
  ok(sys.hearingGainMul === 1, 'expired envelope decays back to exact unity');
  function HEARNING_GUARD() { return HEARING_GAIN_MUL_MAX; }

  // feed the real envelope trajectory through the engine API
  const traj = [];
  let pushAt = -1;
  const s2 = new AdrenalineSystem();
  for (let i = 0; i < 40; i++) {
    s2.update(0.1);
    if (i === 2 && s2.pushNearMiss({ severity: 0.9 })) pushAt = s2.now;
    traj.push(s2.hearingGainMul);
  }
  // after this dump's attack window closes the envelope must only fall
  const attackEndIdx = Math.ceil((pushAt + ATTACK_S) / 0.1);
  let monotoneOk = true;
  for (let i = attackEndIdx; i < traj.length; i++) if (traj[i] > traj[i - 1] + 1e-12) monotoneOk = false;
  ok(monotoneOk, 'single dump trajectory never re-rises after its attack window');
  ok(traj.every((m) => m >= 1 && m <= HEARING_GAIN_MUL_MAX), 'every sampled multiplier stays inside [1, 2]');
  const levels = traj.map((m) => { eng.setHearingMul(m); return eng.hearingMulLevel; });
  ok(levels.every((m, i) => close(m, traj[i])), 'engine stores every envelope sample unclipped');
}

// ---- stage E: game.ts wiring -------------------------------------------------
console.log('STAGE E: game.ts frame feed + fresh-run reset');
{
  ok(/this\.adrenalineHearingGainMul = this\.adrenaline\.hearingGainMul;\s*\n[\s\S]{0,400}?this\.audio\.setHearingMul\(this\.adrenalineHearingGainMul\)/.test(gameSrc),
    'frame loop feeds the stored multiplier into setHearingMul');
  ok(/this\.adrenalineHearingGainMul = 1;\s*\n[\s\S]{0,300}?this\.audio\.setHearingMul\(1\)/.test(gameSrc),
    'beginRun resets the ambience bus to unity alongside the field');
  ok((gameSrc.match(/this\.audio\.setHearingMul\(/g) || []).length === 2,
    'exactly two call sites (feed + reset) keep the seam single-purpose');
}

// ---- stage F: reset semantics across simulated runs --------------------------
console.log('STAGE F: run-reset drops a stale boost');
{
  eng.setHearingMul(1.87); // mid-chase state
  ok(close(eng.hearingMulLevel, 1.87), 'mid-run boost active');
  // what beginRun does:
  eng.setHearingMul(1);
  const last = eng['ambience'].gain.targets[eng['ambience'].gain.targets.length - 1];
  ok(close(last.v, 1), 'reset schedules the bus back to unity');
}

console.log(failures === 0 ? `\n${passes}/${passes} checks ALL PASS` : `\n${failures} FAILURE(S) / ${passes} passes`);
process.exitCode = failures === 0 ? 0 : 1;
