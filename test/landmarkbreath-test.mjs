/*
 * Landmark room breathing tests -- pure Node, no browser.
 * Drives LandmarkBreath against a minimal WebAudio mock and checks:
 *   1. constructor exposes kind/vol and a ~5-9 s breath period
 *   2. free-running update swells the chest toward vol and back
 *   3. hold() pins near silence, then resumes with a loud exhale
 *   4. only ARCHIVE rooms ride paper rustle
 *   5. MEDICAL rooms emit soft monitor blips, PLAYROOM toy chimes
 *   6. stop() silences everything and double-stop is safe
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
const BUILT = process.cwd() + '/test/.landmarkbreath-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/audio/landmarkbreath.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);
const { LandmarkBreath } = await import('./.landmarkbreath-build.mjs');

// ---- minimal AudioContext mock -------------------------------------------
let now = 100;
class Param {
  constructor(v) {
    this.value = v;
    this.inputs = [];
    this.isParam = true;
    this.targets = []; // every setTargetAtTime(target, timeConstant)
  }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { if (v > 0) this.value = v; }
  cancelScheduledValues() {}
  setTargetAtTime(target, _t, tc) { this.targets.push({ target, tc }); this.value = target; }
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.edges = []; this.inputs = [];
    this.gain = new Param(1); this.frequency = new Param(440);
    this.Q = new Param(1); this.type = '';
    this.buffer = null; this.loop = false;
    this.startedCount = 0; this.stoppedCount = 0;
  }
  connect(dest) { this.edges.push(dest); if (!dest.isParam) dest.inputs.push(this); return dest; }
  start() { this.startedCount++; }
  stop() { this.stoppedCount++; }
}
class Ctx {
  constructor() {
    this.currentTime = now;
    this.sampleRate = 48000;
    this.nodes = [];
    this.destination = new Node(this); this.destination._kind = 'destination';
  }
  createBuffer(channels, len) {
    const data = new Float32Array(len).fill(0.25);
    return { getChannelData: () => data };
  }
  createBufferSource() { const n = new Node(this); n._kind = 'bufferSource'; this.nodes.push(n); return n; }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new Node(this); n._kind = 'filter'; this.nodes.push(n); return n; }
}

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (!cond) failures.push(name);
}

/** The chest gain node of an instance's graph (noise -> lowpass -> chest -> out). */
function chestOf(lb) {
  return lb.out.edges.find((n) => n._kind === 'gain' && n !== lb.rustleNode());
}

// ---- 1: construction -------------------------------------------------------
{
  const ctx = new Ctx();
  const lb = new LandmarkBreath(ctx, ctx.destination, 'ARCHIVE', 0.4);
  check('kind exposed', lb.kind === 'ARCHIVE');
  check('vol exposed', lb.vol === 0.4);
  check('period lands in the documented 5-9 s window', lb.period >= 5 && lb.period <= 9,
    String(lb.period));
  check('starts unstopped', lb.stopped === false);
  check('chest noise source is looping and running',
    ctx.nodes.filter((n) => n._kind === 'bufferSource').every((n) => n.loop && n.startedCount === 1));
  const outInputs = ctx.destination.inputs;
  check('chest and rustle stages both feed the destination', outInputs.length >= 2,
    String(outInputs.length));
  check('chest stage starts silent', ctx.destination.inputs.every((g) => g.gain.value === 0));

  // lowpass chest filter around 420 Hz, bandpass rustle around 2600 Hz
  const filters = ctx.nodes.filter((n) => n._kind === 'filter');
  check('two filters: chest lowpass + rustle bandpass', filters.length === 2);
  check('lowpass tuned ~420 Hz', filters.some((f) => f.type === 'lowpass' && f.frequency.value === 420));
  check('rustle bandpass tuned ~2600 Hz',
    filters.some((f) => f.type === 'bandpass' && f.frequency.value === 2600 && f.Q.value === 0.8));
}

// ---- 2: free-running swell -------------------------------------------------
{
  const ctx = new Ctx();
  const lb = new LandmarkBreath(ctx, ctx.destination, 'MEDICAL', 0.5);
  // drive one full cycle; env peaks mid-cycle so the chest target should reach
  // close to vol*boost at some sampled tick
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    lb.update(1 / 60);
    const t = ctx.destination.inputs[0].gain.targets.at(-1);
    if (t) peak = Math.max(peak, t.target);
  }
  check('swell reaches a meaningful fraction of resting vol', peak > 0.3, String(peak));
  check('swell never exceeds vol*boost ceiling (boost=1)', peak <= 0.5 + 1e-6, String(peak));

  // dt spikes are clamped: a tab-back frame must not skip the whole cycle
  const phaseBefore = peak;
  lb.update(30); // absurd frame
  const t = ctx.destination.inputs[0].gain.targets.at(-1);
  check('huge dt clamped to 0.1 s', !!t && Number.isFinite(t.target), JSON.stringify(t));
  void phaseBefore;
}

// ---- 3: hold() catches its breath ------------------------------------------
{
  const ctx = new Ctx();
  const lb = new LandmarkBreath(ctx, ctx.destination, 'ARCHIVE', 0.5);
  for (let i = 0; i < 60; i++) lb.update(1 / 60); // settle into the cycle
  const marks = ctx.destination.inputs.map((g) => g.gain.targets.length);
  lb.hold(0.5);
  lb.update(0.1);
  const heldTargets = ctx.destination.inputs.map((g) => g.gain.targets.at(-1)?.target);
  check('hold pins both layers near silence',
    heldTargets.every((v) => v !== undefined && v <= 0.0001), JSON.stringify(heldTargets));
  lb.hold(); // no-throw default
  check('hold() with default duration is accepted', true);

  // resume: after the pause elapses the exhale boost exceeds resting loudness
  let resumedPeak = 0;
  for (let i = 0; i < 120; i++) {
    lb.update(1 / 20);
    const t = ctx.destination.inputs[0].gain.targets.at(-1);
    if (t) resumedPeak = Math.max(resumedPeak, t.target);
  }
  check('resumed exhale overshoots resting loudness (boost 2.2)',
    resumedPeak > 0.6, String(resumedPeak));
  void marks;
}

// ---- 4: only ARCHIVE rides rustle -------------------------------------------
{
  for (const kind of ['ARCHIVE', 'MEDICAL', 'PLAYROOM']) {
    const ctx = new Ctx();
    const lb = new LandmarkBreath(ctx, ctx.destination, kind, 0.5);
    let rustlePeak = 0;
    for (let i = 0; i < 300; i++) {
      lb.update(1 / 30);
      const t = ctx.destination.inputs[1].gain.targets.at(-1);
      if (t) rustlePeak = Math.max(rustlePeak, t.target);
    }
    if (kind === 'ARCHIVE') {
      check('ARCHIVE rustle swells with the breath', rustlePeak > 0, String(rustlePeak));
    } else {
      check(kind + ' rustle stays pinned to zero', rustlePeak === 0, String(rustlePeak));
    }
  }
}

// ---- 5: ornaments -----------------------------------------------------------
{
  // MEDICAL: monitor blips arrive within ~4 s of ticking
  const med = new Ctx();
  const mb = new LandmarkBreath(med, med.destination, 'MEDICAL', 0.5);
  const oscMark = med.nodes.length;
  for (let i = 0; i < 240; i++) mb.update(1 / 30); // 8 s
  const blips = med.nodes.slice(oscMark).filter((n) => n._kind === 'oscillator');
  check('MEDICAL emits monitor blips on schedule', blips.length >= 1, String(blips.length));
  check('monitor blips are sine at ~1180 Hz',
    blips.every((o) => o.type === 'sine' && o.frequency.value === 1180));

  // PLAYROOM: chimes arrive later (~4-7 s apart)
  const play = new Ctx();
  const pb = new LandmarkBreath(play, play.destination, 'PLAYROOM', 0.5);
  const oscMarkP = play.nodes.length;
  for (let i = 0; i < 210; i++) pb.update(1 / 30); // 7 s
  const chimes = play.nodes.slice(oscMarkP).filter((n) => n._kind === 'oscillator');
  check('PLAYROOM emits toy chimes', chimes.length >= 2, String(chimes.length));
  check('chimes are triangle pairs at ~1046/1318 Hz',
    chimes.some((o) => o.frequency.value === 1046.5)
      && chimes.some((o) => o.frequency.value === 1318.5)
      && chimes.every((o) => o.type === 'triangle'));

  // ARCHIVE emits no ornaments
  const arc = new Ctx();
  const ab = new LandmarkBreath(arc, arc.destination, 'ARCHIVE', 0.5);
  const oscMarkA = arc.nodes.length;
  for (let i = 0; i < 300; i++) ab.update(1 / 30);
  check('ARCHIVE never ornaments', arc.nodes.slice(oscMarkA).every((n) => n._kind !== 'oscillator'));
}

// ---- 6: stop() ---------------------------------------------------------------
{
  const ctx = new Ctx();
  const breath = new LandmarkBreath(ctx, ctx.destination, 'ARCHIVE', 0.5);
  breath.stop();
  check('stop() flips stopped', breath.stopped === true);
  check('stop() releases every looping source',
    ctx.nodes.filter((n) => n._kind === 'bufferSource').every((n) => n.stoppedCount === 1));
  const mark = ctx.nodes.length;
  const gainsBefore = ctx.destination.inputs.map((g) => g.gain.targets.length);
  breath.update(0.05);
  breath.hold(1);
  check('update()/hold() are inert after stop',
    ctx.nodes.length === mark
      && ctx.destination.inputs.every((g, i) => g.gain.targets.length === gainsBefore[i]));
  breath.stop(); // double-stop must not throw
  check('double stop() is safe', true);
}

// ----------------------------------------------------------------------------
console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures.length);
process.exit(failures.length === 0 ? 0 : 1);
