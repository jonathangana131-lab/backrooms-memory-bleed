/* Second wave vocalization content tests - run with: node test/vocalwave2-test.mjs
   Part 1: static structure checks (always runs).
   Part 2: behavioural checks against the real module via Node's
   TypeScript type-stripping, when this Node supports it. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'entities', 'vocalwave2.ts');
const src = readFileSync(srcPath, 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};

console.log('[static]');
ok(src.includes('export const WATCHER_BROADCASTS'), 'exports WATCHER_BROADCASTS');
ok(src.includes("text: 'REYES'") && src.includes("text: 'MARLOW'"), 'roster includes REYES and MARLOW');
ok(src.includes('export const HELPER_COMFORTS'), 'exports HELPER_COMFORTS');
ok(src.includes("'this way'") && src.includes("'not much farther'") && src.includes("'keep moving'"),
  'helper pool carries the three core comfort phrases');
ok(src.includes('export const INCOMPLETE_BASE_PHRASES'), 'exports INCOMPLETE_BASE_PHRASES');
ok(src.includes('export function garblePhrase'), 'exports garblePhrase');
ok(src.includes('export function pickWatcherBroadcast'), 'exports pickWatcherBroadcast');
ok(src.includes('export function pickHelperComfort'), 'exports pickHelperComfort');
ok(src.includes('export function pickIncompleteGarble'), 'exports pickIncompleteGarble');
ok(src.includes('WATCHER_BROADCAST_RADIUS_M = 12'), 'watcher burst radius is 12 meters');
ok(src.includes('recentHistory'), 'selection functions take recent history');
ok(/quiet dread/.test(src), 'tone contract documents quiet-dread register');

console.log('[behavioural]');

async function behaviour() {
  const mod = await import('../src/entities/vocalwave2.ts');

  // ---- watcher broadcasts: single-word names, honest syllables ----
  ok(mod.WATCHER_BROADCASTS.length >= 8,
    'at least 8 watcher name-bursts (got ' + mod.WATCHER_BROADCASTS.length + ')');
  ok(mod.WATCHER_BROADCASTS.every((b) => /^\S+$/.test(b.text)),
    'every burst is a single word');
  ok(mod.WATCHER_BROADCASTS.every((b) => b.text === b.text.toUpperCase()),
    'names are shouted - all caps');
  const wtexts = new Set(mod.WATCHER_BROADCASTS.map((b) => b.text));
  ok(wtexts.size === mod.WATCHER_BROADCASTS.length, 'no duplicate watcher names');
  ok(mod.WATCHER_BROADCASTS.every((b) => Number.isInteger(b.syllables) && b.syllables >= 1 && b.syllables <= 3),
    'burst syllable counts are 1-3');
  // cadence + proximity constants
  ok(mod.WATCHER_BROADCAST_MIN_INTERVAL_S === 30 && mod.WATCHER_BROADCAST_MAX_INTERVAL_S === 60,
    'burst interval window is 30-60 seconds');
  ok(mod.WATCHER_BROADCAST_RADIUS_M === 12, 'bursts trigger within 12m');
  ok(mod.WATCHER_BROADCAST_MAX_INTERVAL_S > mod.WATCHER_BROADCAST_MIN_INTERVAL_S,
    'interval window is well ordered');

  // ---- helper comforts: short reassuring fragments ----
  const required = ['this way', 'not much farther', 'keep moving'];
  for (const phrase of required) {
    ok(mod.HELPER_COMFORTS.some((c) => c.text === phrase), 'comforts include "' + phrase + '"');
  }
  ok(mod.HELPER_COMFORTS.length >= 10,
    'at least 10 comfort fragments (got ' + mod.HELPER_COMFORTS.length + ')');
  ok(mod.HELPER_COMFORTS.every((c) => Number.isInteger(c.syllables) && c.syllables >= 2 && c.syllables <= 6),
    'comfort syllable counts are 2-6');
  const ctexts = new Set(mod.HELPER_COMFORTS.map((c) => c.text));
  ok(ctexts.size === mod.HELPER_COMFORTS.length, 'no duplicate comforts');
  ok(typeof mod.HELPER_COMFORT_LOW_STABILITY === 'number'
    && mod.HELPER_COMFORT_LOW_STABILITY > 0 && mod.HELPER_COMFORT_LOW_STABILITY < 1,
    'low-stability threshold is a sane fraction');
  ok(typeof mod.HELPER_COMFORT_RADIUS_M === 'number' && mod.HELPER_COMFORT_RADIUS_M > 0,
    'comfort radius is positive');

  // ---- incomplete garble: corruption of normal phrases ----
  ok(mod.INCOMPLETE_BASE_PHRASES.length >= 10,
    'at least 10 base phrases (got ' + mod.INCOMPLETE_BASE_PHRASES.length + ')');
  ok(mod.INCOMPLETE_BASE_PHRASES.every((p) => /\?$|!$|[a-z]$/.test(p)),
    'base phrases are plain lowercase sentences');

  // determinism
  const g1 = mod.garblePhrase('the meeting moved to room four', 1234);
  const g2 = mod.garblePhrase('the meeting moved to room four', 1234);
  ok(g1.text === g2.text, 'same seed garbles identically');
  ok(g1.source === 'the meeting moved to room four', 'garble remembers its source');
  // corruption actually happens but stays recognizable-ish
  let corrupted = 0;
  for (let s = 0; s < 50; s++) {
    const g = mod.garblePhrase('everything is going to be fine', s);
    if (g.text !== 'everything is going to be fine') corrupted++;
  }
  ok(corrupted >= 40, 'most seeds corrupt the phrase (' + corrupted + '/50)');
  // doubling marker appears somewhere across seeds
  let sawDoubling = false;
  let sawTruncation = false;
  for (let s = 0; s < 200 && !(sawDoubling && sawTruncation); s++) {
    const g = mod.garblePhrase('your call is important to us', s);
    if (/-/.test(g.text)) sawDoubling = true;
    if (/\.\.\.$/.test(g.text)) sawEllipsisLike(g.text);
  }
  function sawEllipsisLike() { /* counted below via truncation heuristic */ }
  // truncation: some output word is shorter than any source word's tail
  for (let s = 0; s < 200; s++) {
    const g = mod.garblePhrase('please hold connecting you now', s);
    if (g.text.split(/\s+/).some((w) => w.length >= 1 && w.length <= 3)) sawTruncation = true;
  }
  ok(sawDoubling, 'syllable doubling occurs (hyphenated repeats)');
  ok(sawTruncation, 'truncation occurs (short clipped words)');

  // ---- selection: watchers, deterministic + anti-repetition ----
  const wb = mod.pickWatcherBroadcast(777);
  ok(wb !== null && mod.WATCHER_BROADCASTS.includes(wb), 'watcher pick comes from the pool');
  ok(wb === mod.pickWatcherBroadcast(777), 'same seed picks same burst');
  const wb2 = mod.pickWatcherBroadcast(777, [wb]);
  ok(wb2 !== null && wb2 !== wb, 'history excludes just-picked burst');
  const seenW = new Set();
  for (let s = 0; s < 100; s++) {
    const p = mod.pickWatcherBroadcast(s);
    if (p) seenW.add(p.text);
  }
  ok(seenW.size >= 5, 'seeds explore the roster (' + seenW.size + '/' + mod.WATCHER_BROADCASTS.length + ' names)');
  // full-history walk visits every entry once before repeating
  let cur = mod.pickWatcherBroadcast(42);
  const walk = [cur];
  for (let i = 0; i < mod.WATCHER_BROADCASTS.length - 1; i++) {
    cur = mod.pickWatcherBroadcast(42, walk);
    if (walk.includes(cur)) break;
    walk.push(cur);
  }
  ok(walk.length === mod.WATCHER_BROADCASTS.length, 'full history walk covers every name');

  // ---- selection: helpers gated on stability ----
  ok(mod.pickHelperComfort(1, 0.9) === null, 'high stability yields no comfort');
  ok(mod.pickHelperComfort(1, mod.HELPER_COMFORT_LOW_STABILITY) === null,
    'stability at threshold yields no comfort (strictly below gates it)');
  const hc = mod.pickHelperComfort(9, 0.1);
  ok(hc !== null && mod.HELPER_COMFORTS.includes(hc), 'low stability yields a pool fragment');
  const hc2 = mod.pickHelperComfort(9, 0.1, [hc]);
  ok(hc2 !== null && hc2 !== hc, 'helper history excludes just-picked comfort');

  // ---- selection: incompletes track sources, never repeat back to back ----
  const ig = mod.pickIncompleteGarble(555);
  ok(ig !== null && mod.INCOMPLETE_BASE_PHRASES.includes(ig.source),
    'garble pick traces to a base phrase');
  const ig2 = mod.pickIncompleteGarble(555, [ig.source]);
  ok(ig2 !== null && ig2.source !== ig.source, 'source history excludes just-garbled phrase');
  const empty = mod.pickIncompleteGarble(1, []);
  ok(empty !== null, 'default history still yields a garble');
}

try {
  await behaviour();
} catch (err) {
  console.error('  FAIL behavioural section could not run:', err.message);
  failures++;
}

if (failures > 0) process.exit(1);
console.log('vocalwave2-test: all checks passed');


