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

(Showing lines 1-25 of 103. Use offset=26 to continue.)

