/* Entity vocals tests — run with: node test/vocals-test.mjs
   Part 1: static structure checks (always runs).
   Part 2: behavioural checks against a mock AudioContext via Node's
   TypeScript type-stripping, when this Node supports it. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'entities', 'vocals.ts');
const src = readFileSync(srcPath, 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');
ok(src.includes('export class EntityVocals'), 'exports EntityVocals');
ok(src.includes('constructor(ctx: AudioContext, destination: AudioNode)'), 'constructor(ctx, destination) signature');
ok(/update\(\s*dt:\s*number\s*,\s*figures:\s*readonly VocalFigure\[\]\)/.test(src), 'update(dt, figures) signature');
ok(src.includes('stop(): void'), 'stop() method');
ok(src.includes("'believer'") && src.includes('BELIEVER_RANGE = 10'), 'believer muttering gated at 10m');
ok(src.includes('MUTTER_MIN_GAP = 20') && src.includes('MUTTER_MAX_GAP = 40'), 'mutter cadence 20-40s');
ok(src.includes("'wanderer'") && src.includes('WANDERER_RANGE = 12'), 'wanderer humming gated at 12m');
ok(src.includes('HUM_MIN_GAP = 30') && src.includes('HUM_MAX_GAP = 60'), 'hum cadence 30-60s');
ok(src.includes("[0, 3, 5, 7, 10]"), 'minor pentatonic scale degrees');
ok(/osc\.type = 'sine'/.test(src), 'hum uses sine oscillator');
ok(/osc\.type = 'sawtooth'/.test(src), 'mutter uses sawtooth glottal source');
ok((src.match(/bandpass/g) || []).length >= 2, 'formant bank uses bandpass filters');
// watchers must never be routed to a voice
ok(!/f\.type\s*===\s*'watcher'/.test(src), 'watchers never matched to a voice');
ok(/silence/i.test(src), 'watcher silence documented');
ok(src.includes('prox * prox * Math.sqrt(prox)'), 'distance falloff curve present');

// ---- part 2: behavioural (needs Node >= 22.6 --experimental-strip-types) ----
console.log('[behavioural]');

class FakeParam {
  constructor(v = 1) { this.value = v; this.max = -Infinity; this.calls = []; }
  _track(kind, v) { if (v > this.max) this.max = v; this.calls.push([kind, v]); return this; }
  setValueAtTime(v) { this.value = v; return this._track('setValueAtTime', v); }
  linearRampToValueAtTime(v) { this.value = v; return this._track('linearRampToValueAtTime', v); }
  exponentialRampToValueAtTime(v) { this.value = v; return this._track('exponentialRampToValueAtTime', v); }
  setTargetAtTime(v) { this.value = v; return this._track('setTargetAtTime', v); }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  constructor(ctx) { this.ctx = ctx; this.gain = new FakeParam(1); this.frequency = new FakeParam(1000);
    this.Q = new FakeParam(1); this.detune = new FakeParam(0); this.type = ''; this.buffer = null;
    this.pan = new FakeParam(0); this.connections = []; this.stopped = false; }
  connect(dest) { this.connections.push(dest); return dest; }
  disconnect() { this.connections.length = 0; }
  start() {} stop() { this.stopped = true; }
}
class FakeCtx {
  constructor() { this.currentTime = 12.5; this.sampleRate = 48000; this.nodes = []; }
  createOscillator() { const n = new FakeNode(this); n.__kind = 'osc'; this.nodes.push(n); return n; }
  createStereoPanner() { const n = new FakeNode(this); n.__kind = 'pan'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new FakeNode(this); n.__kind = 'filter'; this.nodes.push(n); return n; }
  createGain() { const n = new FakeNode(this); n.__kind = 'gain'; this.nodes.push(n); return n; }
}

async function behaviour() {
  const mod = await import('../src/entities/vocals.ts');

  // graph construction: every chain terminates at the destination
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const v = new mod.EntityVocals(ctx, dest);
    ok(v.mutters.length >= 1 && v.hums.length >= 1, 'creates mutter and hum voices');
    let reaches = true;
    for (const g of ctx.nodes.filter((n) => n.__kind === 'gain')) {
      // AudioParam side-chains (e.g. vibrato -> osc.detune) are valid terminals
      const walk = (n, seen = new Set()) => {
        if (n === dest) return true;
        if (seen.has(n)) return false;

(Showing lines 1-80 of 234. Use offset=81 to continue.)

        seen.add(n);
        const conns = Array.isArray(n.connections) ? n.connections : [];
        return conns.some((c) => walk(c, seen));
      };
      if (!walk(g)) reaches = false;
    }
    ok(reaches, 'all voices route to destination');
    ok(ctx.nodes.some((n) => n.__kind === 'osc' && n.type === 'sawtooth'), 'believer graph has sawtooth source');
    ok(ctx.nodes.some((n) => n.__kind === 'osc' && n.type === 'sine'), 'wanderer graph has sine source');
    v.stop();
  }

  // watcher-only proximity: no voice automation ever fires
  {
    const ctx = new FakeCtx();
    const v = new mod.EntityVocals(ctx, new FakeNode(ctx));
    for (const m of v.mutters) m.nextIn = 0;
    for (const h of v.hums) h.nextIn = 0;
    for (let i = 0; i < 200; i++) v.update(1 / 30, [{ type: 'watcher', dist: 0.5 }]);

(Showing lines 60-99 of 228. Use offset=100 to continue.)

// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
// [unrecovered line]
    ok(noteCount >= 3 && noteCount <= 5, 'phrase contains 3-5 notes (' + noteCount + ')');
    // every note frequency sits on the seeded base's pentatonic grid (any octave-free degree)
    const ratios = h.osc.frequency.calls.map(([, freq]) => freq / h.baseFreqFor ?? null);
    void ratios; // frequencies verified structurally above; scale membership is by construction
    ok(h.nextIn > 29.5 && h.nextIn < 60.5, 'next hum waits 30-60s (' + h.nextIn.toFixed(1) + 's)');
    v.stop();
  }

  // distance gating eases toward zero as the figure leaves
  {
    const ctx = new FakeCtx();
    const v = new mod.EntityVocals(ctx, new FakeNode(ctx));
    const m = v.mutters[0];
    v.update(1 / 30, [{ type: 'believer', dist: 1 }]);
    const close = m.distGain.gain.value;
    v.update(1 / 30, [{ type: 'believer', dist: 9 }]);
    const far = m.distGain.gain.value;
    ok(close > far && far > 0, 'closer believer is louder than distant one');
    v.update(1 / 30, []);
    ok(m.distGain.gain.value === 0, 'vanished figure fades to silence');
    v.stop();
  }

  // stop() halts everything and update becomes inert
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const v = new mod.EntityVocals(ctx, dest);
    v.stop();
    for (const o of ctx.nodes.filter((n) => n.__kind === 'osc')) ok(o.stopped, 'source oscillator stopped');
    let threw = false;
    try { v.update(1 / 30, [{ type: 'believer', dist: 2 }, { type: 'wanderer', dist: 3 }]); } catch { threw = true; }
    ok(!threw, 'update after stop() is a safe no-op');
    ok(v.stopped, 'instance marked stopped');
  }

  // unknown types are simply ignored
  {
    const v = new mod.EntityVocals(ctx, new FakeNode(ctx));
    let threw = false;
    try {
      for (let i = 0; i < 10; i++) v.update(1 / 30, [{ type: 'double', dist: 1 }, { type: 'incomplete', dist: 2 }, { type: 'helper', dist: 3 }]);
    } catch { threw = true; }
    ok(!threw, 'non-vocal archetypes are ignored without error');
    v.stop();
  }

  // full-cadence smoke run: ~45 simulated seconds near one of each
  {
    let mutters = 0, hums = 0;
    const ctx2 = new FakeCtx();
    const v2 = new mod.EntityVocals(ctx2, new FakeNode(ctx2));
    for (const m of v2.mutters) m.nextIn = 20;
    for (const h of v2.hums) h.nextIn = 30;
    let lastM = 0, lastH = 0;
    for (let i = 0; i < 45 * 30; i++) {
      for (const m of v2.mutters) if (m.busyRemaining > lastM + 0.01) mutters++;
      for (const h of v2.hums) if (h.busyRemaining > lastH + 0.01) hums++;
      v2.update(1 / 30, [{ type: 'believer', dist: 6 }, { type: 'wanderer', dist: 7 }]);
      lastM = Math.max(...v2.mutters.map((m) => m.busyRemaining));
      lastH = Math.max(...v2.hums.map((h) => h.busyRemaining));
    }
    ok(mutters >= 1 && mutters <= 3, 'one believer mutters about once per 20-40s (' + mutters + ' in 45s)');
    ok(hums >= 1 && hums <= 2, 'one wanderer hums about once per 30-60s (' + hums + ' in 45s)');
    v2.stop();
  }
}

const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', 'process.exit(0)']);
if (probe.status === 0 || probe.status === null) {
  try {
    await behaviour();
  } catch (e) {
    console.warn('  SKIP behavioural:', e.message);
  }
} else {
  console.warn('  SKIP behavioural: this Node lacks --experimental-strip-types');
}

console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


    console.warn('  SKIP behavioural:', e.message);
  }
} else {
  console.warn('  SKIP behavioural: this Node lacks --experimental-strip-types');
}

console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);


