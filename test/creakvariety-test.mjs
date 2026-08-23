/*
 * Door creak character variety tests -- pure Node, no browser.
 * Drives CreakVariety against a minimal WebAudio mock and checks:
 *   1. seeded consistency: same seed -> identical personalities,
 *      different seed -> different doors
 *   2. each personality lands in its documented frequency band
 *   3. per-play micro-variation stays within +-10% pitch/duration
 *   4. distance attenuates volume and closes the lowpass
 *   5. graph shape: osc -> lowpass -> gain -> out
 *   6. metal rings, vault is slow and deep, screen rattles in bursts
 *   7. stop() silences everything and refuses further plays
 */
import { CreakVariety } from '../src/audio/creakvariety.ts';

// ---- minimal AudioContext mock -------------------------------------------
let now = 100;
class Param {
  constructor(v) {
    this.value = v; this.max = v;
    this.inputs = [];
    this.isParam = true;
  }
  setValueAtTime(v) { this.value = v; if (v > this.max) this.max = v; }
  linearRampToValueAtTime(v) { this.value = v; if (v > this.max) this.max = v; }
  exponentialRampToValueAtTime(v) { if (v > 0) { if (v > this.max) this.max = v; this.value = v; } }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx) {
    this.ctx = ctx; this.edges = []; this.inputs = [];
    this.gain = new Param(1); this.frequency = new Param(440);
    this.Q = new Param(1); this.type = '';
    this.stoppedCount = 0;
  }
  connect(dest) { this.edges.push(dest); if (!dest.isParam) dest.inputs.push(this); return dest; }
  start() {}
  stop() { this.stoppedCount++; }
}
class Ctx {
  constructor() {
    this.currentTime = now;
    this.nodes = [];
    this.destination = new Node(this); this.destination._kind = 'destination';
  }
  createOscillator() { const n = new Node(this); n._kind = 'oscillator'; this.nodes.push(n); return n; }
  createGain() { const n = new Node(this); n._kind = 'gain'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new Node(this); n._kind = 'filter'; this.nodes.push(n); return n; }
}

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (!cond) failures.push(name);
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Walk forward edges (Params excluded) looking for a node kind. */
function downstream(node, kind) {
  const seen = new Set();
  let queue = [...node.edges];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.isParam || seen.has(cur)) continue;
    seen.add(cur);
    if (cur._kind === kind) return cur;
    queue.push(...cur.edges);
  }
  return null;
}
function oscsSince(ctx, mark) { return ctx.nodes.slice(mark).filter((n) => n._kind === 'oscillator'); }

const EPS = 1e-6; // float slack for the +-10% window

// ---- 1: seeded consistency ------------------------------------------------
const seedA = new CreakVariety(new Ctx(), null, 4242);
const seedA2 = new CreakVariety(new Ctx(), null, 4242);
const seedB = new CreakVariety(new Ctx(), null, 9001);
const jsonA = JSON.stringify(seedA.personalities());
check('same seed -> byte-identical personality sets', jsonA === JSON.stringify(seedA2.personalities()));
check('repeated queries are stable', jsonA === JSON.stringify(seedA.personalities()));
check('default seed is deterministic too',
  JSON.stringify(new CreakVariety(new Ctx(), null).personalities())
    === JSON.stringify(new CreakVariety(new Ctx(), null).personalities()));
check('different seed builds different doors', jsonA !== JSON.stringify(seedB.personalities()));
for (const c of ['wooden', 'metal', 'vault', 'screen']) {
  const a = seedA.personalityOf(c), b = seedA2.personalityOf(c);
  check(c + ' params identical across same-seed instances', JSON.stringify(a) === JSON.stringify(b));
}

// ---- 2: documented frequency bands ----------------------------------------
const P = seedA.personalities();
check('wooden sweeps ~80 Hz', P.wooden.fLo >= 70 && P.wooden.fLo <= 90, String(P.wooden.fLo));
check('wooden up to ~140 Hz', P.wooden.fHi >= 126 && P.wooden.fHi <= 154, String(P.wooden.fHi));
check('metal starts ~200 Hz', P.metal.fLo >= 180 && P.metal.fLo <= 220, String(P.metal.fLo));
check('metal reaches ~350 Hz', P.metal.fHi >= 315 && P.metal.fHi <= 385, String(P.metal.fHi));
check('vault starts deep ~40 Hz', P.vault.fLo >= 33 && P.vault.fLo <= 47, String(P.vault.fLo));
check('vault tops out ~70 Hz', P.vault.fHi >= 60 && P.vault.fHi <= 80, String(P.vault.fHi));
check('vault takes its time', P.vault.dur >= 3, String(P.vault.dur));
check('screen rattles in several bursts', P.screen.bursts >= 5 && P.screen.gap > 0 && P.screen.gap < 0.15,
  JSON.stringify({ bursts: P.screen.bursts, gap: P.screen.gap }));

// ---- 5: graph shape + micro-variation window -------------------------------
{
  const ctx = new Ctx();
  const cv = new CreakVariety(ctx, ctx.destination, 77);
  cv.play('wooden', 2);
  const oscs = oscsSince(ctx, 0);
  const main = oscs.find((o) => o.type === 'sawtooth');
  check('wooden voice is a sawtooth', !!main);
  const lp = downstream(main, 'filter');
  const g = downstream(main, 'gain');
  check('graph is osc -> lowpass -> gain -> destination',
    lp?._kind === 'filter' && lp.type === 'lowpass' && g?._kind === 'gain'
      && g.edges.includes(ctx.destination),
    JSON.stringify({ lp: lp?.type, g: !!g }));

  // Micro-variation: every play within +-10% of the seeded parameters.
  const p = cv.personalityOf('wooden');
  const los = [], durs = [];
  for (let i = 0; i < 24; i++) {
    cv.play('wooden', 1);
    los.push(cv.lastVoice.fLo / p.fLo);
    durs.push(cv.lastVoice.dur / p.dur);
  }
  const inWindow = (arr) => arr.every((r) => r >= 1 - 0.1 - EPS && r <= 1 + 0.1 + EPS);
  check('pitch always within +-10% of personality', inWindow(los), JSON.stringify(los.slice(0, 5)));
  check('duration always within +-10% of personality', inWindow(durs), JSON.stringify(durs.slice(0, 5)));
  check('micro-variation actually varies', new Set(los.map((r) => r.toFixed(4))).size >= 3,
    String(new Set(los.map((r) => r.toFixed(4))).size));

  // Distance: quieter and duller far away.
  cv.play('wooden', 2);
  const near = { ...cv.lastVoice };
  cv.play('wooden', 40);
  const far = { ...cv.lastVoice };
  check('volume attenuates with distance', far.peak < near.peak * 0.05,
    far.peak + ' vs ' + near.peak);
  check('lowpass closes with distance', far.cutoff < near.cutoff * 0.9,
    far.cutoff + ' vs ' + near.cutoff);
  check('near field keeps most of the cutoff', near.cutoff > p.cutoff * 0.99
    && near.cutoff <= p.cutoff + EPS, near.cutoff + ' vs ' + p.cutoff);
  check('unity attenuation under 5 m', close(near.peak, p.peak, 1e-9), near.peak + ' vs ' + p.peak);
}

// ---- 6: personality-specific behaviour -------------------------------------
{
  // Metal rings: a sine tail above the sweep.
  const ctx = new Ctx();
  const cv = new CreakVariety(ctx, ctx.destination, 55);
  cv.play('metal', 1);
  const oscs = oscsSince(ctx, 0);
  check('metal schedules body + ring oscillators', oscs.length >= 2, String(oscs.length));
  check('ring tail is a sine partial', oscs.some((o) => o.type === 'sine'));
  const v = cv.lastVoice;
  check('metal sweep starts ~200 Hz (+-10%)', Math.abs(v.fLo / P.metal.fLo - 1) <= 0.1 + EPS, String(v.fLo));
  check('metal voice reports the ring tail in its length', v.dur > cv.personalityOf('metal').dur);

  // Vault: one deep slow grind.
  const ctx2 = new Ctx();
  const cv2 = new CreakVariety(ctx2, ctx2.destination, 66);
  cv2.play('vault', 3);
  check('vault is one deep voice', oscsSince(ctx2, 0).length === 1);
  check('vault lasts over 3 s', cv2.lastVoice.dur >= 3, String(cv2.lastVoice.dur));
  check('vault starts ~40 Hz (+-10%)', Math.abs(cv2.lastVoice.fLo / P.vault.fLo - 1) <= 0.1 + EPS);

  // Screen: fast rattle volley.
  const ctx3 = new Ctx();
  const cv3 = new CreakVariety(ctx3, ctx3.destination, 88);
  cv3.play('screen', 4);
  const rattle = oscsSince(ctx3, 0);
  const sp = cv3.personalityOf('screen');
  check('screen fires a volley of bursts', rattle.length >= 5 && rattle.length === sp.bursts,
    String(rattle.length) + ' vs ' + sp.bursts);
  check('whole rattle is quick (< 1.5 s)', cv3.lastVoice.dur < 1.5, String(cv3.lastVoice.dur));
}

// ---- 7: stop() silences and refuses ---------------------------------------
{
  const ctx = new Ctx();
  const cv = new CreakVariety(ctx, ctx.destination, 12);
  cv.play('wooden', 5);
  cv.play('metal', 5);
  cv.play('vault', 5);
  cv.play('screen', 5);
  const all = oscsSince(ctx, 0);
  check('all four characters scheduled voices', all.length >= 8, String(all.length));
  cv.stop();
  check('stop() halts every live source', all.every((n) => n.stoppedCount >= 1),
    String(all.filter((n) => n.stoppedCount === 0).length));
  const before = ctx.nodes.length;
  cv.play('wooden', 5);
  check('stopped instance refuses further plays', ctx.nodes.length === before);
}

console.log('\n=== CREAK VARIETY TEST ===');
if (failures.length === 0) console.log('PASS: all creak character variety checks green');
else { console.log('FAIL: ' + failures.length + ' check(s): ' + failures.join('; ')); process.exit(1); }


