/**
 * Wiring test — entity vocals consumer mount:
 *   src/entities/vocals.ts   run-seeded slot identity + bearing pan
 *   src/core/game.ts         spatialBus island + frame pump feed
 * Standalone (no browser): transpiles the module into a temp dir and drives
 * it against a fake AudioContext, mirroring test/floorcrack-fold-test.mjs
 * scaffolding plus the fake-graph style of test/vocals-test.mjs.
 * Run: node test/entityvocals-wiring-test.mjs
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

// ---- scaffold ---------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-entityvocals-'));
fs.mkdirSync(path.join(tmp, 'entities'), { recursive: true });

function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/entities/vocals.ts', 'entities/vocals.mjs');

const mod = await import(pathToFileURL(path.join(tmp, 'entities', 'vocals.mjs')).href);

// ---- fake WebAudio graph ----------------------------------------------------

class FakeParam {
  constructor(v = 1) { this.value = v; this.calls = []; }
  setValueAtTime(v) { this.value = v; this.calls.push(['setValueAtTime', v]); return this; }
  linearRampToValueAtTime(v) { this.value = v; this.calls.push(['linearRampToValueAtTime', v]); return this; }
  exponentialRampToValueAtTime(v) { this.value = v; this.calls.push(['exponentialRampToValueAtTime', v]); return this; }
  setTargetAtTime(v) { this.calls.push(['setTargetAtTime', v]); return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.gain = new FakeParam(1); this.frequency = new FakeParam(1000);
    this.Q = new FakeParam(1); this.detune = new FakeParam(0); this.type = '';
    this.pan = new FakeParam(0); this.connections = []; this.stopped = false;
  }
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

// ---- 1. seeded slot identity ----------------------------------------------

{
  const legacy = new mod.EntityVocals(new FakeCtx(), new FakeNode());
  const zero = new mod.EntityVocals(new FakeCtx(), new FakeNode(), 0);
  check('seed=0 reproduces legacy hardcoded slot identity',
    legacy.mutters[0].osc.frequency.value === zero.mutters[0].osc.frequency.value &&
    legacy.hums[0].osc.frequency.value === zero.hums[0].osc.frequency.value);

  let differ = false;
  for (const s of [1, 42, 0x5eed1234, 99991]) {
    const v = new mod.EntityVocals(new FakeCtx(), new FakeNode(), s);
    if (v.mutters[0].osc.frequency.value !== legacy.mutters[0].osc.frequency.value ||
        v.hums[0].osc.frequency.value !== legacy.hums[0].osc.frequency.value) differ = true;
  }
  check('non-zero run seeds change voice identity', differ);
  check('same run seed replays identical voices',
    (() => {
      const a = new mod.EntityVocals(new FakeCtx(), new FakeNode(), 777);
      const b = new mod.EntityVocals(new FakeCtx(), new FakeNode(), 777);
      return a.mutters[0].osc.frequency.value === b.mutters[0].osc.frequency.value &&
             a.hums[1].osc.frequency.value === b.hums[1].osc.frequency.value;
    })());
}

// ---- 2. burst firing + pan propagation -------------------------------------

{
  const ctx = new FakeCtx();
  const v = new mod.EntityVocals(ctx, new FakeNode(), 31337);
  const m = v.mutters[0];
  m.nextIn = 0;
  let fired = false;
  for (let i = 0; i < 200 && !fired; i++) {
    fired = v.update(0.25, [{ type: 'believer', dist: 3, pan: -0.8 }]);
  }
  check('close believer mutters within its 20-40s cadence window', fired);
  check('bearing pan is retargeted onto the panner',
    m.pan.pan.calls.some(([k, val]) => k === 'setTargetAtTime' && Math.abs(val - (-0.8)) < 1e-9),
    JSON.stringify(m.pan.pan.calls.slice(0, 3)));
  v.stop();
}

{
  // no pan supplied -> static legacy pan, zero retargets
  const ctx = new FakeCtx();
  const v = new mod.EntityVocals(ctx, new FakeNode());
  const m = v.mutters[0];
  m.nextIn = 0;
  for (let i = 0; i < 200; i++) v.update(0.25, [{ type: 'believer', dist: 4 }]);
  check('legacy call shape performs no pan retargets', m.pan.pan.calls.length === 0,
    JSON.stringify(m.pan.pan.calls.slice(0, 3)));
  // junk pan -> ignored, no throw
  let threw = false;
  try { v.update(0.25, [{ type: 'believer', dist: 4, pan: Number.NaN }]); } catch { threw = true; }
  check('NaN pan is a safe no-op', !threw);
  v.stop();
}

// ---- 3. range gates still hold ----------------------------------------------

{
  const ctx = new FakeCtx();
  const v = new mod.EntityVocals(ctx, new FakeNode());
  for (const voice of [...v.mutters, ...v.hums]) voice.nextIn = 0;
  let fired = false;
  for (let i = 0; i < 200; i++) {
    if (v.update(0.25, [
      { type: 'believer', dist: mod.BELIEVER_RANGE + 0.01 },
      { type: 'wanderer', dist: mod.WANDERER_RANGE + 0.01 },
      { type: 'watcher', dist: 0.5, pan: 0.9 },
    ])) fired = true;
  }
  check('out-of-range figures (and watchers) stay silent', !fired);
  check('distance gates remain fully closed',
    [...v.mutters, ...v.hums].every((voice) => voice.distGain.gain.value === 0));
  v.stop();
}

// ---- 4. wanderer pan symmetry -----------------------------------------------

{
  const ctx = new FakeCtx();
  const v = new mod.EntityVocals(ctx, new FakeNode(), 555);
  const h = v.hums[0];
  h.nextIn = 0;
  let fired = false;
  for (let i = 0; i < 200 && !fired; i++) {
    fired = v.update(0.25, [{ type: 'wanderer', dist: 2, pan: 1 }]);
  }
  check('close wanderer hums within its 30-60s cadence window', fired);
  check('hard-right bearing reaches the hum panner',
    h.pan.pan.calls.some(([, val]) => Math.abs(val - 1) < 1e-9),
    JSON.stringify(h.pan.pan.calls.slice(0, 3)));
  v.stop();
}

// ---- 5. wiring greps on game.ts ---------------------------------------------

{
  const g = fs.readFileSync(path.join(ROOT, 'src', 'core', 'game.ts'), 'utf8');
  check("game.ts imports EntityVocals", /import \{ EntityVocals \} from '\.\.\/entities\/vocals'/.test(g));
  check("construction rides the spatial authority bus",
    /new EntityVocals\(ctx,\s*spatialBus,/.test(g),
    'expected new EntityVocals(ctx, spatialBus, ...)');
  check("construction is run-seeded", /EntityVocals\(ctx,\s*spatialBus,\s*\(this\.seed \^ /.test(g));
  check("construction sits in a failure island",
    /\[bmb\] EntityVocals unavailable/.test(g));
  check("frame pump feeds the proximity snapshot", /entityVocals\.update\(dt,/.test(g));
  check("frame pump derives a bearing pan", /entityVocals[\s\S]{0,900}lateral/.test(g));
  check("frame pump is failure-guarded", /\[bmb\] entity vocals failed/.test(g));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
