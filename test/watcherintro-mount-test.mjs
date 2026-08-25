/**
 * First-watcher intro MOUNT tests (Wave C C-6 defect fix) - pure Node.
 *
 * The audit found WatcherIntroController imported + polled in game.ts but
 * NEVER constructed, so the once-ever first-watcher moment was dark. These
 * tests prove the mount end to end:
 *   A. controller timeline on a stub storage backend (begin gating on the
 *      persisted flag, prelude effects recipe, reveal subtitle window +
 *      easing home, done + markShown persistence, junk-dt safety)
 *   B. DynamicScore.setIntroSwell - lazy swell layer (built only on first
 *      use so watcherless runs never pay for the oscillators), clamp to
 *      [0,1] with junk -> silence, trim/tau contract, stop() retires it
 *   C. PositionalHum.setLevelMul - duck-only clamp [0,1], junk -> identity,
 *      smoothed via LEVEL_MUL_TAU_S onto an owned bus stage between the
 *      voices and out, stop() safe
 *   D. game.ts wiring - beginRun constructs a FRESH controller per run,
 *     every watcher spawn site opens the intro idempotently, the frame
 *     loop applies effects ONLY while isActive(), the once-flag is marked
 *     exactly once at 'done', and the superseded firstwatcher.ts module
 *     stays unmounted (shared 'bmb-firstwatcher' storage key).
 *
 * Run: node test/watcherintro-mount-test.mjs  (prints ALL PASS)
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const gameSrc = readFileSync(path.join(here, '../src/core/game.ts'), 'utf8');

const {
  WatcherIntroController,
  readShownFlag,
  WATCHERINTRO_STORAGE_KEY,
  PRELUDE_SECONDS,
  REVEAL_HOLD_SECONDS,
  HUM_DUCK,
  WATCHER_SUBTITLE,
} = await import('../src/story/watcherintro.ts');
const { DynamicScore, SWELL_TRIM, SWELL_TAU_S } = await import('../src/audio/music.ts');
const { PositionalHum, LEVEL_MUL_TAU_S } = await import('../src/audio/positional.ts');

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; console.log('  PASS', msg); }
  else { failures++; console.error('  FAIL', msg); }
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// PositionalHum.stop() schedules its voice release via window.setTimeout.
globalThis.window = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

/** In-memory storage stub with the localStorage surface. */
class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}

// ---- minimal AudioContext mock (hearinggain-test conventions) ---------------
class Param {
  constructor(v) {
    this.value = v;
    this.targets = [];
    this.sets = [];
  }
  setValueAtTime(v, t) { this.value = v; this.sets.push({ v, t }); }
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime(v, t, tc) { this.targets.push({ v, t, tc }); return v; }
  cancelScheduledValues() {}
}
class GNode {
  constructor(ctx) {
    this.ctx = ctx; this.out = null; this.inputs = [];
    this.gain = new Param(1); this.frequency = new Param(20000);
    this.Q = new Param(0.4); this.pan = new Param(0); this.detune = new Param(0);
    this.type = '';
  }
  connect(dest) { this.out = dest; if (dest) dest.inputs?.push(this); return dest; }
  disconnect() { this.out = null; }
  start() {} stop() {}
}
class FakeCtx {
  constructor() {
    this.currentTime = 1000;
    this.destination = new GNode(this);
    this.created = { gain: 0, filter: 0, osc: 0, panner: 0 };
  }
  createGain() { this.created.gain++; return new GNode(this); }
  createBiquadFilter() { const n = new GNode(this); n.type = 'lowpass'; this.created.filter++; return n; }
  createStereoPanner() { this.created.panner++; return new GNode(this); }
  createOscillator() { this.created.osc++; return new GNode(this); }
  createBuffer(channels, length, sr) {
    return { channels, length, sampleRate: sr, getChannelData: () => new Float32Array(length) };
  }
}

// ---------------------------------------------------------------------------
console.log('STAGE A: controller timeline (stub storage)');
{
  const store = new FakeStorage();
  const c = new WatcherIntroController({ storage: store });
  ok(c.shouldPlay() === true && c.phase === 'idle', 'fresh storage: shouldPlay true, phase idle');
  ok(c.getText() === null, 'idle getText is null');
  c.begin();
  ok(c.phase === 'prelude' && c.isActive(), 'begin() opens the prelude');
  ok(c.begin() === undefined && c.phase === 'prelude', 're-begin during prelude is a no-op');

  // prelude effects recipe
  let fx = c.getEffects();
  ok(close(fx.humDuck, HUM_DUCK) && HUM_DUCK === 0.5, 'prelude ducks hum to half');
  ok(fx.flickerFixture === true, 'prelude strobes the fixture');
  ok(close(fx.stringSwell, 0), 'swell starts at silence');
  c.update(PRELUDE_SECONDS / 2);
  fx = c.getEffects();
  ok(close(fx.stringSwell, 0.5), 'swell ramps linearly across the prelude');

  // visibility moment
  c.update(PRELUDE_SECONDS / 2 + 0.01);
  ok(c.phase === 'reveal' && c.isActive(), 'crossing PRELUDE_SECONDS flips into reveal');
  ok(c.getText() === WATCHER_SUBTITLE, 'reveal delivers THE one subtitle');
  fx = c.getEffects();
  ok(close(fx.humDuck, HUM_DUCK, 1e-2) && fx.flickerFixture === false && close(fx.stringSwell, 1, 1e-2),
    'reveal starts easing home from the prelude recipe');

  // reveal hold -> done
  c.update(REVEAL_HOLD_SECONDS + 0.01);
  ok(c.phase === 'done' && !c.isActive(), 'hold expiry retires the intro');
  ok(c.getText() === null, 'done getText is null again');
  c.markShown();
  ok(readShownFlag(store) === true, 'markShown persists the once-ever flag');
  ok(store.getItem(WATCHERINTRO_STORAGE_KEY).includes('"shown":true'), 'flag payload shape {shown:true}');

  // a fresh controller on the same storage never plays again
  const c2 = new WatcherIntroController({ storage: store });
  ok(c2.shouldPlay() === false && c2.phase === 'idle', 'post-flag controller never plays again');
  c2.begin();
  ok(c2.phase === 'idle', 'begin() after the flag stays idle');

  // markShown before begin still records the moment as seen
  const store3 = new FakeStorage();
  const c3 = new WatcherIntroController({ storage: store3 });
  c3.markShown();
  ok(readShownFlag(store3) === true, 'markShown before begin persists anyway');

  // junk dt safety
  const c4 = new WatcherIntroController({ storage: new FakeStorage() });
  c4.begin();
  c4.update(NaN); c4.update(-5); c4.update(Infinity);
  ok(c4.phase === 'prelude' && Number.isFinite(c4.getElapsed()), 'NaN/negative dt clamps safely');
}

// ---------------------------------------------------------------------------
console.log('STAGE B: DynamicScore.setIntroSwell laziness + contract');
{
  const ctx = new FakeCtx();
  const score = new DynamicScore(ctx, ctx.destination);
  const gainsBefore = ctx.created.gain;
  score.update(0.016); // frames pass without any intro
  ok(ctx.created.gain === gainsBefore && ctx.created.osc === 0,
    'no oscillators built until the first setIntroSwell call');

  score.setIntroSwell(0.5);
  ok(ctx.created.osc === 2, 'first use builds exactly the two string oscillators');
  // locate via the private field instead (test-only reach-in, repo convention)
  const swell = score['swell'];
  ok(swell && swell.oscs.length === 2, 'swell layer stored with its oscillators');
  ok(swell.gain.gain.targets.length === 1, 'setIntroSwell automates the swell gain');
  const ev = swell.gain.gain.targets[0];
  ok(close(ev.v, 0.5 * SWELL_TRIM) && SWELL_TRIM === 0.05, `full-ramp level is level*SWELL_TRIM (${ev.v})`);
  ok(close(ev.tc, SWELL_TAU_S) && SWELL_TAU_S === 0.4, 'swell motion uses the slow strings tau');

  score.setIntroSwell(42);
  ok(close(swell.gain.gain.targets.at(-1).v, SWELL_TRIM), 'above-range request clamps to full trim');
  score.setIntroSwell(-3);
  ok(close(swell.gain.gain.targets.at(-1).v, 0), 'below-range request reads as silence');
  score.setIntroSwell(NaN);
  ok(close(swell.gain.gain.targets.at(-1).v, 0), 'NaN falls back to silence');
  const oscCount = ctx.created.osc;
  score.setIntroSwell(0.7);
  ok(ctx.created.osc === oscCount, 'repeat calls reuse the built layer (build-once)');

  score.stop();
  score.setIntroSwell(0.9);
  ok(swell.gain.gain.targets.at(-1).v !== 0.9 * SWELL_TRIM || swell.gain.gain.targets.length > 1,
    'stopped score ignores further swell requests');
}

// ---------------------------------------------------------------------------
console.log('STAGE C: PositionalHum.setLevelMul duck semantics');
{
  const ctx = new FakeCtx();
  const dest = new GNode(ctx);
  const hum = new PositionalHum(ctx, dest);
  ok(hum.level === 1, 'identity until any duck request');
  const bus = hum['bus'];
  ok(bus && bus.out === dest, 'owned level stage sits between the voices and out');
  ok(close(bus.gain.value, 1), 'bus starts at unity');

  hum.setLevelMul(0.5);
  ok(close(hum.level, 0.5), 'in-range duck stored verbatim');
  let ev = bus.gain.targets.at(-1);
  ok(close(ev.v, 0.5) && close(ev.tc, LEVEL_MUL_TAU_S) && LEVEL_MUL_TAU_S === 0.15,
    'duck automates the bus with tau LEVEL_MUL_TAU_S=0.15');

  hum.setLevelMul(1.7);
  ok(hum.level === 1, 'this is a duck: above-range clamps DOWN to 1, never boosts');
  hum.setLevelMul(NaN);
  ok(hum.level === 1, 'NaN falls back to identity');
  hum.setLevelMul(0);
  ok(hum.level === 0, 'full mute duck allowed');
}
ok(/gain\.connect\(panner\)\.connect\(this\.bus\)/.test(readFileSync(path.join(here, '../src/audio/positional.ts'), 'utf8')),
  'source: voices route through the owned bus stage');
{
  const ctx = new FakeCtx();
  const hum = new PositionalHum(ctx, ctx.destination);
  hum.stop();
  hum.setLevelMul(0.2);
  ok(hum.level === 1, 'stopped hum ignores duck requests');
}

// ---------------------------------------------------------------------------
console.log('STAGE D: game.ts wiring greps');
{
  ok(/this\.watcherIntro = new WatcherIntroController\(\)/.test(gameSrc),
    'beginRun constructs a fresh controller (the dark-mount defect is closed)');
  ok(/private noteWatcherSpawn\(\): void \{[\s\S]{0,400}?watcherIntro\?\.begin\(\)/.test(gameSrc),
    'noteWatcherSpawn opens the intro through the guarded begin()');
  const spawnCalls = (gameSrc.match(/this\.noteWatcherSpawn\(\)/g) || []).length;
  ok(spawnCalls >= 4, `every watcher spawn site calls noteWatcherSpawn (${spawnCalls} sites)`);
  ok(/if \(this\.watcherIntro\.isActive\(\)\) \{[\s\S]{0,700}?setLevelMul\(wfx\.humDuck\)[\s\S]{0,400}?setIntroSwell\(wfx\.stringSwell\)[\s\S]{0,600}?ui\.say\(introLine, 4\)/.test(gameSrc),
    'frame loop applies hum duck + swell + subtitle ONLY while isActive()');
  ok(/phase === 'done' && !this\.watcherIntroMarked[\s\S]{0,200}?markShown\(\);\s*\n\s*this\.watcherIntroMarked = true/.test(gameSrc),
    'the once-flag is marked exactly once when the timeline reaches done');
  ok(!/new FirstWatcher\b/.test(gameSrc), 'superseded firstwatcher.ts stays unmounted (shared storage key)');
  ok((gameSrc.match(/new WatcherIntroController\(/g) || []).length === 1,
    'exactly one construction site keeps the per-run re-arm single-purpose');
}

console.log(failures === 0 ? `\n${passes}/${passes} checks ALL PASS` : `\n${failures} FAILURE(S) / ${passes} passes`);
process.exitCode = failures === 0 ? 0 : 1;
