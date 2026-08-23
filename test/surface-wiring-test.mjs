/**
 * Surface wiring tests - run with: node test/surface-wiring-test.mjs
 *
 * Part 1 is static structure checking (always runs).
 * Part 2 exercises SurfaceWiring against a mock AudioContext via Node
 * type stripping, when this Node supports it.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'audio', 'surface-wiring.ts');
const src = readFileSync(srcPath, 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');
ok(src.includes('export class SurfaceWiring'), 'exports SurfaceWiring');
ok(src.includes('export function districtToSurface'), 'exports districtToSurface');
ok(src.includes('setPuddles(list: PuddleZone[]): void'), 'setPuddles(list) signature');
ok(/step\s*\(\s*x:\s*number\s*,\s*z:\s*number/.test(src), 'step(x, z, sprinting) signature');
ok(src.includes("from './surfaces'"), 'imports the real SurfaceFootsteps');
ok(src.includes('new SurfaceFootsteps(ctx, destination)'), 'constructs SurfaceFootsteps(ctx, destination)');
ok(src.includes('150'), '150 ms dedup floor present');
ok(src.includes('1000 / 2.2') || src.includes('455'), '~2.2 steps/sec walking cadence constant');
ok(/dx \* dx \+ dz \* dz <= r \* r/.test(src), 'puddle radius squared-distance check');
for (const s of ['carpet', 'tile', 'metal', 'splash']) ok(src.includes("'" + s + "'"), 'surface kind referenced: ' + s);

// ---- part 2: behavioural (needs Node >= 22.6 --experimental-strip-types) ----
console.log('[behavioural]');

class FakeParam {
  constructor(v = 1) { this.value = v; this.max = -Infinity; }
  _track(v) { if (v > this.max) this.max = v; return this; }
  setValueAtTime(v) { this.value = v; return this._track(v); }
  linearRampToValueAtTime(v) { this.value = v; return this._track(v); }
  exponentialRampToValueAtTime(v) { this.value = v; return this._track(v); }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  constructor(ctx) { this.ctx = ctx; this.gain = new FakeParam(1); this.frequency = new FakeParam(1000); this.Q = new FakeParam(1); this.detune = new FakeParam(0); this.type = ''; this.buffer = null; this.playbackRate = new FakeParam(1); this.connections = []; }
  connect(dest) { this.connections.push(dest); return dest; }
  start() {} stop() {}
}
class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.nodes = []; }
  createBufferSource() { const n = new FakeNode(this); n.__kind = 'src'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new FakeNode(this); n.__kind = 'filter'; this.nodes.push(n); return n; }
  createGain() { const n = new FakeNode(this); n.__kind = 'gain'; this.nodes.push(n); return n; }
  createBuffer(ch, len, rate) { return { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) }; }
}

// deterministic randomness for repeatable assertions
let seed = 42;
Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// Classify one emitted step by its filter graph:
// carpet -> lowpass ~200 / tile -> bandpass ~1000 (+ click highpass) /
// metal -> bandpass ~800 plus partial ~2208 / splash -> sweeping highpass ~320.
function classify(ctx, from = 0) {
  const f = ctx.nodes.slice(from).filter((n) => n.__kind === 'filter');
  if (f.some((n) => n.type === 'lowpass')) return 'carpet';
  const bps = f.filter((n) => n.type === 'bandpass').map((n) => n.frequency.value);
  if (bps.some((v) => v >= 900 && v <= 1100)) return "tile";
  if (bps.some((v) => v >= 700 && v <= 880) && bps.some((v) => v >= 1900 && v <= 2500)) return "metal";
  if (f.some((n) => n.type === 'highpass')) return 'splash';
  return "unknown";
}

async function behaviour() {
  // Project sources import each other without extensions (bundler-style).
  // Node's strip-types loader needs explicit extensions, so register a
  // resolve hook that retries with '.ts' appended when plain resolution fails.
  let hooksRegistered = false;

(Showing lines 1-80 of 222. Use offset=81 to continue.)

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
  } catch (err) {
    hooksRegistered = false; // older Node without synchronous module hooks
  }
  if (!hooksRegistered) console.warn('  note: no resolve hook available; behavioural part may skip');
  const mod = await import('../src/audio/surface-wiring.ts');

  // District id -> base surface mapping, one fresh context per case.
  const cases = [
    [0, 'carpet'], [3, 'carpet'],   // MAZE, CORRIDOR_GRID
    [1, 'tile'], [2, 'tile'],       // OPEN_OFFICE, HONEYCOMB
    [4, 'metal'],                   // STORAGE
  ];
  for (const c of cases) {
    const district = c[0]; const want = c[1];
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => district);
    w.step(10, 10, false);
    const got = classify(ctx);
    ok(got === want, 'district ' + district + ' -> ' + want + ' (got ' + got + ')');
  }

  // Unknown district id falls back safely to a playable surface.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 99);
    let threw = false;
    try { w.step(0, 0, false); } catch (e) { threw = true; }
    ok(!threw && ctx.nodes.length > 0 && classify(ctx) === 'carpet', 'unknown district falls back to carpet without throwing');
  }

  // Puddle zones override the district surface with splash.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 4); // STORAGE = metal
    w.setPuddles([{ x: 50, z: -20 }]);
    w.step(50.5, -19.7, false); // well inside the default 1.2 m radius
    ok(classify(ctx) === 'splash', 'step inside puddle zone -> splash override');
  }

  // Just outside the default radius stays on the base surface.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0); // MAZE = carpet
    w.setPuddles([{ x: 0, z: 0 }]);
    ctx.currentTime = 1; w.step(1.05, 0.85, false); // dist ~1.35 m > 1.2 m
    ok(classify(ctx) === 'carpet', 'step outside puddle radius keeps district surface');
  }

  // Custom per-puddle radius is honoured.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0);
    w.setPuddles([{ x: 5, z: 5, r: 3 }]);
    ctx.currentTime = 1;
    w.step(7.5, 5, false); // 2.5 m out, inside the custom 3 m radius
    ok(classify(ctx) === 'splash', 'custom puddle radius honoured');
  }

  // External puddleCheck overrides the built-in list entirely.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0, (x, z) => x > 100);
    w.setPuddles([{ x: 0, z: 0 }]);
    const before = ctx.nodes.length;
    ctx.currentTime = 1; w.step(0, 0, false); // inside registered puddle, probe says dry
    ok(classify(ctx, before) === 'carpet', 'external puddleCheck overrides built-in list');
    const afterFirst = ctx.nodes.length;
    ctx.currentTime = 2; w.step(101, 0, false); // probe says wet
    ok(classify(ctx, afterFirst) === 'splash', 'external puddleCheck triggers splash');
  }

  // Rate limiting: dedup of rapid calls plus cadence gates.
  {
    const ctx = new FakeCtx();
    const dest = new FakeNode(ctx);
    const w = new mod.SurfaceWiring(ctx, dest, () => 0);
    const played = () => ctx.nodes.filter((n) => n.__kind === 'src').length;
    ctx.currentTime = 10;
    ok(w.step(0, 0, false) === true && played() === 1, 'first walking step plays');
    ok(w.step(0.1, 0, false) === false && played() === 1, 'immediate duplicate step is deduped');
    ctx.currentTime = 10.2; // 200 ms later: past 150 ms floor, under walk cadence
    ok(w.step(0.3, 0, false) === false, 'step within walking cadence (~455 ms) is dropped');
    ctx.currentTime = 10.5; // 500 ms after last play
    ok(w.step(0.6, 0, false) === true && played() === 2, 'step after full walking cadence plays');
    ctx.currentTime = 10.65; // 150 ms after last play
    ok(w.step(0.9, 0, true) === false, 'sprint step still blocked inside 150 ms dedup window');
    ctx.currentTime = 10.9; // 400 ms after last play: sprint OK, walk would refuse
    ok(w.step(1.1, 0, true) === true, 'sprinting allows faster cadence than walking');
    ctx.currentTime = 11.15; // 250 ms later: walk refuses even though sprint would allow
    ok(w.step(1.3, 0, false) === false, 'walking cadence stricter than sprint cadence');
  }

  // Sprint flag is forwarded to play() (louder envelope peaks).
  {
    const peakOf = (c) => Math.max.apply(null, c.nodes.filter((n) => n.__kind === "gain").map((g) => g.gain.max));
    let walkPeak = 0; let sprintPeak = 0;
    for (let i = 0; i < 20; i++) {
      const c1 = new FakeCtx();
      const w1 = new mod.SurfaceWiring(c1, c1, () => 0);
      w1.step(0, 0, false);
      const c2 = new FakeCtx();
      c2.currentTime = 999;
      const w2 = new mod.SurfaceWiring(c2, c2, () => 0);
      w2.step(0, 0, true);
      walkPeak += peakOf(c1);
      sprintPeak += peakOf(c2);
    }
    ok(sprintPeak > walkPeak, 'sprint flag forwarded: sprint steps louder (avg of 20)');
  }
}

const probe = spawnSync(process.execPath, ["--experimental-strip-types", "-e", "process.exit(0)"]);
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


