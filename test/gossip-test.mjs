/*
 * F29 Entity gossip tests -- pure Node, no browser.
 * Drives GossipSource against a fixture visit ledger and checks:
 *   1. grounding vs journal-style feed: 200+ generated lines, 100% of
 *      referenced site names come from the ledger (key + verbatim name)
 *   2. empty ledger is silence-safe: zero lines emitted
 *   3. determinism per seed: same seed replays identically, different
 *      seed diverges
 *   4. dedup: no identical line twice within GOSSIP_DEDUP_WINDOW draws
 *   5. recency weighting: recently visited sites are named more often
 *
 * The TS module is bundled with esbuild so its '../core/rng' import
 * resolves under plain Node (same loader as pairvocals-test). The
 * './humans' import is type-only and erased by the bundler.
 */
import { createRequire } from 'node:module';
import { writeFileSync, readdirSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const pnpmDir = process.cwd() + '/node_modules/.pnpm';
    const entry = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
    if (!entry) throw new Error('esbuild not found in node_modules');
    return require_(pnpmDir + '/' + entry + '/node_modules/esbuild');
  }
}
const esbuild = loadEsbuild();
const BUILT = process.cwd() + '/test/.gossip-build.mjs';
const bundle = await esbuild.build({
  entryPoints: [process.cwd() + '/src/entities/gossip.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  write: false,
});
writeFileSync(BUILT, bundle.outputFiles[0].text);
const { GossipSource, GOSSIP_DEDUP_WINDOW } = await import('./.gossip-build.mjs');

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' -- ' + detail));
  if (!cond) failures.push(name);
}

// ---- fixture ledger (journal-feed spirit: real sites the player visited) -----
const LEDGER = [
  { siteKey: 'chunk-3,-2/atrium', kind: 'landmark', name: 'Atrium Nine', lastVisitedAt: 900 },
  { siteKey: 'chunk-1,4/vending', kind: 'utility', name: 'the Vending Alcove', lastVisitedAt: 950 },
  { siteKey: 'chunk-0,0/hall-h', kind: 'corridor', name: 'Hall H', lastVisitedAt: 400 },
  { siteKey: 'chunk-2,2/copier', kind: 'utility', name: 'the Copier Room', lastVisitedAt: 100 },
  { siteKey: 'chunk-5,1/loadingdock', kind: 'landmark', name: 'the Loading Dock', lastVisitedAt: 880 },
  { siteKey: 'chunk-4,3/stairwell', kind: 'corridor', name: 'Stairwell B', lastVisitedAt: 20 },
];
const SPEAKERS = ['watcher', 'wanderer', 'helper', 'incomplete', 'believer', 'double'];
const NOW_TICK = 1000;

/** Journal-style sink: files a gossip line only when it grounds in the ledger. */
class GossipFeed {
  constructor(ledger) {
    this.byKey = new Map(ledger.map((s) => [s.siteKey, s]));
    this.accepted = 0;
    this.rejected = 0;
  }
  addLine(line) {
    const site = this.byKey.get(line.siteKey);
    if (site && line.text.includes(site.name) && !line.text.includes('{site}')) {
      this.accepted++;
      return true;
    }
    this.rejected++;
    return false;
  }
}

// ---- 1: grounding --------------------------------------------------------------
{
  const src = new GossipSource(LEDGER, 1234567);
  const feed = new GossipFeed(LEDGER);
  const names = new Set(LEDGER.map((s) => s.name));
  const keys = new Set(LEDGER.map((s) => s.siteKey));
  let total = 0;
  let ungrounded = [];
  for (let i = 0; i < 240; i++) {
    const speaker = SPEAKERS[i % SPEAKERS.length];
    const line = src.generate(speaker, NOW_TICK);
    if (!line) continue;
    total++;
    feed.addLine(line);
    const named = [...names].filter((n) => line.text.includes(n));
    const okKey = keys.has(line.siteKey);
    const okName =
      named.length === 1 &&
      line.siteKey === LEDGER.find((s) => s.name === named[0]).siteKey;
    if (!okKey || !okName || line.text.includes('{site}')) {
      ungrounded.push(JSON.stringify(line));
    }
  }
  check('240 draws produce 200+ live lines', total >= 200, String(total));
  check('every emitted line grounds in the ledger (key + verbatim name)',
    ungrounded.length === 0, ungrounded.slice(0, 3).join(' | '));
  check('journal-style sink accepted 100% of lines, rejected none',
    feed.accepted === total && feed.rejected === 0,
    'accepted=' + feed.accepted + ' rejected=' + feed.rejected);

  check('siteCount reflects the injected ledger', src.siteCount === LEDGER.length);
}

// ---- 2: empty ledger silence-safety ---------------------------------------------
{
  const src = new GossipSource([], 42);
  let emitted = 0;
  for (const sp of SPEAKERS) {
    for (let i = 0; i < 20; i++) if (src.generate(sp, NOW_TICK)) emitted++;
  }
  check('empty ledger -> silence-safe (zero lines)', emitted === 0, String(emitted));
  check('empty ledger reports zero groundable sites', src.siteCount === 0);
}

// ---- 3: determinism per seed ------------------------------------------------------
{
  function script(seed) {
    const src = new GossipSource(LEDGER, seed);
    const out = [];
    for (let i = 0; i < 60; i++) {
      const line = src.generate(SPEAKERS[i % SPEAKERS.length], NOW_TICK - i);
      out.push(line ? line.text + '@' + line.siteKey : '<null>');
    }
    return out.join('\n');
  }
  check('same seed -> identical gossip transcript', script(777) === script(777));
  check('different seed -> divergent transcript', script(777) !== script(778));
  check('same seed, different tick sequence -> different recency mix',
    script(777) !== (() => {
      // replay with all sites equally recent changes the weighted picks
      const src = new GossipSource(
        LEDGER.map((s) => ({ ...s, lastVisitedAt: 0 })), 777);
      const out = [];
      for (let i = 0; i < 60; i++) {
        const line = src.generate(SPEAKERS[i % SPEAKERS.length], 0);
        out.push(line ? line.text + '@' + line.siteKey : '<null>');
      }
      return out.join('\n');
    })());
}

// ---- 4: dedup within N draws -------------------------------------------------------
{
  const src = new GossipSource(LEDGER, 20250824);
  const texts = [];
  for (let i = 0; i < 300; i++) {
    const line = src.generate(SPEAKERS[i % SPEAKERS.length], NOW_TICK);
    if (line) texts.push(line.text);
  }
  let dupInWindow = 0;
  const lastSeen = new Map();
  texts.forEach((t, idx) => {
    if (lastSeen.has(t) && idx - lastSeen.get(t) < GOSSIP_DEDUP_WINDOW) dupInWindow++;
    lastSeen.set(t, idx);
  });
  check('no repeated line within ' + GOSSIP_DEDUP_WINDOW + ' consecutive draws',
    dupInWindow === 0, String(dupInWindow));
}

// ---- 5: recency weighting ------------------------------------------------------------
{
  // two-site ledger: one just visited, one ancient. Across many draws the
  // fresh site should dominate (different templates keep dedup satisfiable).
  const duo = [
    { siteKey: 'fresh', kind: 'corridor', name: 'Fresh Corridor', lastVisitedAt: 999 },
    { siteKey: 'stale', kind: 'corridor', name: 'Ancient Corridor', lastVisitedAt: 0 },
  ];
  let fresh = 0;
  let stale = 0;
  const src = new GossipSource(duo, 555);
  for (let i = 0; i < 600; i++) {
    const line = src.generate(SPEAKERS[i % SPEAKERS.length], 1000);
    if (!line) continue;
    if (line.siteKey === 'fresh') fresh++;
    else stale++;
  }
  check('recently visited site dominates the draw', fresh > stale * 2,
    'fresh=' + fresh + ' stale=' + stale);
}

console.log(failures.length === 0
  ? '\nALL PASS'
  : '\n' + failures.length + ' FAILURE(S): ' + failures.join(', '));
process.exitCode = failures.length === 0 ? 0 : 1;
