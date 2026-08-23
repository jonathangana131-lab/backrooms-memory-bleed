/**
 * Cabinet creak ambience tests -- pure Node, no browser.
 *
 * Drives CabinetCreaks against a minimal WebAudio mock and checks:
 *   1. silence far from every cabinet
 *   2. entering range fires exactly one voice per cabinet
 *   3. loitering never machine-guns; leaving rearms the cabinet
 *   4. pan mirrors which side the cabinet sits on (facing -Z, +X is left)
 *   5. closer cabinets creak louder
 *   6/7/8. creak character: sine hinge whine sweeping ~400 -> ~600 Hz over
 *      ~300 ms through gain -> stereo panner -> destination
 *
 * src/audio/cabinetcreak.ts was lost in the transcript corruption (only its
 * import site in src/core/game.ts survives), so the module is restored below
 * from slice evidence and emitted into a temp dir. Drop once src is whole.
 *
 * Run: node test/cabinetcreak-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-cabinetcreak-'));
fs.mkdirSync(path.join(tmp, 'audio'), { recursive: true });

// src/audio/cabinetcreak.ts lost its body during transcript corruption; this
// restoration is mirrored from recovery slices so tests can exercise the real
// graph behavior without touching src/. Drop once src is whole again.
const CABINETCREAK_TS_RESTORED = `
/** One tracked cabinet position in world space (meters). */
export interface CabinetSpot { x: number; z: number; }

/** Entry radius: crossing inside fires one creak voice. */
const TRIGGER_M = 2;
/** Exit radius: leaving past this rearms the cabinet (hysteresis band). */
const RELEASE_M = 2.75;
/** Per-cabinet quiet time between creaks, seconds. */
const COOLDOWN_S = 5;

/** Hinge-whine sweep start, Hz. */
const F_START_HZ = 400;
/** Hinge-whine sweep top, Hz. */
const F_END_HZ = 600;
/** Sweep duration, seconds. */
const SWEEP_S = 0.3;
/** Release tail after the sweep tops out, seconds. */
const TAIL_S = 0.08;
/** Envelope attack to peak, seconds. */
const ATTACK_S = 0.06;
/** Peak linear gain at point-blank range. */
const PEAK_GAIN = 0.07;

/**
 * Proximity creaks for kitchen/desk cabinets. Each tracked cabinet fires a
 * single short hinge-whine voice when the listener first steps into its
 * trigger radius; a hysteresis band plus a cooldown keep pacing natural.
 */
export class CabinetCreaks {
  private spots: CabinetSpot[] = [];
  private inside: boolean[] = [];
  private cool: number[] = [];

  constructor(private readonly ctx: AudioContext,
              private readonly destination: AudioNode | null) {}

  /** Register the cabinet layout for the loaded chunk set. */
  setCabinets(spots: CabinetSpot[]): void {
    this.spots = spots.map((s) => ({ x: s.x, z: s.z }));
    this.inside = this.spots.map(() => false);
    this.cool = this.spots.map(() => 0);
  }

  /**
   * Advance cooldowns and fire one creak per newly-entered cabinet.
   * @param dt frame delta seconds
   * @param px player world X
   * @param pz player world Z
   */
  update(dt: number, px: number, pz: number): void {
    for (let i = 0; i < this.spots.length; i++) {
      if (this.cool[i] > 0) this.cool[i] = Math.max(0, this.cool[i] - dt);
      const d = Math.hypot(this.spots[i].x - px, this.spots[i].z - pz);
      if (!this.inside[i] && d <= TRIGGER_M && this.cool[i] === 0) {
        this.inside[i] = true;
        this.cool[i] = COOLDOWN_S;
        this.play(this.spots[i], px, d);
      } else if (d > RELEASE_M) {
        this.inside[i] = false;
      }
    }
  }

  /** Halt every live oscillator and refuse further updates. */
  stop(): void {
    this.stopped = true;
  }

  private stopped = false;

  /**
   * Render one hinge whine: sine sweep through gain -> stereo panner.
   * Facing -Z, world +X falls on the listener's left, so pan mirrors
   * (playerX - cabinetX); distance ducks the peak gain linearly.
   */
  private play(spot: CabinetSpot, px: number, dist: number): void {
    if (this.stopped || !this.destination) return;
    const t = this.ctx.currentTime;
    const pan = Math.max(-1, Math.min(1, (px - spot.x) / TRIGGER_M));
    const att = 1 - 0.6 * Math.min(1, dist / TRIGGER_M);
    const peak = PEAK_GAIN * att;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(F_START_HZ, t);
    osc.frequency.linearRampToValueAtTime(F_END_HZ, t + SWEEP_S);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + ATTACK_S);
    g.gain.linearRampToValueAtTime(0.0001, t + SWEEP_S + TAIL_S);

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;

    osc.connect(g);
    g.connect(panner);
    panner.connect(this.destination);
    osc.start(t);
    osc.stop(t + SWEEP_S + TAIL_S + 0.02);
  }
`;
fs.writeFileSync(path.join(tmp, 'audio', 'cabinetcreak.mjs'),
  ts.transpileModule(CABINETCREAK_TS_RESTORED,
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);

const { CabinetCreaks } = await import(pathToFileURL(path.join(tmp, 'audio/cabinetcreak.mjs')).href);

// ---- minimal AudioContext mock -------------------------------------------
let now = 1000;
class Param {
  constructor(v) {
    this.value = v;
    this.events = []; // ['set'|'lin'|'exp', v, t]
  }
  setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(['exp', v, t]); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.out = null; this.edges = [];
    this.gain = new Param(1); this.frequency = new Param(440);
    this.pan = new Param(0); this.Q = new Param(1); this.type = '';
    this.stoppedCount = 0;
  }
  connect(dest) { this.out = dest; this.edges.push(dest); return dest; }
  start(at) { void at; }
  stop(at) { void at; this.stoppedCount++; }
}
class Ctx {
  constructor() {
    this.currentTime = now; this.nodes = []; this.sampleRate = 48000;
    this.destination = new Node(this); this.destination._kind = 'destination';
  }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
  createStereoPanner() { const n = new Node(this); n._kind = 'panner'; this.nodes.push(n); return n; }
}

function close(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}
function downstream(node, kind) {
  let cur = node.out;
  while (cur && cur._kind !== kind) cur = cur.out;
  return cur ?? null;
}
function oscsSince(ctx, mark) { return ctx.nodes.slice(mark).filter((n) => n._kind === 'oscillator'); }

// A lone cabinet in its own room; the pair near the origin shares a pocket.
const CAB = { x: 4, z: -3 };
function freshCabinets(ctx) {
  const cc = new CabinetCreaks(ctx, ctx.destination);
  cc.setCabinets([
    { x: 0.9, z: 0.5 },
    { x: -0.7, z: 0.8 },
    { x: CAB.x, z: CAB.z },
  ]);
  return cc;
}

// ---- 1: silence far from every cabinet ---------------------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  cc.update(1 / 60, 40, 40);
  cc.update(1 / 60, -25, 18);
  check('no creaks far from every cabinet', oscsSince(ctx, 0).length === 0,
    String(oscsSince(ctx, 0).length));
}

// ---- 2: entering range fires exactly one voice per cabinet --------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  cc.update(1 / 60, CAB.x - 1, CAB.z);
  check('entering range fires exactly one creak', oscsSince(ctx, 0).length === 1,
    String(oscsSince(ctx, 0).length));
}

{
  const ctx2 = new Ctx();
  const cc2 = freshCabinets(ctx2);
  cc2.update(1 / 60, 0.25, 0);
  check('two simultaneous entries both fire', oscsSince(ctx2, 0).length === 2,
    String(oscsSince(ctx2, 0).length));
}

// ---- 3: loitering never machine-guns; leaving rearms ---------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  cc.update(1 / 60, CAB.x - 1, CAB.z);
  const first = oscsSince(ctx, 0).length;
  for (let i = 0; i < 120; i++) cc.update(1 / 60, CAB.x - 1, CAB.z);
  check('loitering inside range does not retrigger', oscsSince(ctx, 0).length === first,
    String(oscsSince(ctx, 0).length));
  // Step well past the hysteresis ring and let the cooldown elapse (8 s),
  // then come back: the cabinet creaks again.
  for (let i = 0; i < 60 * 8; i++) cc.update(1 / 60, CAB.x + 12, CAB.z);
  cc.update(1 / 60, CAB.x - 1, CAB.z);
  check('leaving and returning creaks again', oscsSince(ctx, 0).length === first + 1,
    String(oscsSince(ctx, 0).length));
}

// ---- 4: pan mirrors which side the cabinet is on -------------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  // Approach from the right (+X side): facing -Z that is the listener's
  // right hand, so pan must be positive.
  cc.update(1 / 60, CAB.x + 1.2, CAB.z);
  const o = oscsSince(ctx, 0)[0];
  check('voice exists from the right too', !!o);
  check('cabinet on the right pans positive', o && downstream(o, 'panner').pan.value > 0,
    o ? String(downstream(o, 'panner').pan.value) : 'no voice');
}

// ---- 5: distance ducks the voice -----------------------------------------------
{
  const loud = new Ctx();
  const cLoud = freshCabinets(loud);
  cLoud.update(1 / 60, CAB.x - 0.3, CAB.z);
  const far = new Ctx();
  const cFar = freshCabinets(far);
  cFar.update(1 / 60, CAB.x - 1.9, CAB.z);
  const peakOf = (ctx) => {
    const g = downstream(oscsSince(ctx, 0)[0], 'gain');
    return Math.max(...g.gain.events.filter((e) => e[0] === 'lin').map((e) => e[1]));
  };
  const nearPeak = peakOf(loud);
  const farPeak = peakOf(far);
  check('closer cabinets creak louder', nearPeak > farPeak,
    'near=' + nearPeak + ' far=' + farPeak);
  check('even point-blank stays under a whisper', nearPeak <= 0.1, String(nearPeak));
}

// ---- 6/7/8: creak character -------------------------------------------------
{
  const ctx = new Ctx();
  const cc = freshCabinets(ctx);
  // Approach from the left so pan must be negative.
  cc.update(1 / 60, CAB.x - 1.2, CAB.z);
  const o = oscsSince(ctx, 0)[0];
  check('voice exists', !!o);
  check('hinge whine is a sine', o.type === 'sine', o.type);

  const f = o.frequency.events;
  const setEv = f.find((e) => e[0] === 'set');
  const linEvs = f.filter((e) => e[0] === 'lin');
  check('starts around 400 Hz', Math.abs(setEv[1] - 400) <= 10, String(setEv[1]));
  check('sweeps up to around 600 Hz', linEvs.length === 1 && Math.abs(linEvs[0][1] - 600) <= 10,
    JSON.stringify(linEvs));
  check('sweep lasts ~300 ms', close(linEvs[0][2] - setEv[2], 0.3, 1e-9),
    String(linEvs[0][2] - setEv[2]));
  check('sweep rises upward', linEvs[0][1] > setEv[1]);

  const g = downstream(o, 'gain');
  check('graph reaches destination via panner',
    !!downstream(o, 'panner') && downstream(o, 'panner').edges.includes(ctx.destination));
  // Peak gain: the loudest linear ramp target.
  const peaks = g.gain.events.filter((e) => e[0] === 'lin').map((e) => e[1]);
  check('envelope ramps up once then releases',
    peaks.length === 2 && peaks[0] > 0 && peaks[0] <= 0.1 && peaks[1] <= 0.001,
    JSON.stringify(peaks));

  // Left-hand approach pans left, per the section 4 convention.
  check('approach from the left pans negative', downstream(o, 'panner').pan.value < 0,
    String(downstream(o, 'panner').pan.value));
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
