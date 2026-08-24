/**
 * Minimal honest smoke for the checkpoint system's validation core
 * (src/story/checkpoints.ts). Replaces the recovered debug scratch whose only
 * surviving content was an in-memory IndexedDB fake — a harness variant now
 * maintained in working form inside test/checkpoints-test.mjs — so this file
 * exercises what the scratch existed to debug: record/name validation, via
 * vite's SSR loader (no build step or browser needed).
 *
 *   node test/.ckpt-debug.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log('  ok - ' + name);
  } else {
    failures++;
    console.error('FAIL - ' + name + (detail ? ' :: ' + detail : ''));
  }
}

const server = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});
try {
  const cp = await server.ssrLoadModule('/src/story/checkpoints.ts');

  // ---- validateName ----
  check('accepts letters/digits/spaces', cp.validateName('dark hallway 12') === 'dark hallway 12');
  check('trims and collapses whitespace', cp.validateName('  hub   north  ') === 'hub north');
  check('rejects punctuation', cp.validateName('save #1') === null);
  check('rejects empty', cp.validateName('   ') === null);
  check('rejects oversize (>32)', cp.validateName('x'.repeat(33)) === null);
  check('rejects non-string', cp.validateName(42) === null && cp.validateName(null) === null);

  // ---- validateRecord ----
  const slot = { seed: 7, px: 1.5, pz: -2.5 };
  const good = { name: 'ok', savedAt: 1234, slot };
  const r = cp.validateRecord(good);
  check('valid record passes through migrateSlot',
    !!r && r.name === 'ok' && r.savedAt === 1234 && r.slot.seed === 7 && r.slot.version === 2,
    JSON.stringify(r));
  check('legacy JSON string accepted',
    (() => { const j = cp.validateRecord(JSON.stringify(good)); return !!j && j.slot.pz === -2.5; })());
  check('unparseable JSON rejected', cp.validateRecord('{nope') === null);
  check('non-object rejected', cp.validateRecord([1, 2]) === null && cp.validateRecord(null) === null);
  check('missing savedAt rejected', cp.validateRecord({ name: 'x', slot }) === null);
  check('slot failing migration rejected', cp.validateRecord({ name: 'x', savedAt: 5, slot: { px: 0 } }) === null);
} finally {
  await server.close();
}

if (failures > 0) {
  console.error('\n' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('\nCheckpoint validation smoke passed.');
