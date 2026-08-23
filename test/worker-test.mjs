/**
 * Worker infrastructure test (run: node test/worker-test.mjs)
 *
 * Verifies that the chunk-layout pipeline used by src/workers/layout.worker.ts:
 *   1. loads and runs off-thread (Node worker_threads running the SAME
 *      layout.worker.ts module, bundled with esbuild - the identical module
 *      Vite bundles for the browser);
 *   2. returns structurally valid ChunkLayouts through structured clone;
 *   3. is deterministic and byte-identical to main-thread generation;
 *   4. measures generation time: worker thread vs main thread.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// esbuild is a transitive dep of vite, so pnpm does not hoist it to the
// project node_modules root - locate it there explicitly.
function loadEsbuild() {
  try { return require('esbuild'); } catch { /* fall through */ }
  const nm = path.join(root, 'node_modules');
  const candidates = [];
  const pnpm = path.join(nm, '.pnpm');
  if (fs.existsSync(pnpm)) {
    for (const d of fs.readdirSync(pnpm)) {
      if (d.startsWith('esbuild@')) {
        candidates.push(path.join(pnpm, d, 'node_modules', 'esbuild'));
      }
    }
  }
  candidates.push(path.join(nm, 'esbuild'));
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error('esbuild not found under ' + nm + ' (is vite installed?)');
}
const esbuild = loadEsbuild();

const CHUNK_CELLS = 12;
const H_LEN = (CHUNK_CELLS + 1) * CHUNK_CELLS; // 156
const SEED = 1337;
const CHUNKS = [];
for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) CHUNKS.push([cx, cz]);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-worker-test-'));

  // ---- Bundle the REAL worker module for Node's worker_threads.
  // Shim: worker_threads has no `self`; bind it to the parent MessagePort so
  // the browser-targeted module runs unchanged (same onmessage/postMessage API).
  const workerOut = path.join(tmp, 'layout.worker.node.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/workers/layout.worker.ts')],
    bundle: true,

(Showing lines 1-60 of 172. Use offset=61 to continue.)

