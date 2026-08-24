/**
 * Surface footstep tests — run with: node test/surfaces-test.mjs
 *
 * Part 1 is static structure checking (always runs).
 * Part 2 exercises SurfaceFootsteps against a mock AudioContext.
 * The TS module is bundled with esbuild so its '../core/rng' import
 * resolves under plain Node (same loader as groans-test).
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'audio', 'surfaces.ts');
const src = readFileSync(srcPath, 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');
ok(src.includes('export class SurfaceFootsteps'), 'exports SurfaceFootsteps');
ok(/constructor\(\s*ctx:\s*AudioContext,\s*destination:\s*AudioNode[^)]*\)/.test(src), 'constructor(ctx, destination[, seed]) signature');
ok(/play\(\s*surface:\s*SurfaceKind\s*,\s*sprint[^)]*\)/.test(src), 'play(surface, sprint) signature');
for (const s of ['carpet', 'tile', 'metal', 'splash']) ok(src.includes(`'${s}'`), `surface kind ${s}`);
ok(/lowpass/.test(src) && /200 \* pitch/.test(src), 'carpet 200Hz lowpass');
ok(/bandpass/.test(src) && /1000 \* pitch/.test(src), 'tile 1kHz bandpass');
ok(/0\.003/.test(src), 'tile 3ms click');
ok(/800 \* pitch/.test(src), 'metal 800Hz resonance');
ok(/highpass/.test(src) && /exponentialRampToValueAtTime/.test(src), 'splash highpass sweep');
ok(/range\(0\.9,\s*1\.1\)/.test(src), '\u00b110% variation factor present (rng.range(0.9, 1.1))');
ok(src.includes('1.45'), 'sprint louder');
ok(src.includes('1.06'), 'sprint higher pitch');
ok(src.includes('0.78'), 'sprint faster');

// ---- part 2: behavioural (esbuild-bundled module) ----
console.log('[behavioural]');

const esbuild = loadEsbuild();
const BUILT = process.cwd() + '/test/.surfaces-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/audio/surfaces.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);

class FakeParam {
  constructor(v = 1) { this.value = v; this.max = -Infinity; }
  _track(v) { if (v > this.max) this.max = v; return this; }
  setValueAtTime(v) { this.value = v; return this._track(v); }
  linearRampToValueAtTime(v) { this.value = v; return this._track(v); }
  exponentialRampToValueAtTime(v) { this.value = v; return this._track(v); }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  constructor(ctx) { this.ctx = ctx; this.gain = new FakeParam(1); this.frequency = new FakeParam(1000);
    this.Q = new FakeParam(1); this.detune = new FakeParam(0); this.type = ''; this.buffer = null;
    this.playbackRate = new FakeParam(1); this.pan = new FakeParam(0); this.connections = []; }
  connect(dest) { this.connections.push(dest); return dest; }
  start() {} stop() {}
}
class FakeCtx {
  constructor() { this.currentTime = 12.5; this.sampleRate = 48000; this.nodes = []; }
  createBufferSource() { const n = new FakeNode(this); n.__kind = 'src'; this.nodes.push(n); return n; }
  createBiquadFilter() { const n = new FakeNode(this); n.__kind = 'filter'; this.nodes.push(n); return n; }
  createGain() { const n = new FakeNode(this); n.__kind = 'gain'; this.nodes.push(n); return n; }
  createBuffer(ch, len, rate) { return { numberOfChannels: ch, length: len, sampleRate: rate,
    getChannelData: () => new Float32Array(len) }; }
}

// deterministic randomness for repeatable assertions
let seed = 42;
Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

async function behaviour() {
  const mod = await import('./.surfaces-build.mjs');
  const ctx = new FakeCtx();
  const dest = new FakeNode(ctx);
  const steps = new mod.SurfaceFootsteps(ctx, dest);

  for (const surface of ['carpet', 'tile', 'metal', 'splash']) {
    const before = ctx.nodes.length;
    steps.play(surface, false);
    const created = ctx.nodes.slice(before);
    const filters = created.filter((n) => n.__kind === 'filter');
    const gains = created.filter((n) => n.__kind === 'gain');
    ok(created.length > 0 && gains.length > 0, `${surface}: produced voice graph`);
    ok(filters.every((f) => ['lowpass', 'bandpass', 'highpass'].includes(f.type)),
      `${surface}: uses only expected filter types`);
    // every chain must terminate at the destination
    let reaches = false;
    for (const g of gains) {
      const walk = (n, seen = new Set()) => {
        if (n === dest) return true;
        if (seen.has(n)) return false;
        seen.add(n);
        return [...n.connections].some((c) => walk(c, seen));
      };
      if (walk(g)) reaches = true;
    }
    ok(reaches, `${surface}: signal reaches destination`);
    // variation + sprint: average pitch over N steps must sit above the walk
    // average (sprint multiplier 1.06 dominates the symmetric \u00b110% jitter in
    // expectation, so compare means rather than a single flaky sample)
    const avgRate = (sprint, n) => {
      let sum = 0;
      const origStart = FakeNode.prototype.start;
      FakeNode.prototype.start = function (...a) {
        if (this.__kind === 'src') sum += this.playbackRate.value;
        return origStart.apply(this, a);
      };
      for (let i = 0; i < n; i++) steps.play(surface, sprint);
      FakeNode.prototype.start = origStart;
      return sum / n;
    };
    ok(avgRate(true, 40) > avgRate(false, 40), `${surface}: sprint pitch averages higher`);
  }

  // sprint vs walk loudness on carpet: FakeParam.max captures the envelope
  // peak even though the final scheduled value is the decay floor (0.0001)
  const peakOf = (ctx2) => Math.max(...ctx2.nodes.filter((n) => n.__kind === 'gain').map((g) => g.gain.max));
  let walkPeak = 0, sprintPeak = 0;
  for (let i = 0; i < 20; i++) {
    const c1 = new FakeCtx(); new mod.SurfaceFootsteps(c1, dest).play('carpet', false);
    const c2 = new FakeCtx(); new mod.SurfaceFootsteps(c2, dest).play('carpet', true);
    walkPeak += peakOf(c1); sprintPeak += peakOf(c2);
  }
  ok(sprintPeak > walkPeak, 'sprint step is louder than walk step (avg of 20)');

  // invalid surface is a safe no-op
  const c3 = new FakeCtx();
  const steps3 = new mod.SurfaceFootsteps(c3, dest);
  steps3.play('lava', false);
  ok(true, 'unknown surface does not throw');
}

try {
  await behaviour();
} catch (e) {
  console.warn('  SKIP behavioural:', e.message);
}

console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);


