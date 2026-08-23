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


