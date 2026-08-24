/*
 * Headless tests for the binaural whisper field (feature F5).
 *
 * WhisperField runs against an injected AudioContext-ish interface, so
 * these run in plain Node with a stub context (same construction as
 * breath-test.mjs) and prove the acceptance criteria at graph level:
 *   1. pure panWeights(): source ahead-right feeds right > left under
 *      yaw theta; after a 180 degree turn the relation flips
 *   2. graph-level pan inversion through the real class + stub context
 *   3. world-fixing: translating the listener never drags a voice along;
 *      at equal distances only the bearing changes the split
 *   4. distance attenuation and graph wiring sanity
 *
 * Run: node test/whisperfield-test.mjs
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
const {
  WhisperField,
  panWeights,
  whisperAttenuation,
  VOICE_LEVEL,
  WHISPER_REF_DIST,
  VOICE_COUNT,
} = await import('../src/audio/whisperfield.ts');

// ---- minimal AudioContext stub --------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.targets = []; // {v, t, tc} from setTargetAtTime
    this.sets = [];    // {v, t} from setValueAtTime
  }
  setValueAtTime(v, t) { this.sets.push({ v, t }); this.value = v; }
  setTargetAtTime(v, t, tc) { this.targets.push({ v, t, tc }); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx;
    this._kind = '';
    this.gain = new Param(1);
    this.frequency = new Param(440);
    this.Q = new Param(1);
    this.positionX = new Param(0);
    this.positionY = new Param(0);
    this.positionZ = new Param(0);
    this.playbackRate = new Param(1);
    this.panningModel = 'equalpower';
    this.type = '';
    this.buffer = null;
    this.loop = false;
    this.conns = []; // {dest, out, in}
    this._starts = [];
    this._stops = [];
  }
  connect(dest, out = 0, inCh = 0) {
    this.conns.push({ dest, out, in: inCh });
    return dest;
  }
  disconnect() { this.conns.length = 0; }
  start(at) { this._starts.push(at ?? this.ctx.currentTime); }
  stop(at) { this._stops.push(at ?? this.ctx.currentTime); }
}
class Ctx {
  constructor() {
    this.currentTime = now;
    this.sampleRate = 48000;
    this.destination = new Node(this);
    this.destination._kind = 'destination';
    this.nodes = [this.destination];
  }
  _n(kind) {
    const n = new Node(this);
    n._kind = kind;
    this.nodes.push(n);
    return n;
  }
  createBufferSource() { return this._n('src'); }
  createBiquadFilter() { return this._n('filter'); }
  createGain() { return this._n('gain'); }
  createPanner() { return this._n('panner'); }
  createChannelMerger(channels) {
    const n = this._n('merger');
    n.channels = channels;
    return n;
  }
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

// ---- helpers over the stub graph ------------------------------------------
const lastTarget = (param) => param.targets.at(-1)?.v ?? param.value;

// ---- 1. pure panWeights -----------------------------------------------------
{
  // yaw = 0 faces -Z (Babylon LH): a source ahead-right must lead RIGHT
  const aheadRight = panWeights(0, 3, -4);
  check('panWeights: ahead-right leads right', aheadRight.right > aheadRight.left,
    JSON.stringify(aheadRight));
  check('panWeights: weights sum to 1',
    Math.abs(aheadRight.left + aheadRight.right - 1) < 1e-9);

  // 180-degree turn flips the relation
  const turned = panWeights(Math.PI, 3, -4);
  check('panWeights: 180-degree turn flips L/R dominance',
    turned.left > turned.right &&
    Math.abs(turned.left - aheadRight.right) < 1e-9,
    JSON.stringify(turned));

  // dead ahead and dead behind are interaurally ambiguous -> even split.
  // Dead-behind is the exact opposite of THIS yaw's forward vector
  // (-sin(yaw), -cos(yaw)), i.e. offset along (+sin, +cos).
  const front = panWeights(0, 0, -5);
  const behind = panWeights(0.7, Math.sin(0.7) * 5, Math.cos(0.7) * 5);
  check('panWeights: dead-ahead splits evenly',
    Math.abs(front.left - 0.5) < 1e-9 && Math.abs(front.right - 0.5) < 1e-9);
  check('panWeights: dead-behind splits evenly (any yaw)',
    Math.abs(behind.left - 0.5) < 1e-9 && Math.abs(behind.right - 0.5) < 1e-9);

  // hard right bearing saturates toward the right ear only
  const hardRight = panWeights(0, 5, 0);
  check('panWeights: abeam-right saturates right', hardRight.right > 0.99);

  // degenerate offset splits evenly, never divides by zero
  const zero = panWeights(1.23, 0, 0);
  check('panWeights: zero-length direction splits evenly', zero.left === 0.5);
}

// ---- 2. graph-level pan inversion -------------------------------------------
const ctx = new Ctx();
let pose = { x: 0, z: 0, yaw: 0 };
const field = new WhisperField(ctx, () => pose);
check('field builds >= 4 voices (spec)', ctx.nodes.filter((n) => n._kind === 'panner').length >= 4,
  String(ctx.nodes.filter((n) => n._kind === 'panner').length));
check('default voice count exported matches build', ctx.nodes.filter((n) => n._kind === 'panner').length === VOICE_COUNT);

// park the listener so voice 0 sits ahead-right, then prove the graph
// routes it right-dominant; turning 180 degrees flips the wiring.
const v0 = field.voiceAnchor(0);
pose = { x: v0.x - 7, z: v0.z + 7, yaw: 0 }; // voice at (+7, -7) relative: ahead-right
ctx.currentTime = ++now;
field.update(0.016);

const panners = ctx.nodes.filter((n) => n._kind === 'panner');
const earsOf = (p) => p.conns.filter((c) => c.dest._kind === 'gain')
  .map((c) => c.dest).slice(0, 2);
const g0 = { panner: panners[0], earL: earsOf(panners[0])[0], earR: earsOf(panners[0])[1] };
check('graph: each panner feeds exactly two ear gains', earsOf(panners[0]).length === 2);

const lBefore = lastTarget(g0.earL.gain);
const rBefore = lastTarget(g0.earR.gain);
check('graph: ahead-right voice feeds right ear harder than left', rBefore > lBefore,
  `L=${lBefore.toFixed(5)} R=${rBefore.toFixed(5)}`);

// the panner holds the WORLD-relative offset, not a listener-relative snap
check('graph: panner positionX carries world-relative dx',
  Math.abs(g0.panner.positionX.value - (v0.x - pose.x)) < 1e-9,
  `${g0.panner.positionX.value} vs ${v0.x - pose.x}`);
check('graph: panner positionZ carries world-relative dz',
  Math.abs(g0.panner.positionZ.value - (v0.z - pose.z)) < 1e-9);

pose = { x: v0.x - 7, z: v0.z + 7, yaw: Math.PI }; // same spot, turned around
ctx.currentTime = ++now;
field.update(0.016);
const lAfter = lastTarget(g0.earL.gain);
const rAfter = lastTarget(g0.earR.gain);
check('graph: after 180-degree turn the relation flips', lAfter > rAfter,
  `L=${lAfter.toFixed(5)} R=${rAfter.toFixed(5)}`);
check('graph: flip is symmetric (ear ratios swap)',
  Math.abs(lAfter / rAfter - rBefore / lBefore) < 1e-9,
  `before R/L=${(rBefore / lBefore).toFixed(4)} after L/R=${(lAfter / rAfter).toFixed(4)}`);

// ear split ratio matches the pure helper exactly (undulation scales both
// ears together, so it cancels in the ratio)
const expected = panWeights(pose.yaw, v0.x - pose.x, v0.z - pose.z);
check('graph: ear ratio equals panWeights solve',
  Math.abs(rAfter / lAfter - expected.right / expected.left) < 1e-9);

// ---- 3. world-fixing: translation never drags the voices --------------------
const anchorsBefore = field.voiceState().map((v) => `${v.wx},${v.wz}`).join(';');

// equal-distance reposition: same 10 m from voice 0, different bearing.
// A listener-relative (broken) field would produce IDENTICAL weights here;
// a world-fixed field must re-solve against the moved pose.
const posA = { x: v0.x, z: v0.z + 10, yaw: 0 };        // dead ahead, 10 m
const posB = { x: v0.x + 8, z: v0.z + 6, yaw: 0 };     // ahead-left, still 10 m
pose = posA;
ctx.currentTime = ++now;
field.update(0.016);
const stA = field.voiceState()[0];
pose = posB;
ctx.currentTime = ++now;
field.update(0.016);
const stB = field.voiceState()[0];

check('anchors: voice world anchors never move with the listener',
  field.voiceState().map((v) => `${v.wx},${v.wz}`).join(';') === anchorsBefore);
check('world-fixed: equal-distance translation keeps attenuation identical',
  Math.abs(stA.level - stB.level) < 1e-12,
  `${stA.level} vs ${stB.level}`);
check('world-fixed: equal-distance translation changes only the bearing split',
  stB.left !== stA.left && stB.left > stB.right,
  `A=${JSON.stringify({ l: stA.left, r: stA.right })} B=${JSON.stringify({ l: stB.left, r: stB.right })}`);
const expB = panWeights(posB.yaw, v0.x - posB.x, v0.z - posB.z);
check('world-fixed: post-move split solves from the UNMOVED world anchor',
  Math.abs(stB.left - expB.left) < 1e-12 && Math.abs(stB.right - expB.right) < 1e-12);

// distance attenuation: closing in raises the level per inverse-square
pose = { x: v0.x, z: v0.z + 3, yaw: 0 };
ctx.currentTime = ++now;
field.update(0.016);
const stNear = field.voiceState()[0];
check('distance: inside reference radius attenuates to unity',
  stNear.level === VOICE_LEVEL * whisperAttenuation(3) && whisperAttenuation(3) === 1);
check('distance: near level exceeds far level',
  stNear.level > stA.level * 4,
  `near=${stNear.level} far=${stA.level}`);
check('distance: far-field follows inverse square',
  Math.abs(whisperAttenuation(2 * WHISPER_REF_DIST) - 0.25) < 1e-12);

// ---- 4. lifecycle ------------------------------------------------------------
const targetsBefore = ctx.nodes.reduce((a, n) => a + n.gain.targets.length, 0);
field.update(0);     // ignored
field.update(-0.05); // ignored
check('update ignores non-positive dt',
  ctx.nodes.reduce((a, n) => a + n.gain.targets.length, 0) === targetsBefore);

field.stop();
check('stop silences the ears and stops the looping sources',
  ctx.nodes.filter((n) => n._kind === 'src' && n.loop)
    .every((s) => s._stops.length > 0) &&
  lastTarget(g0.earL.gain) === 0 && lastTarget(g0.earR.gain) === 0);
const stopsBefore = ctx.nodes.reduce((a, n) => a + n._stops.length, 0);
field.stop(); // double-stop safe
field.update(0.016);
check('stopped instance is inert',
  ctx.nodes.reduce((a, n) => a + n._stops.length, 0) === stopsBefore);

console.log(failures.length === 0
  ? '\nALL PASS'
  : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
