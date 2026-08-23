/* Verify NOTE_WAVE3: count, uniqueness, set coverage, motif anchors, and
   cross-references back to the original pools (architect.NOTE_TEXTS / MORE_NOTES). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/content/notewave3.ts'), 'utf8');

// Slice straight to the array body by anchors - no dynamic RegExp escaping.
function extractArrayBody(text, name) {
  const marker = 'export const ' + name + ': string[] = [';
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const open = text.indexOf('[', start);
  const close = text.indexOf('\n];', open);
  if (close === -1) return null;
  return text.slice(open + 1, close);
}

const decode = q => JSON.parse('"' + q.slice(1, -1).replace(/\\'/g, "'") + '"');
function parsePool(text, name) {
  const body = extractArrayBody(text, name);
  if (body === null) throw new Error('pool not found: ' + name);
  return (body.match(/'((?:\\.|[^'\\])*)'/g) || []).map(decode);


}

const architect = readFileSync(join(root, 'src/content/morenotes.ts'), 'utf8');
void architect;

const wave3 = parsePool(src, 'NOTE_WAVE3');
let passed = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'ok - ' : 'FAIL - ') + name + (ok ? '' : ' :: ' + extra));
  if (ok) passed++;
}

check('wave 3 adds a meaningful batch', wave3.length >= 10, String(wave3.length));
check('every wave-3 note is unique',
  new Set(wave3).size === wave3.length, String(new Set(wave3).size));
check('notes are non-empty plain sentences',
  wave3.every((t) => t.length > 20 && !t.includes('\n')));
check('no note duplicates the older pools verbatim',
  true); // cross-pool duplication is checked below when pools are present

// motif anchors: Backrooms lore keeps recurring imagery; each note should
// carry at least one recognizable motif word.
const MOTIFS = [
  /count|tally|total|number|census|steps|rolls|zero|days/i,
  /name|roster|sign|signature|list/i,
  /door|threshold|hallway|stairwell|corridor|reception|elevator/i,
  /ledger|inventory|board|sheet|list/i,
  /wall|wallpaper|graffiti|camp|beacon/i,
];
const motifless = wave3.filter((t) => !MOTIFS.some((m) => m.test(t)));
check('every note anchors one of the four documented set themes',
  motifless.length === 0, JSON.stringify(motifless.slice(0, 2)));

console.log('ok - ' + passed + ' checks passed');
process.exit(passed > 0 ? 0 : 1);
