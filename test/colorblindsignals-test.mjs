/**
 * Colorblind anomaly signal tests (F99) - pure Node, no renderer.
 * Verifies the F99 acceptance proof:
 *   1. AC pattern coverage - all three severity classes are covered by the
 *      table with pairwise-DISTINCT geometric patterns and finite positive
 *      pulse rhythms
 *   2. rhythm separation - every pair of pulse rhythms is separated by at
 *      least MIN_PULSE_SEPARATION (>=2x), so tempo alone discriminates
 *   3. passthrough exact when off - colorblind mode off returns exactly null
 *      for every class AND for junk severities, never throwing, so existing
 *      color cues stand unchanged
 *   4. pairing on - mode on returns the exact frozen table descriptor per
 *      class; unknown strings yield null; non-string fails loud
 *   5. determinism - identical calls replay byte-identical results across
 *      repeated invocations
 *   6. junk safe - falsy junk modes (0, '', NaN, null, undefined) all read
 *      as OFF and return null without throwing; truthy junk modes still
 *      yield proper descriptors for valid classes
 *
 * Run: node test/colorblindsignals-test.mjs (prints COLORBLINDSIGNALS ALL PASS, exits 0)
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
  anomalySignal,
  isSeverityClass,
  SIGNAL_TABLE,
  SEVERITY_CLASSES,
  MIN_PULSE_SEPARATION,
} = await import('../src/ui/colorblindSignals.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// ---------------------------------------------------------------------------
console.log('1. AC pattern coverage: all three classes covered distinctly');
{
  ok(SEVERITY_CLASSES.length === 3, 'exactly three severity classes exposed');

  const covered = SEVERITY_CLASSES.every((s) =>
    SIGNAL_TABLE[s] !== undefined &&
    Number.isFinite(SIGNAL_TABLE[s].pulseHz) &&
    SIGNAL_TABLE[s].pulseHz > 0);
  ok(covered, 'every class maps to a finite positive pulseHz descriptor');

  const patterns = SEVERITY_CLASSES.map((s) => SIGNAL_TABLE[s].patternId);
  ok(new Set(patterns).size === 3,
    `patterns pairwise distinct: ${patterns.join(', ')}`);

  const hzs = SEVERITY_CLASSES.map((s) => SIGNAL_TABLE[s].pulseHz);
  ok(new Set(hzs).size === 3, `pulse rhythms pairwise distinct: ${hzs.join(', ')}`);

  ok(isSeverityClass('info') && isSeverityClass('warning') && isSeverityClass('critical')
    && !isSeverityClass('info ') && !isSeverityClass(7) && !isSeverityClass(undefined),
    'isSeverityClass accepts only the three classified strings');
}

// ---------------------------------------------------------------------------
console.log('2. Rhythm separation: every pair separated >= MIN_PULSE_SEPARATION');
{
  const hzs = SEVERITY_CLASSES.map((s) => SIGNAL_TABLE[s].pulseHz).sort((a, b) => a - b);
  let sepOk = true;
  for (let i = 0; i < hzs.length; i++) {
    for (let j = i + 1; j < hzs.length; j++) {
      if (hzs[j] / hzs[i] < MIN_PULSE_SEPARATION) sepOk = false;
    }
  }
  ok(sepOk, `all pulse ratios >= ${MIN_PULSE_SEPARATION}x over sorted [${hzs.join(', ')}]`);
  ok(hzs[hzs.length - 1] / hzs[0] >= MIN_PULSE_SEPARATION ** (SEVERITY_CLASSES.length - 1),
    'extremes separated by at least separation^(classes-1)');
}

// ---------------------------------------------------------------------------
console.log('3. Passthrough exact when off: null for everything, never throws');
{
  let passthroughExact = true;
  for (const s of [...SEVERITY_CLASSES, 'unknown', '', 7, null, undefined, NaN]) {
    if (anomalySignal(false, /** @type {any} */ (s)) !== null) passthroughExact = false;
  }
  ok(passthroughExact, 'mode OFF returns exactly null across valid + junk severities');

  let noThrowOff = true;
  for (const junk of [undefined, null, 0, -0, '', NaN, false]) {
    try { anomalySignal(junk, 'critical'); } catch { noThrowOff = false; }
  }
  ok(noThrowOff, 'mode OFF short-circuits before severity validation (junk-safe)');
}

// ---------------------------------------------------------------------------
console.log('4. Pairing on: exact table descriptors per class');
{
  let pairingExact = true;
  for (const s of SEVERITY_CLASSES) {
    const d = anomalySignal(true, s);
    if (d !== SIGNAL_TABLE[s]) pairingExact = false;
    else if (d.patternId !== SIGNAL_TABLE[s].patternId || d.pulseHz !== SIGNAL_TABLE[s].pulseHz) {
      pairingExact = false;
    }
  }
  ok(pairingExact, 'mode ON returns the identical frozen descriptor for each class');

  ok(anomalySignal(true, 'unclassified') === null,
    'unknown string severity on ON yields null (no invented cue)');
  ok(throws(() => anomalySignal(true, /** @type {any} */ (42))),
    'non-string severity on ON fails loud');
  ok(throws(() => anomalySignal(true, /** @type {any} */ (null))),
    'null severity on ON fails loud');
}

// ---------------------------------------------------------------------------
console.log('5. Determinism: byte-identical replay');
{
  const run = () => JSON.stringify([
    ...SEVERITY_CLASSES.map((s) => anomalySignal(true, s)),
    ...SEVERITY_CLASSES.map((s) => anomalySignal(false, s)),
  ]);
  const a = run(); const b = run(); const c = run();
  ok(a === b && b === c, 'repeated invocation sequences replay byte-identical');
  ok(JSON.parse(a).every((d) => d === null || (Number.isFinite(d.pulseHz) && typeof d.patternId === 'string')),
    'replayed descriptors carry only finite/typed fields');
}

// ---------------------------------------------------------------------------
console.log('6. Junk safe: falsy modes read as OFF, truthy junk modes pair normally');
{
  const falsyJunk = [undefined, null, 0, -0, NaN, '', false];
  ok(falsyJunk.every((m) => anomalySignal(m, 'info') === null),
    'every falsy junk mode reads as OFF -> null');
  ok([1, 'on', [], {}, Symbol?.('x'), () => {}].every(
    (m) => anomalySignal(/** @type {any} */ (m), 'warning') === SIGNAL_TABLE.warning),
    'every truthy junk mode yields the proper warning descriptor');
}

// ---------------------------------------------------------------------------
if (failures === 0) console.log(`COLORBLINDSIGNALS ALL PASS (${check} checks)`);
else { console.error(`COLORBLINDSIGNALS FAILED: ${failures}/${check}`); process.exit(1); }
