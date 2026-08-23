#!/usr/bin/env node
/**
 * perfmarks behavioural tests.
 * Run: node --experimental-strip-types test/perfmarks-test.mjs
 * (needs Node >= 22.6 for TypeScript strip-types)
 */
import { spawnSync } from 'node:child_process';

const probe = spawnSync(process.execPath, ['--experimental-strip-types', '-e', 'process.exit(0)']);
if (probe.status !== 0) {
  console.warn('SKIP behavioural: this Node lacks --experimental-strip-types');
  process.exit(0);
}

const {
  FLAGS,
  SECTION,
  setEnabled,
  mark,
  measure,
  samples,
  stats,
  statsFor,
  report,
  reset,
} = await import('../src/core/perfmarks.ts');

let failures = 0;
function ok(cond, label) {
  if (cond) {
    console.log('  ok  ' + label);
  } else {
    failures++;
    console.error('FAIL  ' + label);
  }
}

// ---- 1. disabled by default: every method is an instant no-op -------------
reset();
setEnabled(false);
ok(FLAGS.ENABLED === false, 'starts disabled');
ok(mark('x') === -1, 'mark no-ops (-1) when disabled');
ok(measure('x', 0) === -1, 'measure no-ops (-1) when disabled');
ok(stats().length === 0 && statsFor(SECTION.MEM_TICK) === null, 'no stats collected while disabled');

// ---- 2. enabled: mark/measure round trip -----------------------------------
setEnabled(true);
const t0 = mark(SECTION.CHUNK_BUILD);
ok(typeof t0 === 'number' && t0 >= 0, 'mark returns a real timestamp when enabled');
let busySum = 0;
for (let i = 0; i < 200000; i++) busySum += i % 7;
const ms = measure(SECTION.CHUNK_BUILD, t0);
ok(ms > 0, 'measure returns positive elapsed ms (' + ms.toFixed(3) + 'ms)');
const s = statsFor(SECTION.CHUNK_BUILD);
ok(s !== null && s.count === 1 && s.min === s.max && s.min === s.avg, 'single-sample stats are self-consistent');
ok(s.p95 >= s.min && s.p95 <= s.max, 'p95 within [min,max]');

// ---- 3. string start-mark variant -------------------------------------------
mark('string.start');
const ms2 = measure('string.start', 'string.start');

(Showing lines 1-60 of 104. Use offset=61 to continue.)

