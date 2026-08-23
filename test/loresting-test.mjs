/**
 * Lore discovery stinger tests — run with:
 *   node --test test/loresting-test.mjs
 *
 * Part 1 is static structure checking (always runs).
 * Part 2 exercises LoreStings against a mock AudioContext via Node's
 * TypeScript type-stripping, when this Node supports it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'audio', 'loresting.ts');
const src = readFileSync(srcPath, 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');
ok(src.includes('export class LoreStings'), 'exports LoreStings');
ok(src.includes("constructor(ctx: AudioContext, destination: AudioNode)"), 'constructor(ctx, destination) signature');
for (const m of ['noteRead(stage: number)', 'clusterComplete(stage: number)', 'radioLock(stage: number)']) {
  ok(src.includes(m) || src.includes(m.replace(': number', ' = 0')), `method ${m}`);
}
ok(/stop\(\)\s*:\s*void/.test(src), 'method stop(): void');
ok(/'sine'/.test(src), 'sine oscillators for note stings');
ok(/'triangle'/.test(src), 'triangle oscillator for radio lock');
ok(/exponentialRampToValueAtTime\(600/.test(src), 'glissando ramps to 600 Hz');
ok(/setValueAtTime\(300/.test(src), 'glissando starts at 300 Hz');
ok(/8000/.test(src) && /3000/.test(src), 'stage cutoff endpoints 8000/3000 Hz');
ok(/440/.test(src), 'A4 = 440 Hz present');
ok(/523\.25/.test(src), 'C5 = 523.25 Hz present');
ok(/659\.25/.test(src) && /880/.test(src), 'E5 and A5 present');

// ---- part 2: behavioural (needs Node >= 22.6 type stripping) ----
console.log('[behavioural]');


