/**
 * Unit tests for src/ui/journal.ts.
 *
 * journal.ts is TypeScript with DOM usage; we transpile it on the fly with
 * the repo's own typescript dependency, install a minimal fake document /
 * localStorage, and assert on the pure helpers plus the Journal class
 * state machine (open/close, collection, persistence, read marking).
 *
 * Run: node test/journal-test.mjs
 */
import ts from 'typescript';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'ui', 'journal.ts');
const outPath = path.join(here, '.journal.transpiled.mjs');

const src = readFileSync(srcPath, 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
writeFileSync(outPath, js);

/* ---------------- minimal fake DOM / storage ---------------- */



