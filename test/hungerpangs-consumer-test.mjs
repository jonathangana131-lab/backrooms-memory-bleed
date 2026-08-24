/**
 * Stomach growl synth tests (F73 v1.1 debt payoff) - pure Node, no audio
 * device. Verifies that drained HungerPangs events render as deterministic
 * procedural growls: planGrowl() is pure (same event -> deep-equal plan,
 * no wall-clock / Math.random anywhere), envelopes stay inside the pang's
 * seeded duration with ascending times and a silent tail, peak gain grows
 * monotonically with pang intensity, StomachAudio routes one oscillator
 * chain per event into the destination, empty drains and stop() are
 * no-ops, a broken node factory degrades per voice instead of throwing,
 * and a real 200-minute seeded schedule round-trips drain -> consume 1:1.
 * Run: node test/hungerpangs-consumer-test.mjs  (prints ALL PASS, exits 0)
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
const moduleSrc = readFileSync(path.join(here, '../src/audio/hungerpangs-consumer.ts'), 'utf8');

const {
  StomachAudio, planGrowl,
} = await import('../src/audio/hungerpangs-consumer.ts');
const { HungerPangs } = await import('../src/player/hunger.ts');

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; console.log('  PASS', msg); }
  else { failures++; console.error('  FAIL', msg); }
};
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- purity lint: the synth must not touch nondeterministic time ----------
ok(!/Math\.random/.test(moduleSrc), 'hungerpangs-consumer.ts is free of Math.random');
ok(!/Date\.now/.test(moduleSrc), 'hungerpangs-consumer.ts is free of Date.now');
ok(!/performance\.now/.test(moduleSrc), 'hungerpangs-consumer.ts is free of performance.now');

// ---- minimal AudioContext mock (fanaudio-test conventions) ----------------
class Param {
  constructor(v) { this.value = v; this.ramps = []; this.sets = []; }
  setValueAtTime(v, t) { this.value = v; this.sets.push({ v, t }); }
  linearRampToValueAtTime(v, t) { this.value = v; this.ramps.push({ v, t, kind: 'lin' }); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.ramps.push({ v, t, kind: 'exp' }); }
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.out = null;
    this.gain = new Param(1); this.frequency = new Param(440);
    this.Q = new Param(1); this.type = '';
    this._startAt = -1; this._stopAt = -1;
  }
  connect(dest) { this.out = dest; return dest; }
  start(at) { this._startAt = at ?? this.ctx.currentTime; }
  stop(at) { this._stopAt = at ?? this.ctx.currentTime; }
}
class Ctx {
  constructor(breakAfter = Infinity) {
    this.currentTime = 1000; this.nodes = [];
    this.breakAfter = breakAfter; this.created = 0;
    this.destination = new Node(this); this.destination._kind = 'destination';
  }
  #track(n) { this.nodes.push(n); return n; }
  createOscillator() {
    if (++this.created > this.breakAfter) throw new RangeError('oscillator budget blown');
    const n = new Node(this); n._kind = 'oscillator'; return this.#track(n);
  }
  createGain() { const n = new Node(this); n._kind = 'gain'; return this.#track(n); }
  createBiquadFilter() { const n = new Node(this); n._kind = 'filter'; return this.#track(n); }
}

const mkEvent = (timeMin, intensity, durationS) => ({ timeMin, intensity, durationS });

// ---- 1: planGrowl is pure and shape-complete -------------------------------
{
  const e = mkEvent(12.5, 0.5, 1.2);
  const a = JSON.stringify(planGrowl(e));
  const b = JSON.stringify(planGrowl(e));
  ok(a === b, 'planGrowl is pure: same event deep-equals itself');
  const p = planGrowl(e);
  ok(p.oscType === 'sawtooth', 'growl voice is a sawtooth rumble');
  ok(p.endHz < p.startHz && p.startHz > 60 && p.startHz < 130,
    `rumble falls from ${p.startHz.toFixed(1)} Hz to ${p.endHz.toFixed(1)} Hz`);
  ok(approx(p.durationS, 1.2), 'plan duration equals the pang seeded durationS');
  ok(Array.isArray(p.envelope) && p.envelope.length >= 4,
    'envelope has attack + gurgles + tail (' + p.envelope.length + ' points)');
}

// ---- 2: envelope discipline -------------------------------------------------
{
  for (const [intensity, dur] of [[0, 0.5], [0.37, 0.9], [1, 1.6]]) {
    const p = planGrowl(mkEvent(30, intensity, dur));
    const times = p.envelope.map((pt) => pt.atS);
    let ascending = true;
    for (let i = 1; i < times.length; i++) if (times[i] <= times[i - 1]) ascending = false;
    ok(ascending, `envelope times ascend (i=${intensity})`);
    ok(times[0] === 0 && approx(times[times.length - 1], p.durationS),
      `envelope spans exactly [0, duration] (i=${intensity})`);
    ok(times[times.length - 1] <= dur + 1e-9, `envelope stays inside seeded duration (i=${intensity})`);
    ok(approx(p.envelope[0].gain, 0) && approx(p.envelope[p.envelope.length - 1].gain, 0),
      'voice starts and ends silent (i=' + intensity + ')');
  }
}

// ---- 3: intensity grades loudness and brightness ---------------------------
{
  const gains = [0, 0.25, 0.5, 0.75, 1].map((i) => planGrowl(mkEvent(10, i, 1)).peakGain);
  let monotonic = true;
  for (let i = 1; i < gains.length; i++) if (gains[i] <= gains[i - 1]) monotonic = false;
  ok(monotonic, 'peak gain grows monotonically with pang intensity');
  const bright = planGrowl(mkEvent(10, 1, 1)).lowpassHz;
  const dark = planGrowl(mkEvent(10, 0, 1)).lowpassHz;
  ok(bright > dark, 'lowpass opens with intensity (harder pangs brighter)');
}

// ---- 4: same-minute collisions still differ via salt ------------------------
{
  const e = mkEvent(42, 0.6, 1.0);
  const a = JSON.stringify(planGrowl(e, 0));
  const b = JSON.stringify(planGrowl(e, 1));
  ok(a !== b, 'salt varies voices sharing a session minute');
  ok(JSON.stringify(planGrowl(e, 0)) === a, 'salted plans remain pure');
}

// ---- 5: consume([]) and stop() are no-ops -----------------------------------
{
  const ctx = new Ctx();
  const stomach = new StomachAudio(ctx, ctx.destination);
  ok(stomach.consume([]) === 0 && ctx.nodes.length === 0,
    'empty drain schedules nothing');
  stomach.stop();
  ok(stomach.consume([mkEvent(50, 0.5, 1)]) === 0 && ctx.nodes.length === 0,
    'stop() makes later consumes permanent no-ops');
}

// ---- 6: one routed oscillator chain per event -------------------------------
{
  const ctx = new Ctx();
  const stomach = new StomachAudio(ctx, ctx.destination);
  const events = [mkEvent(20, 0.2, 0.8), mkEvent(33, 0.8, 1.4)];
  const n = stomach.consume(events);
  ok(n === 2, 'consume renders one voice per drained pang');
  const oscs = ctx.nodes.filter((x) => x._kind === 'oscillator');
  const filters = ctx.nodes.filter((x) => x._kind === 'filter');
  ok(oscs.length === 2 && filters.length === 2, 'voice chain is osc + filter (+ gain)');
  for (const o of oscs) {
    ok(o.type === 'sawtooth', 'each voice is a sawtooth');
    ok(o.out !== null && o.out._kind === 'filter', 'osc routes through the lowpass');
    const startSet = o.frequency.sets[0];
    const lastRamp = o.frequency.ramps[o.frequency.ramps.length - 1];
    ok(startSet !== undefined && lastRamp !== undefined && lastRamp.v < startSet.v,
      'pitch falls across the voice');
  }
  const tail = oscs.map((o) => o.out.out).find(Boolean);
  ok(tail !== undefined && tail._kind === 'gain' && tail.out === ctx.destination,
    'filter feeds a gain that lands on the destination');
  ok(stomach.voicesStarted === 2, 'voicesStarted counts scheduled growls');
  // Voice length honors the pang duration (stop is just past the tail).
  const ev = events[1];
  ok(approx(oscs[1]._stopAt - oscs[1]._startAt, ev.durationS + 0.02, 1e-6),
    'voice stop sits just past its seeded duration');
}

// ---- 7: broken graph degrades per voice, never throws -----------------------
{
  const ctx = new Ctx(1); // oscillator factory dies after the first voice
  const stomach = new StomachAudio(ctx, ctx.destination);
  const events = [mkEvent(20, 0.2, 0.8), mkEvent(21, 0.4, 0.8), mkEvent(22, 0.6, 0.8)];
  let n = -1;
  try { n = stomach.consume(events); } catch { n = -1; }
  ok(n === 1, `partial failure island: ${n}/3 voices rendered, no throw`);
  ok(stomach.voicesStarted === 1, 'counter only counts rendered voices');
}

// ---- 8: real schedule round-trip: drainEvents -> consume 1:1 ---------------
{
  const ctx = new Ctx();
  const stomach = new StomachAudio(ctx, ctx.destination);
  const hunger = new HungerPangs((1234 ^ 0x4e71) >>> 0);
  hunger.update(200); // long expedition: past grace, well into crowding
  const pangs = hunger.drainEvents();
  ok(pangs.length >= 10, `200-minute run drains ${pangs.length} pangs`);
  ok(stomach.consume(pangs) === pangs.length, 'every drained pang becomes a growl');
  hunger.update(201);
  ok(stomach.consume(hunger.drainEvents()) >= 0, 'later drains still consumable');
  ok(stomach.consume([]) === 0, 'empty drain after consumption schedules nothing');
}

console.log(failures === 0 ? `\nSTOMACH AUDIO ALL PASS ${passes}/0` : `\nSTOMACH AUDIO FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
