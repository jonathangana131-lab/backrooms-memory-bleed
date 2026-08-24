/**
 * Injury limp tests (F77) - pure Node, no rendering.
 * Verifies the F77 acceptance proof: limp engages iff impact severity is
 * strictly beyond the threshold (boundary tested), asymmetry and speed
 * penalty are monotone in accumulated severity up to their caps, firstaid
 * clears exactly, state round-trips through the save serializer, and the
 * event->state mapping is fully deterministic.
 * Run: node test/limp-test.mjs  (prints ALL PASS, exits 0)
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
  InjuryLimp, excessSeverity, FALL_IMPACT_THRESHOLD, BASE_SPEED_PENALTY,
  MAX_SPEED_PENALTY, ASYMMETRY_BASE, ASYMMETRY_MAX, SEVERITY_PER_FULL_PENALTY,
} = await import('../src/player/limp.ts');

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures++;
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
};

/** Excess severity used for the repeat-fall worsening check. */
const SAMPLE_EXCESS = 12;

// --- 1. boundary: engages iff impact > threshold -----------------------------------
console.log('[threshold boundary]');
{
  const at = new InjuryLimp();
  at.onFallImpact({ severity: FALL_IMPACT_THRESHOLD });
  ok(!at.limping && at.speedPenalty() === 0 && at.strideAsymmetry() === 0
    && at.accumulatedSeverity === 0,
    `impact exactly at ${FALL_IMPACT_THRESHOLD} leaves no mark`);

  const under = new InjuryLimp();
  under.onFallImpact({ severity: FALL_IMPACT_THRESHOLD - 1e-9 });
  ok(!under.limping, `just-under-threshold impact (${FALL_IMPACT_THRESHOLD - 1e-9}) never engages`);

  const over = new InjuryLimp();
  over.onFallImpact({ severity: FALL_IMPACT_THRESHOLD + 1e-9 });
  ok(over.limping
    && Math.abs(over.speedPenalty() - BASE_SPEED_PENALTY) < 1e-9
    && Math.abs(over.strideAsymmetry() - ASYMMETRY_BASE) < 1e-9
    && Math.abs(over.accumulatedSeverity - 1e-9) < 1e-12,
    'just-over-threshold impact engages with base penalty/asymmetry');

  const sub = new InjuryLimp();
  sub.onFallImpact({ severity: FALL_IMPACT_THRESHOLD });
  sub.onFallImpact({ severity: 5 }); // soft tumble mid-limp would not matter either
  ok(sub.accumulatedSeverity === 0, 'sub-threshold impacts contribute zero severity');

  ok(excessSeverity(FALL_IMPACT_THRESHOLD) === 0
    && excessSeverity(FALL_IMPACT_THRESHOLD + 10) === 10
    && excessSeverity(0) === 0,
    'excessSeverity: threshold maps to 0, above maps to the overshoot');
}

// --- 2. monotone worsening up to the caps -------------------------------------------
console.log('[monotone worsening]');
{
  const STEP = 5;
  let prevAsym = -Infinity;
  let prevPen = -Infinity;
  let monotone = true;
  let capped = true;
  const trace = [];
  const limp = new InjuryLimp();
  for (let k = 0; k < 40; k++) {
    limp.onFallImpact({ severity: FALL_IMPACT_THRESHOLD + 1 + STEP * k });
    const asym = limp.strideAsymmetry();
    const pen = limp.speedPenalty();
    trace.push(`sev${limp.accumulatedSeverity.toFixed(0)}:${asym.toFixed(2)}/${pen.toFixed(3)}`);
    if (asym < prevAsym - 1e-12 || pen < prevPen - 1e-12) monotone = false;
    if (asym > ASYMMETRY_MAX + 1e-12 || pen > MAX_SPEED_PENALTY + 1e-12) capped = false;
    prevAsym = asym;
    prevPen = pen;
  }
  ok(monotone, `asymmetry+penalty monotone non-decreasing across 40 hard falls (${trace[0]} .. ${trace[39]})`);
  ok(capped, `both outputs never exceed their caps (${ASYMMETRY_MAX} / ${MAX_SPEED_PENALTY})`);
  ok(limp.accumulatedSeverity > 1000 && limp.strideAsymmetry() === ASYMMETRY_MAX
    && limp.speedPenalty() === MAX_SPEED_PENALTY,
    'deep saturation sits exactly on both caps');

  // a single moderate hard fall lands between base and cap, strictly worsened by one repeat
  const once = new InjuryLimp();
  once.onFallImpact({ severity: FALL_IMPACT_THRESHOLD + SAMPLE_EXCESS });
  const p1 = once.speedPenalty();
  once.onFallImpact({ severity: FALL_IMPACT_THRESHOLD + SAMPLE_EXCESS });
  ok(p1 > BASE_SPEED_PENALTY && once.speedPenalty() > p1,
    `a second identical fall deepens the limp (${p1.toFixed(3)} -> ${once.speedPenalty().toFixed(3)})`);
}

// --- 3. firstaid clears exactly --------------------------------------------------------
console.log('[firstaid clear]');
{
  const limp = new InjuryLimp();
  limp.onFallImpact({ severity: 80 });
  limp.onFallImpact({ severity: 90 });
  ok(limp.limping && limp.speedPenalty() > BASE_SPEED_PENALTY, 'pre-clear: limping and worsened');
  limp.onFirstaid();
  ok(!limp.limping && limp.speedPenalty() === 0 && limp.strideAsymmetry() === 0
    && limp.accumulatedSeverity === 0,
    'firstaid restores exact zeros across every output');
  limp.onFirstaid(); // while healthy
  ok(!limp.limping && limp.accumulatedSeverity === 0, 'firstaid while healthy is a no-op');

  // after clearing, a fresh fall re-engages from base, not from old severity
  limp.onFallImpact({ severity: 30 });
  const expectedFresh = BASE_SPEED_PENALTY
    + (MAX_SPEED_PENALTY - BASE_SPEED_PENALTY) * (5 / SEVERITY_PER_FULL_PENALTY);
  ok(limp.limping && limp.accumulatedSeverity === 5
    && Math.abs(limp.speedPenalty() - expectedFresh) < 1e-12,
    'post-clear re-injury starts fresh from the new severity only');
}

// --- 4. save round-trip ------------------------------------------------------------------
console.log('[save round-trip]');
{
  const limp = new InjuryLimp();
  limp.onFallImpact({ severity: 65 });
  limp.onFallImpact({ severity: 70 });

  // simulate a real save slot: JSON stringify -> parse -> reconstruct
  const slot = JSON.parse(JSON.stringify(limp.serialize()));
  const restored = new InjuryLimp(slot);
  ok(restored.limping === limp.limping
    && restored.accumulatedSeverity === limp.accumulatedSeverity
    && restored.speedPenalty() === limp.speedPenalty()
    && restored.strideAsymmetry() === limp.strideAsymmetry(),
    `serialize/load preserves the exact limp (${restored.speedPenalty().toFixed(4)} penalty)`);

  // a loaded limp keeps worsening and clears like a live one
  restored.onFallImpact({ severity: 60 });
  limp.onFallImpact({ severity: 60 });
  ok(restored.speedPenalty() === limp.speedPenalty(), 'loaded limp worsens identically to live');
  restored.onFirstaid();
  ok(!restored.limping && restored.speedPenalty() === 0, 'loaded limp responds to firstaid normally');

  // healthy save round-trips as healthy
  const healthy = JSON.parse(JSON.stringify(new InjuryLimp().serialize()));
  const revived = new InjuryLimp(healthy);
  ok(!revived.limping && revived.speedPenalty() === 0, 'healthy state round-trips as healthy');
}

// --- 5. determinism -------------------------------------------------------------------------
console.log('[determinism]');
{
  const events = [
    { severity: FALL_IMPACT_THRESHOLD + 7 },
    { severity: 3 }, // ignored
    { severity: FALL_IMPACT_THRESHOLD + 21 },
    { severity: FALL_IMPACT_THRESHOLD }, // boundary, ignored
    { severity: FALL_IMPACT_THRESHOLD + 2 },
    { severity: 999 },
    { severity: 40 },
  ];
  const replay = () => {
    const limp = new InjuryLimp();
    const out = [];
    for (const ev of events) {
      limp.onFallImpact(ev);
      if (ev.severity === 999) limp.onFirstaid();
      out.push([limp.limping ? 1 : 0, limp.strideAsymmetry(), limp.speedPenalty()]);
    }
    return JSON.stringify(out);
  };
  ok(replay() === replay(), 'same event stream -> byte-identical output timeline');

  const srcPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'player', 'limp.ts');
  const src = readFileSync(srcPath, 'utf8');
  ok(!src.includes('Math.random'), 'module contains no unseeded randomness at all');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
