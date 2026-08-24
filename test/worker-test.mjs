/**
 * Worker infrastructure test (run: node test/worker-test.mjs)
 *
 * RECOVERY NOTE: src/workers/layout.worker.ts was lost in transcript
 * recovery and has since been restored (pool-side protocol modules
 * src/workers/layoutPool.ts and src/workers/layoutCache.ts survived). The
 * original harness bundled the worker with esbuild; esbuild is not a project
 * dependency, so this suite uses Node-native TypeScript handling instead:
 *   - the worker entry plus its generation pipeline (architect.ts import
 *     closure) are transpiled to plain .mjs in a temp dir with the repo's own
 *     `typescript` package - the same transpile/strip idiom
 *     test/crackmesher-wiring-test.mjs uses - and executed OFF-THREAD in a
 *     real node worker_threads Worker;
 *   - the surviving shim intent is honored verbatim: worker_threads has no
 *     `self`, so self is bound to the parent MessagePort (and postMessage
 *     with it) BEFORE importing the real browser-targeted worker entry, whose
 *     onmessage/postMessage dialect then runs unchanged;
 *   - main-thread comparisons load the REAL TypeScript through vite's SSR
 *     loader, exactly like test/mesher-detail.mjs.
 *
 * Verifies that the chunk-layout pipeline used by the layout worker:
 *   1. loads and runs off-thread (node worker_threads running the SAME
 *      generateLayout pipeline Vite serves to the browser);
 *   2. returns structurally valid ChunkLayouts through structured clone;
 *   3. is deterministic and byte-identical to main-thread generation;
 *   4. measures generation time: worker thread vs main thread;
 *   5. honors the LayoutPool request/reply/caching/disposal contract.
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
const ts = require('typescript');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

// Transpile one src file into the temp tree, rewriting extensionless
// relative imports to .mjs (sibling idiom: crackmesher-wiring-test).
function makeEmitter(tmp) {
  return function emit(relTs) {
    const outRel = relTs.replace(/\.ts$/, '.mjs');
    const dest = path.join(tmp, outRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const js = ts.transpileModule(
      fs.readFileSync(path.join(root, relTs), 'utf8'),
      { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
    fs.writeFileSync(dest, fixed);
  };
}

// architect.ts import closure (verified against the tree): pure modules only,
// no browser globals - safe under plain node.
const PIPELINE_FILES = [
  'src/core/rng.ts',
  'src/world/constants.ts',
  'src/memory/field.ts',
  'src/content/tags.ts',
  'src/content/morenotes.ts',
  'src/content/notewave3.ts',
  'src/content/notes-wave1.ts',
  'src/content/notes-wave2.ts',
  'src/content/notes-wave3.ts',
  'src/content/clusters.ts',
  'src/content/graffiti-pool.ts',
  'src/world/architect.ts',
  'src/world/pocketdim.ts',
  'src/world/mezzanine.ts',
  'src/world/longhall.ts',
  'src/world/crawlspaces.ts',
  'src/workers/layout.worker.ts',
];

/**
 * Node bootstrap run inside worker_threads. The shim binds `self` to the
 * parent MessagePort (worker_threads has no `self`, and no global
 * postMessage) BEFORE importing the real browser-targeted worker entry, so
 * its onmessage/postMessage dialect runs unchanged - the exact intent the
 * surviving fragment documented.
 */
const BOOTSTRAP_SOURCE = `
import { parentPort } from 'node:worker_threads';

// Shim: worker_threads has no \`self\`; bind it to the parent MessagePort so
// the browser-targeted module runs unchanged (same onmessage/postMessage API).
globalThis.self = parentPort;
globalThis.postMessage = (...args) => parentPort.postMessage(...args);

await import('./src/workers/layout.worker.mjs');
`;

const CHUNK_CELLS = 12;
const H_LEN = (CHUNK_CELLS + 1) * CHUNK_CELLS; // 156
const V_LEN = CHUNK_CELLS * (CHUNK_CELLS + 1); // 156
const SEED = 1337;
const CHUNKS = [];
for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) CHUNKS.push([cx, cz]);

/** Structural validity per the ChunkLayout contract the mesher relies on. */
function isValidLayoutShape(l) {
  return l && typeof l === 'object' &&
    typeof l.cx === 'number' && typeof l.cz === 'number' &&
    l.hEdges instanceof Uint8Array && l.hEdges.length === H_LEN &&
    l.vEdges instanceof Uint8Array && l.vEdges.length === V_LEN &&
    ['lights', 'props', 'signs', 'notes', 'puddles', 'wires', 'stains', 'graffiti']
      .every((f) => Array.isArray(l[f])) &&
    typeof l.memKind === 'number' && typeof l.memIntensity === 'number';
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-worker-test-'));
  const emit = makeEmitter(tmp);
  for (const f of PIPELINE_FILES) emit(f);

  // ---- Run the REAL worker entry for Node's worker_threads (bootstrap
  // above; see RECOVERY NOTE in the header for why it is transpiled instead
  // of bundled).
  const workerOut = path.join(tmp, 'layout.worker.node.mjs');
  fs.writeFileSync(workerOut, BOOTSTRAP_SOURCE);

  const worker = new Worker(workerOut);
  const replies = new Map();
  let workerError = null;
  worker.on('message', (m) => replies.set(m.id, m));
  worker.on('error', (e) => { workerError = e; });

  function request(seed, cx, cz) {
    const id = replies.size + 1;
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const poll = () => {
        if (workerError) return reject(workerError);
        const m = replies.get(id);
        if (m) return resolve({ reply: m, ms: performance.now() - t0 });
        setImmediate(poll);
      };
      worker.postMessage({ id, seed, cx, cz });
      poll();
    });
  }

  try {
    // ---- 1./2. off-thread run returning structurally valid layouts ----------
    const results = [];
    let allValid = true;
    for (const [cx, cz] of CHUNKS) {
      const { reply } = await request(SEED, cx, cz);
      if (!('layout' in reply) || !isValidLayoutShape(reply.layout)) {
        allValid = false;
        break;
      }
      results.push(reply.layout);
    }
    check('worker answers every chunk request off-thread without crashing',
      workerError === null && results.length === CHUNKS.length,
      String(workerError));
    check('every worker reply is a structurally valid ChunkLayout', allValid);
    check('edge buffers carry the documented sample counts',
      results.length > 0 &&
      results.every((l) => l.hEdges.length === H_LEN && l.vEdges.length === V_LEN));

    // structured clone already happened (postMessage); prove byte survival
    const probe = results[0];
    const clone = structuredClone(probe);
    check('payload survives a second structured clone byte-identically',
      clone.cx === probe.cx && Buffer.from(clone.hEdges).equals(Buffer.from(probe.hEdges)) &&
      Buffer.from(clone.vEdges).equals(Buffer.from(probe.vEdges)));

    // ---- 3. deterministic + byte-identical to main-thread generation -------
    const [px, pz] = CHUNKS[0];
    const again = await request(SEED, px, pz);
    check('two identical worker requests return identical payloads',
      JSON.stringify(again.reply.layout) === JSON.stringify(probe));

    const { createServer } = await import('vite');
    const server = await createServer({
      root,
      logLevel: 'error',
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
    });
    try {
      const { generateLayout } = await server.ssrLoadModule('/src/world/architect.ts');
      let matchesMain = true;
      for (let i = 0; i < results.length; i++) {
        const [cx, cz] = CHUNKS[i];
        const mainLayout = generateLayout(SEED, cx, cz);
        if (JSON.stringify(mainLayout) !== JSON.stringify(results[i])) {
          matchesMain = false;
          break;
        }
      }
      check('worker output is byte-identical to main-thread generation',
        matchesMain);

      // ---- 4. timing: worker thread vs main thread -------------------------
      const mainT0 = performance.now();
      for (const [cx, cz] of CHUNKS) generateLayout(SEED, cx, cz);
      const mainMs = performance.now() - mainT0;
      const wT0 = performance.now();
      for (const [cx, cz] of CHUNKS) await request(SEED, cx, cz);
      const workerMs = performance.now() - wT0;
      check('timing captured for worker vs main-thread generation',
        Number.isFinite(workerMs) && Number.isFinite(mainMs),
        'worker=' + workerMs.toFixed(1) + 'ms main=' + mainMs.toFixed(1) + 'ms');
      console.log('  timing: worker thread ' + workerMs.toFixed(1) +
        ' ms | main thread ' + mainMs.toFixed(1) + ' ms (25 chunks)');

      // ---- validation gate: the cache only stores conforming payloads ------
      const { LayoutCache } = await server.ssrLoadModule('/src/workers/layoutCache.ts');
      const cache = new LayoutCache(SEED);
      await cache.put(results[0]);
      check('conforming worker payload enters the layout cache',
        cache.get(px, pz) === results[0]);
      const garbage = { ...results[1], hEdges: new Uint8Array(3) };
      await cache.put(garbage);
      check('structurally invalid payloads are rejected, not cached',
        !cache.has(CHUNKS[1][0], CHUNKS[1][1]));
      const poisoned = JSON.parse(JSON.stringify(results[2], (k, v) =>
        v instanceof Uint8Array ? Array.from(v) : v));
      poisoned.hEdges = new Uint8Array(poisoned.hEdges);
      delete poisoned.memKind;
      await cache.put(poisoned);
      check('payloads missing required fields never enter the cache',
        !cache.has(CHUNKS[2][0], CHUNKS[2][1]));
    } finally {
      await server.close();
    }
  } finally {
    await worker.terminate();
  }

  // ---- 5. LayoutPool request/reply/caching/disposal contract ---------------
  // The pool constructs its workers lazily against the (lost) worker bundle,
  // so inject a Worker double and drive the protocol by hand - this tests the
  // pool-side message handling directly in-thread, per the fallback the
  // header documents.
  class FakeWorker {
    constructor() {
      this.sent = [];
      this.onmessage = null;
      this.onerror = null;
      this.terminated = false;
      POOL_WORKERS.push(this);
    }
    postMessage(msg) { this.sent.push(msg); }
    terminate() { this.terminated = true; }
  }
  const POOL_WORKERS = [];
  globalThis.Worker = FakeWorker;

  try {
    const { createServer: cs2 } = await import('vite');
    const srv = await cs2({
      root,
      logLevel: 'error',
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
    });
    try {
      const { LayoutPool, WORKER_COUNT } = await srv.ssrLoadModule('/src/workers/layoutPool.ts');
      check('pool spawns the documented worker count',
        WORKER_COUNT === 2);

      const pool = new LayoutPool(WORKER_COUNT);
      check('constructed pool holds every slot', pool.size === WORKER_COUNT);

      const mkLayout = (n) => ({ tag: 'layout-' + n });
      const r1 = pool.requestLayout(SEED, 1, 2);
      const r2 = pool.requestLayout(SEED, 3, 4);
      check('requests dispatch round-robin across slots',
        POOL_WORKERS[0].sent.length === 1 && POOL_WORKERS[1].sent.length === 1,
        JSON.stringify(POOL_WORKERS.map((w) => w.sent.length)));
      check('request messages follow the LayoutRequest protocol',
        POOL_WORKERS[0].sent[0].seed === SEED &&
        POOL_WORKERS[0].sent[0].cx === 1 && POOL_WORKERS[0].sent[0].cz === 2 &&
        typeof POOL_WORKERS[0].sent[0].id === 'number' &&
        POOL_WORKERS[0].sent[0].id !== POOL_WORKERS[1].sent[0].id);

      // correlation-id echo routes the reply back to its own promise
      const idA = POOL_WORKERS[0].sent[0].id;
      POOL_WORKERS[0].onmessage({ data: { id: idA, layout: mkLayout('a') } });
      check('matching correlation id resolves with the replied layout',
        (await r1).tag === 'layout-a');

      // error replies reject
      const rErr = pool.requestLayout(SEED, 5, 6);
      const sentTo = POOL_WORKERS.find((w) => w.sent.length === 2);
      const idE = sentTo.sent[1].id;
      sentTo.onmessage({ data: { id: idE, error: 'generation exploded' } });
      let errText = '';
      try { await rErr; } catch (e) { errText = String(e.message); }
      check('error replies reject their request',
        errText.includes('layout worker') && errText.includes('generation exploded'),
        errText);

      // unknown ids are ignored, not thrown
      let survivedUnknown = true;
      try {
        POOL_WORKERS[0].onmessage({ data: { id: 99999, layout: {} } });
      } catch { survivedUnknown = false; }
      check('replies with unknown ids are ignored', survivedUnknown);

      // Completed layouts are cached by 'cx,cz' on resolve, so a repeat
      // request is served from cache without re-dispatching to any worker.
      const beforeTraffic = POOL_WORKERS.map((w) => w.sent.length);
      const repeat = pool.requestLayout(SEED, 1, 2);
      check('repeat requests are served from cache without re-dispatch',
        POOL_WORKERS.reduce((n, w) => n + w.sent.length, 0) ===
          beforeTraffic.reduce((n, m) => n + m, 0),
        JSON.stringify(POOL_WORKERS.map((w) => w.sent.length)));
      check('repeat request resolves with the originally replied layout',
        (await repeat).tag === 'layout-a');
      const cached = pool.peek(1, 2);
      check('peek returns the cached layout once resolved',
        cached !== undefined && cached.tag === 'layout-a');
      check('failed requests never enter the request cache',
        pool.peek(5, 6) === undefined);
      let clearThrew = false;
      try { pool.clearCache(); } catch { clearThrew = true; }
      check('clearCache runs without touching workers',
        !clearThrew && POOL_WORKERS.every((w) => !w.terminated));
      check('clearCache empties the request cache', pool.peek(1, 2) === undefined);

      // worker-level crash fails every outstanding request routed there
      const rCrash = pool.requestLayout(SEED, 7, 8);
      const crashed = POOL_WORKERS.find((w) => w.sent[w.sent.length - 1].cx === 7);
      crashed.onerror({ message: 'bundle exploded' });
      let crashText = '';
      try { await rCrash; } catch (e) { crashText = String(e.message); }
      check('worker-level crash rejects outstanding requests',
        crashText.includes('crashed') && crashText.includes('bundle exploded'),
        crashText);

      // disposal rejects in-flight work and terminates every worker
      const rDisp = pool.requestLayout(SEED, 9, 9);
      pool.dispose();
      let dispText = '';
      try { await rDisp; } catch (e) { dispText = String(e.message); }
      check('dispose rejects in-flight requests', dispText.includes('disposed'), dispText);
      check('dispose terminates every pooled worker',
        POOL_WORKERS.every((w) => w.terminated));
    } finally {
      delete globalThis.Worker;
      await srv.close();
    }
  } finally {
    delete globalThis.Worker;
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nALL TESTS PASS' : '\nFAILURES: ' + failures);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.log('FATAL ' + (e && e.stack ? e.stack : String(e)));
    process.exit(1);
  });
