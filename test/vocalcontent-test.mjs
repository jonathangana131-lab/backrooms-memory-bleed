/* Vocalization content library tests - run with: node test/vocalcontent-test.mjs
   Part 1: static structure checks (always runs).
   Part 2: behavioural checks against the real module via Node's
   TypeScript type-stripping, when this Node supports it. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'entities', 'vocalcontent.ts');
const src = readFileSync(srcPath, 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');
ok(src.includes('export const BELIEVER_MUTTERINGS'), 'exports BELIEVER_MUTTERINGS');
ok(src.includes('export const WANDERER_HUMS'), 'exports WANDERER_HUMS');
ok(src.includes('export const BROADCAST_FRAGMENTS'), 'exports BROADCAST_FRAGMENTS');
ok(src.includes('export function pickFragment'), 'exports pickFragment');
ok(src.includes('export function pickFragment<') && src.includes('recentHistory'), 'pickFragment(pool, seed, recentHistory) generic signature');
ok(src.includes('[0, 3, 5, 7, 10]'), 'minor pentatonic degree table matches synthesizer');
ok(/quiet dread/.test(src), 'tone contract documents quiet-dread register');

console.log('[behavioural]');

async function behaviour() {
  const mod = await import('../src/entities/vocalcontent.ts');

  // ---- mutterings: exactly 20, each 3-8 syllables, non-empty text ----
  ok(mod.BELIEVER_MUTTERINGS.length === 20,
    'exactly 20 believer mutterings (got ' + mod.BELIEVER_MUTTERINGS.length + ')');
  const badSyll = mod.BELIEVER_MUTTERINGS.filter(
    (m) => !Number.isInteger(m.syllables) || m.syllables < 3 || m.syllables > 8);
  ok(badSyll.length === 0, 'every muttering declares 3-8 syllables');
  ok(mod.BELIEVER_MUTTERINGS.every((m) => typeof m.text === 'string' && m.text.length > 0),
    'every muttering has text');
  const texts = new Set(mod.BELIEVER_MUTTERINGS.map((m) => m.text));
  ok(texts.size === 20, 'no duplicate mutterings');
  // tone spot-checks: denial, broken prayer, domestic anchor
  ok(mod.BELIEVER_MUTTERINGS.some((m) => /isn't|not real/.test(m.text)), 'denial register present');
  ok(mod.BELIEVER_MUTTERINGS.some((m) => m.text.includes('...')), 'broken/lost words marked with ellipses');
  ok(mod.BELIEVER_MUTTERINGS.some((m) => /amen|hallowed|father/i.test(m.text)), 'prayer register present');

  // ---- hums: exactly 8, each 3-5 notes on the pentatonic, beats > 0 ----
  ok(mod.WANDERER_HUMS.length === 8,
    'exactly 8 wanderer hum fragments (got ' + mod.WANDERER_HUMS.length + ')');
  const scale = new Set(mod.HUM_SCALE_DEGREES);
  let humShapeOk = true;
  let humBeatsOk = true;
  for (const h of mod.WANDERER_HUMS) {
    if (!Array.isArray(h.notes) || h.notes.length < 3 || h.notes.length > 5) humShapeOk = false;
    for (const n of h.notes) {
      if (!scale.has(n.degree)) humShapeOk = false;
      if (!(typeof n.beats === 'number' && n.beats > 0 && Number.isFinite(n.beats))) humBeatsOk = false;
    }
  }
  ok(humShapeOk, 'every hum is 3-5 notes using pentatonic degrees only');
  ok(humBeatsOk, 'every note carries a positive beat duration');

  // ---- broadcasts: exactly 15, tags valid, all four categories covered ----
  ok(mod.BROADCAST_FRAGMENTS.length === 15,
    'exactly 15 broadcast fragments (got ' + mod.BROADCAST_FRAGMENTS.length + ')');
  const validTags = new Set(['coordinates', 'timestamp', 'personal', 'warning']);
  ok(mod.BROADCAST_FRAGMENTS.every((b) => validTags.has(b.tag)),
    'every broadcast carries a known tag');
  for (const tag of validTags) {
    ok(mod.BROADCAST_FRAGMENTS.some((b) => b.tag === tag), 'broadcast pool covers "' + tag + '"');
  }
  const btexts = new Set(mod.BROADCAST_FRAGMENTS.map((b) => b.text));
  ok(btexts.size === 15, 'no duplicate broadcasts');

  // ---- pickFragment: deterministic, history-aware ----
  const pool = [10, 20, 30, 40, 50];
  ok(mod.pickFragment([], 1) === null, 'empty pool yields null');

  const a1 = mod.pickFragment(pool, 12345);
  const a2 = mod.pickFragment(pool, 12345);
  ok(a1 === a2, 'same seed picks same fragment');
  ok(pool.includes(a1), 'picked fragment comes from the pool');

  const picks = new Set();
  for (let s = 0; s < 200; s++) picks.add(mod.pickFragment(pool, s));
  ok(picks.size >= 4, 'different seeds explore the pool (' + picks.size + '/5 seen)');

  // immediate repetition avoidance per figure instance
  const first = mod.pickFragment(pool, 777);
  const second = mod.pickFragment(pool, 777, [first]);
  ok(second !== first, 'history excludes just-picked fragment');
  ok(pool.includes(second), 'replacement still comes from the pool');

  // walk covers whole pool before repeating
  let cur = mod.pickFragment(pool, 42);
  const seen = [cur];
  for (let i = 0; i < pool.length - 1; i++) {
    cur = mod.pickFragment(pool, 42, seen);
    if (seen.includes(cur)) break;
    seen.push(cur);
  }
  ok(seen.length === pool.length, 'full-history walk visits every entry once');

  // history covering the whole pool falls back instead of returning undefined
  const fallback = mod.pickFragment(pool, 42, pool);
  ok(fallback !== null && fallback !== undefined, 'saturated history still returns a fragment');

  // string pools work too (SameValueZero membership)
  const spool = ['a', 'b', 'c'];
  ok(spool.includes(mod.pickFragment(spool, 9)), 'string pools supported');
}

try {
  await behaviour();
} catch (err) {
  console.error('  FAIL behavioural section could not run:', err.message);
  failures++;
}

if (failures > 0) process.exit(1);
console.log('vocalcontent-test: all checks passed');


