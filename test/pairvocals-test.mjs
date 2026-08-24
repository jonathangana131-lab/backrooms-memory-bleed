/*
 * Paired background voices tests -- pure Node, no browser.
 * Drives PairVocals against a minimal WebAudio mock and checks:
 *   1. spawn() registers one exchange echoing its anchor pair
 *   2. voice graph: detuned sawtooth pairs through two bandpass formants,
 *      panned wide, envelopes resting at silence
 *   3. same seed -> identical voice characters for the whole knot
 *   4. turn-taking hands the floor between speakers and counts turns
 *   5. the listening partner stays hushed while the other babbles
 *   6. long exchanges part, retire themselves, and release their voices
 *   7. stop() hushes everything, releases sources, and is final
 *
 * The TS module is bundled with esbuild so its '../core/rng' import
 * resolves under plain Node (same loader as groans-test).
 */
import { createRequire } from 'node:module';
import { writeFileSync, readdirSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const pnpmDir = process.cwd() + '/node_modules/.pnpm';
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
    if (!entry) throw new Error('esbuild not found in node_modules');
    return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
  }
}
const esbuild = loadEsbuild();
const BUILT = process.cwd() + '/test/.pairvocals-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/audio/pairvocals.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);
const { PairVocals } = await import('./.pairvocals-build.mjs');

// ---- minimal AudioContext mock -------------------------------------------
let now = 100;
class Param {
  constructor(v) {
    this.value = v;
    this.inputs = [];
    this.isParam = true;
    this.targets = []; // scheduled setTargetAtTime calls as {t, tc, v}
  }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { if (v > 0) this.value = v; }
  cancelScheduledValues() {}
  setTargetAtTime(v, t, tc) { this.targets.push({ t, tc, v }); }
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.edges = []; this.inputs = [];
    this.gain = new Param(1); this.frequency = new Param(440);
    this.Q = new Param(1); this.type = ''; this.pan = new Param(0);
    this.startedCount = 0; this.stoppedCount = 0;
  }
  connect(dest) { this.edges.push(dest); if (!dest.isParam) dest.inputs.push(this); return dest; }
  start() { this.startedCount++; }
  stop() { this.stoppedCount++; }
}
class Ctx {
  constructor() { this.currentTime = now; this.nodes = []; this.destination = new Node(this); }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new Node(this); n._kind = 'filter'; this.nodes.push(n); return n; }
  createStereoPanner() { const n = new Node(this); n._kind = 'panner'; this.nodes.push(n); return n; }
}

/** Advance the mock clock and tick the instance in small frames. */
function step(ctx, pv, seconds) {
  const frame = 1 / 30;
  for (let t = 0; t < seconds; t += frame) {
    ctx.currentTime += frame;
    pv.update(frame);
  }
}

function oscsSince(ctx, mark) { return ctx.nodes.slice(mark).filter((n) => n._kind === 'oscillator'); }
function envGainsOf(osc) {
  // osc -> [formant] -> shared env gain
  const firstFormant = osc.edges[0];
  return firstFormant.edges.find((n) => n._kind === 'gain');
}

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (!cond) failures.push(name);
}

// ---- 1: spawn registers one exchange ----------------------------------------
{
  const ctx = new Ctx();
  const pv = new PairVocals(ctx, ctx.destination);
  check('fresh instance has no exchanges', pv.debugState().length === 0);
  pv.spawn(3, -2, 6, 1, 42);
  const st = pv.debugState();
  check('spawn() registers exactly one exchange', st.length === 1);
  check('anchors are echoed into diagnostics',
    st[0].ax === 3 && st[0].az === -2 && st[0].bx === 6 && st[0].bz === 1);
  check('exchanges begin mid-conversation', st[0].phase === 'exchange' && st[0].turns === 0);

  pv.spawn(10, 10, 12, 12, 43);
  check('a second spawn adds another knot', pv.debugState().length === 2);
}

// ---- 2: graph shape ----------------------------------------------------------
{
  const ctx = new Ctx();
  const pv = new PairVocals(ctx, ctx.destination);
  const mark = ctx.nodes.length;
  pv.spawn(0, 0, 4, 0, 7);
  const oscs = oscsSince(ctx, mark);
  check('each exchange is exactly two glottal voices', oscs.length === 2);
  check('voices are sawtooth glottal buzzes', oscs.every((o) => o.type === 'sawtooth'));
  check('glottal pitch lands in the 90-160 Hz band',
    oscs.every((o) => o.frequency.value >= 90 && o.frequency.value <= 160));
  check('both voices started', oscs.every((o) => o.startedCount === 1));

  for (const o of oscs) {
    const filters = o.edges.filter((n) => n._kind === 'filter');
    check('two bandpass formants per voice',
      filters.length === 2 && filters.every((f) => f.type === 'bandpass' && f.Q.value === 7));
    check('formant 1 sits low, formant 2 high',
      Math.max(...filters.map((f) => f.frequency.value)) <= 2300
        && Math.min(...filters.map((f) => f.frequency.value)) >= 500);
    const pan = filters[0].edges[0].edges.find((n) => n._kind === 'panner');
    check('voice is panned inside the wide stereo window',
      !!pan && pan.pan.value >= -0.7 && pan.pan.value <= 0.7, String(pan?.pan?.value));
    const env = envGainsOf(o);
    check('envelopes rest at silence until spoken', env.gain.value === 0);
  }

  // the two speakers of one knot are detuned apart
  const [oa, ob] = oscs;
  check('the pair is detuned, never unison', oa.frequency.value !== ob.frequency.value);
}

// ---- 3: deterministic seeding -------------------------------------------------
{
  function voicePrint(seed) {
    const ctx = new Ctx();
    const pv = new PairVocals(ctx, ctx.destination);
    const mark = ctx.nodes.length;
    pv.spawn(0, 0, 4, 0, seed);
    return JSON.stringify(oscsSince(ctx, mark).map((o) => [
      o.frequency.value,
      ...o.edges.filter((n) => n._kind === 'filter').map((f) => f.frequency.value),
      o.edges[0].edges[0].edges.find((n) => n._kind === 'panner').pan.value,
    ]));
  }
  check('same seed -> identical voice characters', voicePrint(999) === voicePrint(999));
  check('different seed -> different voices', voicePrint(999) !== voicePrint(1000));
}

// ---- 4+5: turn-taking and hushed listener --------------------------------------
{
  const ctx = new Ctx();
  const pv = new PairVocals(ctx, ctx.destination);
  const mark = ctx.nodes.length;
  pv.spawn(0, 0, 4, 0, 21);
  const [va, vb] = oscsSince(ctx, mark);
  const ea = envGainsOf(va), eb = envGainsOf(vb);

  step(ctx, pv, 2);
  let st = pv.debugState()[0];
  // each completed turn hands the floor over, so parity tracks the count
  check('floor changes hands as utterances expire',
    st.turns >= 1 && st.speaker === st.turns % 2, JSON.stringify(st));
  check('speaker A babbles syllable envelopes', ea.gain.targets.some((x) => x.v > 0.01));
  check('utterances stay quiet background babble',
    ea.gain.targets.filter((x) => x.v > 0).every((x) => x.v <= 0.06));

  step(ctx, pv, 2);
  check('listener is hushed toward near-silence each tick',
    eb.gain.targets.some((x) => x.v <= 0.0001));
  st = pv.debugState()[0];
  check('turn counter keeps climbing while talk continues', st.turns >= 2, String(st.turns));
}

// ---- 6: exchanges dry up and retire --------------------------------------------
{
  const ctx = new Ctx();
  const pv = new PairVocals(ctx, ctx.destination);
  const mark = ctx.nodes.length;
  pv.spawn(0, 0, 4, 0, 5);
  const [va, vb] = oscsSince(ctx, mark);
  // force the floor back and forth past the parting threshold (>12 turns);
  // dt larger than any utterance guarantees exactly one handover per tick
  for (let i = 0; i < 13; i++) pv.update(5);
  let st = pv.debugState()[0];
  check('long exchanges move on to parting', !!st && st.phase === 'parting',
    JSON.stringify(st));
  // parting cools down (~PHRASE_COOL), then the knot retires itself
  pv.update(4);
  check('parted exchanges retire completely', pv.debugState().length === 0,
    JSON.stringify(pv.debugState()));
  check('retirement stops both oscillators',
    va.stoppedCount === 1 && vb.stoppedCount === 1);
}

// ---- 7: stop() -------------------------------------------------------------------
{
  const ctx = new Ctx();
  const pv = new PairVocals(ctx, ctx.destination);
  const duo = { ax: -4, az: 9, bx: -1, bz: 11 };
  pv.spawn(duo.ax, duo.az, duo.bx, duo.bz, 77);
  pv.update(1 / 60);
  const allOscs = ctx.nodes.filter((n) => n._kind === 'oscillator');
  const gainsAll = ctx.nodes.filter((n) => n._kind === 'gain' && n !== ctx.destination);
  pv.stop();
  check('stop() forgets every exchange', pv.debugState().length === 0);
  check('stop() releases both voices',
    allOscs.every((o) => o.stoppedCount === 1), String(allOscs.map((o) => o.stoppedCount)));
  check('stop() hushes every voice envelope',
    gainsAll.some(function (n) {
      return n.gain.targets.some(function (x) { return x.v <= 0.0001; });
    }));
  step(ctx, pv, 3, duo);
  check('stopped instance ignores update()', pv.debugState().length === 0);
}

console.log(failures.length === 0
  ? '\nALL PASS'
  : '\n' + failures.length + ' FAILURE(S): ' + failures.join(', '));
process.exitCode = failures.length === 0 ? 0 : 1;
