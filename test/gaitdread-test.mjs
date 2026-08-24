/**
 * Gait-synced dread tests - pure Node, no audio device.
 * Verifies the F8 acceptance proof: the module's phase-coherence metric
 * is monotone non-decreasing across a tension sweep 0->1 on fixed
 * synthetic input; offsets are exactly 0 at t=0; drift stays bounded;
 * every function is pure and deterministic.
 * Run: node test/gaitdread-test.mjs  (prints ALL PASS, exits 0)
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

const {
  dreadOffset, applyGaitDread, phaseCoherence,
  excitedHeartbeatPeriod,
  HEARTBEAT_PERIOD_REST, MAX_DRIFT_FRACTION,
} = await import('../src/audio/gaitdread.ts');
const { RNG } = await import('../src/core/rng.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

const P = HEARTBEAT_PERIOD_REST;

/** Fixed synthetic stride train: player cadence with realistic jitter. */
const STRIDE_INTERVAL = 0.52;
const NOMINAL = (() => {
  const rng = new RNG(0xbeef);
  const out = [];
  let t = STRIDE_INTERVAL;
  for (let i = 0; i < 200; i++) {
    // deterministic jitter: +/-6% of the stride, seeded
    t += STRIDE_INTERVAL * (1 + rng.range(-0.06, 0.06));
    out.push(t);
  }
  return out;
})();

const SWEEP = [];
for (let i = 0; i <= 20; i++) SWEEP.push(i / 20);

// --- 1. acceptance proof: coherence is monotone in tension --------------------
console.log('[monotone coherence]');
{
  let prev = -1;
  let monotone = true;
  const trace = [];
  for (const tension of SWEEP) {
    const c = phaseCoherence(applyGaitDread(tension, NOMINAL, P), P);
    trace.push(c.toFixed(4));
    if (c < prev - 1e-12) monotone = false;
    prev = c;
  }
  ok(monotone,
    `phase-coherence non-decreasing across ${SWEEP.length}-point sweep ` +
    `${trace[0]} -> ${trace[trace.length - 1]}`);
}

// --- 2. zero tension leaves timing untouched -----------------------------------
console.log('[rest state]');
{
  const shifted = applyGaitDread(0, NOMINAL, P);
  ok(shifted.every((t, i) => t === NOMINAL[i]),
    'at t=0 every offset is exactly 0');
  const base = phaseCoherence(NOMINAL, P);
  ok(base < 0.75,
    `untensed train is not beat-locked (coherence ${base.toFixed(3)})`);
}

// --- 3. drift is bounded --------------------------------------------------------
console.log('[bounded drift]');
{
  let worst = 0;
  for (const tension of [0.25, 0.5, 0.75, 1]) {
    for (let k = 0; k < 400; k++) {
      const onset = k * 0.037; // dense grid hits every heartbeat phase
      worst = Math.max(worst, Math.abs(dreadOffset(tension, onset, P)));
    }
  }
  ok(worst <= MAX_DRIFT_FRACTION * P + 1e-12,
    `worst offset ${worst.toFixed(4)}s <= ${(MAX_DRIFT_FRACTION * P).toFixed(4)}s cap`);
  // even full-tension onsets never cross the beat they are pulled toward
  let crossed = false;
  for (let k = 0; k < 400; k++) {
    const onset = k * 0.037;
    const nearest = Math.round(onset / P) * P;
    const moved = onset + dreadOffset(1, onset, P);
    if (Math.abs(moved - nearest) > Math.abs(onset - nearest) + 1e-12) crossed = true;
  }
  ok(!crossed, 'no onset ever crosses its target beat');
}

// --- 4. purity and determinism ---------------------------------------------------
console.log('[purity]');
{
  const once = applyGaitDread(0.7, NOMINAL, P);
  const twice = applyGaitDread(0.7, NOMINAL, P);
  ok(JSON.stringify(once) === JSON.stringify(twice), 'same inputs -> identical offsets');
  const snapshot = NOMINAL.slice();
  applyGaitDread(1, NOMINAL, P);
  ok(JSON.stringify(NOMINAL) === JSON.stringify(snapshot), 'input array never mutated');
  ok(!readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    '..', 'src', 'audio', 'gaitdread.ts'), 'utf8').includes('Math.random'),
    'module contains no randomness at all');
}

// --- 5. the pulse itself races ----------------------------------------------------
console.log('[aroused heart]');
{
  let monotoneDown = true;
  let prev = Infinity;
  for (const tension of SWEEP) {
    const period = excitedHeartbeatPeriod(tension, P);
    if (period > prev + 1e-12) monotoneDown = false;
    prev = period;
  }
  ok(monotoneDown && excitedHeartbeatPeriod(0, P) === P,
    `heartbeat shortens monotonically ${P.toFixed(2)}s -> ` +
    `${excitedHeartbeatPeriod(1, P).toFixed(3)}s under tension`);
  ok(excitedHeartbeatPeriod(1) < excitedHeartbeatPeriod(0),
    'default rest period races too');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
