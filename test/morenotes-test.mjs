/* Verify MORE_NOTES: count, uniqueness, voice anchors, and the Marlow triptych. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/content/morenotes.ts'), 'utf8');

const m = src.match(/export const MORE_NOTES: string\[\] = \[([\s\S]*)\];/);
if (!m) { console.error('FAIL: MORE_NOTES export not found'); process.exit(1); }

const raw = m[1].match(/'((?:\\.|[^'\\])*)'/g) || [];
const NOTES = raw.map(q => {
  let inner = q.slice(1, -1).replace(/\\'/g, "'");
  return JSON.parse('"' + inner + '"');
});

let fail = 0;
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++; } };

check(NOTES.length === 25, `expected 25 notes, got ${NOTES.length}`);
check(NOTES.every(n => typeof n === 'string' && n.trim().length > 0), 'all notes must be non-empty strings');
check(new Set(NOTES).size === NOTES.length, 'notes must be unique');

// Recurring proper nouns across the set.
for (const name of ['Reyes', 'Marlow', 'Halcyon']) {
  check(NOTES.some(n => n.includes(name)), `proper noun missing: ${name}`);
}

// Category spot-checks: 5 each of maintenance, letters, research, warnings, wrongness.


const cats = [
  [/^(MAINTENANCE|WORK ORDER|REQUEST|To facilities)/i, 'maintenance'],
  [/(Dear |Mom \u2014|Marlow,|my successor|Nadia,)/i, 'letters'],
  [/(OBSERVATION|Field study|RESEARCH|Interview transcript)/i, 'research'],
  [/(WARNING|crews following|find our camp|ADVISORY|expedition)/i, 'warnings'],
];
for (const [re, label] of cats) {
  const c = NOTES.filter(n => re.test(n)).length;
  check(c >= 5, `category ${label}: expected >= 5 matches, got ${c}`);
}

// Triptych: three notes across different categories telling one story
// (the sealed Halcyon door) via shared anchors, readable in any order.
const tri = NOTES.filter(n => /Marlow/.test(n) && /(warm|door|mortar|bricked)/i.test(n));
check(tri.length === 3, `triptych should be 3 interlocking notes, got ${tri.length}`);
check(tri.some(n => /Halcyon Corp/.test(n)), 'triptych must anchor to Halcyon Corp');
check(tri.some(n => /maintenance/i.test(n)), 'triptych member from maintenance category missing');
check(tri.some(n => /^Marlow,/i.test(n)), 'triptych letter member missing');
check(tri.some(n => /expedition/i.test(n)), 'triptych expedition-cache member missing');
// Each member must point at at least one other member's frame of reference.
const frames = [/(request|maintenance)/i, /(letter|bricked)/i, /(cache|maps|expedition)/i];
for (const n of tri) {
  check(frames.some(f => f.test(n)), `triptych note lacks a cross-frame anchor: ${n.slice(0, 40)}`);
}

if (fail > 0) { console.error(`MORENOTES_FAIL (${fail} failures)`); process.exit(1); }
console.log(`MORENOTES_OK: ${NOTES.length} notes, triptych intact`);


