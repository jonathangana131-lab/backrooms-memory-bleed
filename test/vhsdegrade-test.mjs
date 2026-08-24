/**
 * Procedural VHS degradation tests (F87) - pure Node, no renderer.
 * Verifies the F87 artifact-intensity acceptance proof:
 *   1. baseline cleanliness - p = 0 yields the exact clean signal: every
 *      artifact zero, bandIndex -1, cleanSignal true
 *   2. monotone intensity - over a fine upward sweep of p (fresh instance
 *      per sample and one continuing instance), tracking-error lines,
 *      chroma bleed, dropout frequency, and scanline jitter are all
 *      non-decreasing across multiple seeds
 *   3. bounds held - every descriptor field stays inside its published
 *      bound for sweep samples AND adversarial junk inputs
 *   4. bursts exact at band crossings - upward sweeps fire exactly one
 *      burst per seeded threshold exactly on the first frame at or above
 *      it; downward movement never fires; a 0 -> 1 jump fires all bands
 *      at once; burstBoost decays to 0 within the burst lifetime
 *   5. junk-dt safety - NaN / Infinity / negative / >1 proximity clamp
 *      into [0,1] without throwing or poisoning later frames; junk frame
 *      indices accepted
 *   6. determinism - same seed + same p/frame feed replays byte-identical;
 *      different seeds diverge and place thresholds differently
 *
 * Run: node test/vhsdegrade-test.mjs  (prints VHSDEGRADE ALL PASS, exits 0)
 */
import { register } from 'node:module';

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

const {
  VhsDegrade, TRACKING_LINES_MAX, DROPOUT_RATE_MAX, BAND_COUNT,
} = await import('../src/gfx/vhsdegrade.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const SEEDS = [1, 7, 424242, 0xdeadbeef, 999983];
const STEPS = 201;

/** Fresh-instance sweep: evaluate base artifacts at each p independently. */
function freshSweep(seed) {
  const out = [];
  for (let i = 0; i < STEPS; i++) {
    out.push(new VhsDegrade(seed).frame(i / (STEPS - 1), 0));
  }
  return out;
}

/** Non-decreasing check over an array of numbers. */
function nonDecreasing(vals) {
  for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) return false;
  return true;
}

// --- 1. baseline cleanliness ---------------------------------------------------
console.log('[baseline]');
{
  let allClean = true;
  for (const seed of SEEDS) {
    const d = new VhsDegrade(seed).frame(0, 100);
    if (!(d.cleanSignal === true && d.proximity === 0 && d.bandIndex === -1
      && d.trackingErrorLines === 0 && d.chromaBleed === 0
      && d.dropoutRatePerSec === 0 && d.scanlineJitter === 0
      && d.burstsFired.length === 0 && d.burstBoost === 0)) allClean = false;
  }
  ok(allClean, `p=0 is exactly clean on every seed (zero artifacts, no bursts)`);

  const d = new VhsDegrade(5).frame(0.001, 0);
  ok(d.cleanSignal === false, 'any positive p breaks the clean flag');
}

// --- 2. monotone intensity -------------------------------------------------------
console.log('[monotone]');
{
  let allMono = true;
  for (const seed of SEEDS) {
    const sweep = freshSweep(seed);
    const cols = {
      lines: sweep.map((d) => d.trackingErrorLines),
      chroma: sweep.map((d) => d.chromaBleed),
      dropout: sweep.map((d) => d.dropoutRatePerSec),
      jitter: sweep.map((d) => d.scanlineJitter),
    };
    for (const k of Object.keys(cols)) {
      if (!nonDecreasing(cols[k])) { allMono = false; console.error('   not monotone:', k, 'seed', seed); }
    }
  }
  ok(allMono, `all four artifacts non-decreasing in p over ${STEPS}-point sweeps x ${SEEDS.length} seeds`);

  // Continuing instance: history must not bend the base-artifact monotonicity.
  const vhs = new VhsDegrade(31);
  let seqMono = true;
  let prev = -1;
  for (let i = 0; i < STEPS; i++) {
    const d = vhs.frame(i / (STEPS - 1), i);
    if (d.chromaBleed < prev) seqMono = false;
    prev = d.chromaBleed;
  }
  ok(seqMono, 'continuing instance stays monotone through burst activity');

  // Strictness somewhere: high p must actually exceed low p.
  const lo = new VhsDegrade(9).frame(0.05, 0);
  const hi = new VhsDegrade(9).frame(0.95, 0);
  ok(hi.trackingErrorLines > lo.trackingErrorLines && hi.chromaBleed > lo.chromaBleed
    && hi.dropoutRatePerSec > lo.dropoutRatePerSec,
    'artifact intensity strictly increases from near-clean to near-dead');
}

// --- 3. bounds held -----------------------------------------------------------------
console.log('[bounds]');
{
  let inBounds = true;
  const probe = (d) => {
    if (!(d.trackingErrorLines >= 0 && d.trackingErrorLines <= TRACKING_LINES_MAX
      && Number.isInteger(d.trackingErrorLines)
      && d.chromaBleed >= 0 && d.chromaBleed <= 1
      && d.dropoutRatePerSec >= 0 && d.dropoutRatePerSec <= DROPOUT_RATE_MAX
      && d.scanlineJitter >= 0 && d.scanlineJitter <= 1
      && d.burstBoost >= 0 && d.burstBoost <= 1
      && d.bandIndex >= -1 && d.bandIndex <= BAND_COUNT - 1)) inBounds = false;
  };
  for (const seed of SEEDS) for (const d of freshSweep(seed)) probe(d);
  const vhs = new VhsDegrade(777);
  for (const p of [-1, 0.5, 2, NaN, Infinity, -Infinity]) probe(vhs.frame(p, 3));
  ok(inBounds, `every descriptor field inside published bounds (incl. junk inputs)`);

  const maxed = new VhsDegrade(3).frame(1, 0);
  ok(maxed.trackingErrorLines === TRACKING_LINES_MAX && maxed.chromaBleed === 1
    && Math.abs(maxed.dropoutRatePerSec - DROPOUT_RATE_MAX) < 1e-9,
    `p=1 saturates exactly at TRACKING_LINES_MAX=${TRACKING_LINES_MAX}, chroma 1, DROPOUT_RATE_MAX=${DROPOUT_RATE_MAX}`);
}

// --- 4. bursts exact at band crossings --------------------------------------------------
console.log('[bursts]');
{
  let seedOkAll = true;
  for (const seed of SEEDS) {
    const vhs = new VhsDegrade(seed);
    const th = vhs.bandThresholds;
    let good = th.length === BAND_COUNT
      && th.every((t, i) => i === 0 || t > th[i - 1]);
    // Slow upward sweep: one burst per threshold, fired exactly on the
    // first frame whose p reaches it.
    const firedAt = new Map();
    for (let f = 0; f <= 400 && good; f++) {
      const d = vhs.frame(f / 400, f);
      if (d.burstsFired.length > 1) good = false;
      for (const b of d.burstsFired) {
        if (firedAt.has(b.bandIndex)) good = false;
        else firedAt.set(b.bandIndex, { f, b });
        if (f / 400 < b.threshold || b.threshold !== th[b.bandIndex]) good = false;
      }
    }
    if (firedAt.size !== BAND_COUNT) good = false;
    for (const [, { f, b }] of firedAt) {
      const prevP = (f - 1) / 400;
      if (!(prevP < b.threshold)) good = false;
    }
    // Continue with a downward sweep: nothing new fires.
    let downBursts = 0;
    for (let f = 401; f <= 500; f++) {
      downBursts += vhs.frame(1 - (f - 401) / 100, f).burstsFired.length;
    }
    if (downBursts !== 0) good = false;
    if (!good) console.error('   burst discipline broken for seed', seed);
    seedOkAll = seedOkAll && good;
  }
  ok(seedOkAll === true, `one exact burst per seeded threshold on crossing, none on descent (${SEEDS.length} seeds)`);

  // Jump 0 -> 1 fires all bands at once.
  const jump = new VhsDegrade(51);
  const dJump = jump.frame(1, 0);
  ok(dJump.burstsFired.length === BAND_COUNT
    && dJump.burstsFired.every((b, i) => b.bandIndex === i),
    `0 -> 1 jump fires all ${BAND_COUNT} bands on one frame`);

  // Re-crossing after retreat fires again (thresholds re-arm only by
  // moving below them first).
  const rc = new VhsDegrade(52);
  rc.frame(0.99, 0); rc.frame(0, 1);
  const again = rc.frame(0.99, 2);
  ok(again.burstsFired.length === BAND_COUNT, 'retreating below all bands re-arms every threshold');

  // burstBoost decays to exactly 0 within each burst lifetime.
  const dv = new VhsDegrade(53);
  dv.frame(1, 0);
  let boostZeroAt = -1;
  for (let f = 1; f <= 30; f++) {
    if (dv.frame(1, f).burstBoost === 0) { boostZeroAt = f; break; }
  }
  ok(boostZeroAt > 0, `burstBoost fully decayed by frame ${boostZeroAt}`);
}

// --- 5. junk-dt safety --------------------------------------------------------------------
console.log('[junk]');
{
  const vhs = new VhsDegrade(88);
  const junk = [NaN, Infinity, -Infinity, -0.5, 1.5, 1e308];
  let safe = true;
  for (const p of junk) {
    try {
      const d = vhs.frame(p, NaN);
      if (!(d.proximity >= 0 && d.proximity <= 1)) safe = false;
    } catch { safe = false; }
  }
  ok(safe, 'junk p values clamp into [0,1]; junk frame index accepted');
  ok(vhs.frame(NaN, 0).cleanSignal === true, 'NaN proximity reads as the clean baseline');

  // Stream unpoisoned: normal frames after junk behave like a fresh run.
  const a = new VhsDegrade(89);
  for (const p of [NaN, 2, -3]) a.frame(p, 0);
  const b = new VhsDegrade(89);
  let sameAfterJunk = true;
  for (let f = 0; f < 50; f++) {
    if (JSON.stringify(a.frame((f % 20) / 20, f)) !== JSON.stringify(b.frame((f % 20) / 20, f))) sameAfterJunk = false;
  }
  ok(sameAfterJunk, 'post-junk frames identical to an unpolluted instance');
}

// --- 6. determinism ----------------------------------------------------------------------------
console.log('[determinism]');
{
  const feed = (seed) => {
    const vhs = new VhsDegrade(seed);
    const frames = [];
    for (let f = 0; f < 120; f++) {
      const p = f < 60 ? f / 60 : 1 - (f - 60) / 60;
      frames.push(vhs.frame(p, f));
    }
    return JSON.stringify(frames);
  };
  ok(feed(1234) === feed(1234), 'same seed + same p/frame feed replays byte-identical');
  ok(feed(1234) !== feed(1235), 'different seed diverges');

  const tA = new VhsDegrade(2000).bandThresholds;
  const tB = new VhsDegrade(2001).bandThresholds;
  ok(tA.some((t, i) => Math.abs(t - tB[i]) > 1e-6), 'band-threshold positions vary per seed');
}

console.log(failures === 0 ? `VHSDEGRADE ALL PASS (${check} checks)` : `VHSDEGRADE FAILURES: ${failures}/${check}`);
process.exit(failures === 0 ? 0 : 1);
