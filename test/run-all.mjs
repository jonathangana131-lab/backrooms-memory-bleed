/**
 * Full-suite runner — runs every test/*.mjs (except itself) with bounded
 * concurrency and prints a PASS/FAIL/SKIP ledger plus a final summary line.
 *
 * Usage: node test/run-all.mjs [filter-substring]
 * Exit 0 iff every non-skipped test exits 0. Skips require the test to print
 * a line containing 'SKIP(defect)' or 'SKIP(env)' (documented environment
 * limitation), otherwise a non-zero exit is a failure.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .filter((f) => f.includes(filter))
  .sort();

const CONCURRENCY = Number(process.env.RUN_ALL_JOBS || 6);
const results = [];
let cursor = 0;

function runOne(file) {
  const t0 = Date.now();
  const r = spawnSync('node', [path.join(here, file)], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    timeout: 240000,
    env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const skipped = /SKIP\((defect|env)\)/.test(out);
  const status = r.status === 0 ? 'PASS' : skipped ? 'SKIP' : 'FAIL';
  return { file, status, ms: Date.now() - t0, code: r.status, tail: out.slice(-1200) };
}

async function worker() {
  while (cursor < files.length) {
    const i = cursor++;
    results[i] = runOne(files[i]);
    process.stdout.write(`[${results[i].status}] ${files[i]} (${results[i].ms}ms)\n`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const pass = results.filter((r) => r.status === 'PASS');
const skip = results.filter((r) => r.status === 'SKIP');
const fail = results.filter((r) => r.status === 'FAIL');
for (const f of fail) {
  console.log(`\n=== FAIL ${f.file} (exit ${f.code}) ===\n${f.tail}`);
}
console.log(`\nRUN_ALL_SUMMARY total=${results.length} pass=${pass.length} skip=${skip.length} fail=${fail.length}`);
if (fail.length) {
  console.log('RUN_ALL_FAIL_LIST ' + fail.map((f) => f.file).join(' '));
  process.exit(1);
}
console.log('RUN_ALL_PASS');
