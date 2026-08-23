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


