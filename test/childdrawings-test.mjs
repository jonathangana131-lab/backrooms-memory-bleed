/**
 * Child drawings tests (src/entities/childdrawings.ts, F65).
 * Standalone (no browser): transpiles rng.ts + childdrawings.ts into a temp
 * dir and drives the generator directly, same idiom as tourguide-test.
 *
 * Acceptance:
 *   1. event grounding - every generated drawing maps 1:1 to a real ledger
 *      entry (sceneKind + sourceSiteKey + whenSec provenance, injective);
 *   2. empty ledger - zero drawings anywhere;
 *   3. playground proximity gate - every drawing hangs within
 *      SCATTER_RADIUS_M of some playground center; events resolving far
 *      from every playground or to unknown sites never spawn anything;
 *   4. cap + density scaling - local event count drives drawing count up to
 *      exactly MAX_PER_PLAYGROUND and no further;
 *   5. determinism - same inputs replay byte-identical sets; seeds
 *      decorrelate scribble placement;
 *   6. serialize round-trip - serialize → JSON text → restore reproduces
 *      the exact set without touching the resolver seam;
 *   7. fail-loud - junk deps and corrupt save data throw.
 *
 * Run: node test/childdrawings-test.mjs
 */
import ts from 'typescript';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failures = 0;
function check(name, ok, extra = '') {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + extra));
  if (!ok) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-childdraw-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/entities'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/entities/childdrawings.ts', 'src/entities/childdrawings.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const cd = await import(pathToFileURL(path.join(tmp, 'src/entities/childdrawings.mjs')).href);

// ---- fixture -----------------------------------------------------------------

const PLAYGROUNDS = [
  { key: 'pg-a', x: 0, z: 0 },
  { key: 'pg-b', x: 100, z: 100 },
];
// Site map: one near pg-a, one near pg-b, one far from everything, one unknown.
const SITES = {
  yardA: { x: 8, z: 4 },     // ~8.9 m from pg-a
  nearB: { x: 95, z: 95 },   // ~7.1 m from pg-b
  far: { x: 500, z: 500 },
  ghost: null,
};

function makeResolver() {
  return (key) => (key in SITES ? SITES[key] : null);
}

function ev(kind, siteKey, whenSec) {
  return { kind, siteKey, whenSec };
}

function makeDeps(seed, events, extra = {}) {
  return { seed, events, playgrounds: PLAYGROUNDS, resolveSite: makeResolver(), ...extra };
}

// ---- 1. event grounding --------------------------------------------------------
{
  const events = [
    ev('relocation', 'yardA', 12),
    ev('blackout', 'yardA', 60),
    ev('beacon-found', 'nearB', 130),
    ev('entity-fled', 'far', 200), // links to no playground
    ev('relocation', 'ghost', 240), // unresolvable site
  ];
  const gen = new cd.ChildDrawings(makeDeps(1234, events));
  const ds = [...gen.drawings];

  // Every drawing cites a REAL event: kind + siteKey + whenSec all match, and
  // the mapping is injective (no fabricated duplicates).
  const pool = [...events];
  let grounded = true;
  for (const d of ds) {
    const idx = pool.findIndex((e) =>
      e.kind === d.sceneKind && e.siteKey === d.sourceSiteKey && e.whenSec === d.whenSec);
    if (idx === -1) { grounded = false; break; }
    pool.splice(idx, 1); // consume: 1:1
  }
  check('F65 grounding: every drawing maps 1:1 to a real ledger event',
    grounded && ds.length > 0, `drawings=${ds.length}`);
  check('F65 grounding: events far from playgrounds / on unknown sites spawn NOTHING',
    !ds.some((d) => d.sourceSiteKey === 'far' || d.sourceSiteKey === 'ghost'));
  check('F65 grounding: sceneKind is always a catalog kind',
    ds.every((d) => cd.EVENT_KINDS.includes(d.sceneKind)));
  check('F65 grounding: scribbleSeeds are finite and stable per drawing',
    ds.every((d) => Number.isFinite(d.scribbleSeed)));
}

// ---- 2. empty ledger --------------------------------------------------------------
{
  const gen = new cd.ChildDrawings(makeDeps(7, []));
  check('F65 empty-ledger: zero drawings with an empty ledger', gen.drawings.length === 0);

  // Also: no playgrounds means nowhere lawful to spawn.
  const gen2 = new cd.ChildDrawings(makeDeps(7, [ev('blackout', 'yardA', 5)], { playgrounds: [] }));
  check('F65 empty-ledger: zero drawings with no playground landmarks',
    gen2.drawings.length === 0);
}

// ---- 3. playground proximity gate ---------------------------------------------------
{
  const events = [
    ev('relocation', 'yardA', 10),
    ev('entity-fled', 'nearB', 20),
    ev('beacon-found', 'far', 30),
  ];
  const ds = [...new cd.ChildDrawings(makeDeps(55, events)).drawings];
  const nearSomePlayground = (x, z) => PLAYGROUNDS.some((p) =>
    Math.hypot(x - p.x, z - p.z) <= cd.SCATTER_RADIUS_M + 1e-9);
  check('F65 proximity: every drawing sits within SCATTER_RADIUS_M of its playground center',
    ds.length >= 2 && ds.every((d) =>
      PLAYGROUNDS.some((p) => p.key === d.playgroundKey) && nearSomePlayground(d.x, d.z)),
    `ds=${ds.map((d) => `${d.playgroundKey}@${d.x.toFixed(2)},${d.z.toFixed(2)}`).join(' ')}`);
  // The far-site event grounded nowhere: exactly two playground keys appear.
  check('F65 proximity: drawings carry their grounding playground key',
    new Set(ds.map((d) => d.playgroundKey)).size === 2);
}

// ---- 4. cap + density scaling ---------------------------------------------------------
{
  const many = [];
  for (let i = 0; i < 9; i++) many.push(ev(i % 2 ? 'blackout' : 'relocation', 'yardA', 100 + i));
  const capped = [...new cd.ChildDrawings(makeDeps(88, many)).drawings];
  check(`F65 cap: 9 local events yield exactly MAX_PER_PLAYGROUND=${cd.MAX_PER_PLAYGROUND} drawings`,
    capped.length === cd.MAX_PER_PLAYGROUND &&
    capped.every((d) => d.playgroundKey === 'pg-a'));

  const few = many.slice(0, 2);
  const sparse = [...new cd.ChildDrawings(makeDeps(88, few)).drawings];
  check('F65 density: fewer local events yield proportionally fewer drawings',
    sparse.length === 2);

  // Monotone across the ladder 1..cap..over.
  let monotone = true;
  let prevN = 0;
  for (let n = 1; n <= 12; n++) {
    const ledger = [];
    for (let i = 0; i < n; i++) ledger.push(ev('entity-fled', 'nearB', 300 + i));
    const got = [...new cd.ChildDrawings(makeDeps(88, ledger)).drawings].length;
    if (got !== Math.min(n, cd.MAX_PER_PLAYGROUND)) { monotone = false; break; }
    prevN = got;
  }
  void prevN;
  check('F65 density: count scales 1:1 with local events until the cap flattens it', monotone);

  // Split across two playgrounds: each gets its own capped budget.
  const split = [
    ...Array.from({ length: 7 }, (_, i) => ev('relocation', 'yardA', 400 + i)),
    ...Array.from({ length: 3 }, (_, i) => ev('beacon-found', 'nearB', 450 + i)),
  ];
  const both = [...new cd.ChildDrawings(makeDeps(88, split)).drawings];
  const perA = both.filter((d) => d.playgroundKey === 'pg-a').length;
  const perB = both.filter((d) => d.playgroundKey === 'pg-b').length;
  check('F65 density: budgets are per-playground, not global',
    perA === cd.MAX_PER_PLAYGROUND && perB === 3, `a=${perA} b=${perB}`);
}

// ---- 5. determinism --------------------------------------------------------------------
{
  const events = [
    ev('relocation', 'yardA', 12),
    ev('blackout', 'yardA', 60),
    ev('beacon-found', 'nearB', 130),
    ev('entity-fled', 'nearB', 190),
  ];
  const a = JSON.stringify([...new cd.ChildDrawings(makeDeps(999, events)).drawings]);
  const b = JSON.stringify([...new cd.ChildDrawings(makeDeps(999, events)).drawings]);
  check('F65 determinism: same seed + ledger replays byte-identical sets', a === b);

  const variants = new Set();
  for (let seed = 0; seed < 30; seed++) {
    variants.add(JSON.stringify([...new cd.ChildDrawings(makeDeps(seed, events)).drawings]));
  }
  check('F65 determinism: seeds decorrelate (scatter/captions spread)',
    variants.size > 10, `distinct=${variants.size}`);
}

// ---- 6. serialize round-trip ---------------------------------------------------------------
{
  const events = [
    ev('relocation', 'yardA', 12),
    ev('entity-fled', 'nearB', 77),
    ev('blackout', 'yardA', 91),
    ev('beacon-found', 'yardA', 140),
    ev('relocation', 'nearB', 180),
    ev('entity-fled', 'yardA', 220),
    ev('blackout', 'nearB', 260),
  ];
  const orig = new cd.ChildDrawings(makeDeps(2024, events));
  const saved = orig.serialize();

  // Restored WITHOUT any resolver or ledger access — pure persisted evidence.
  const twin = cd.ChildDrawings.restore(JSON.parse(JSON.stringify(saved)));
  const ta = JSON.stringify(orig.serialize());
  const tb = JSON.stringify(twin.serialize());
  check('F65 round-trip: serialize → JSON text → restore reproduces the exact set',
    ta === tb && tb === JSON.stringify(saved) && orig.drawings.length >= cd.MAX_PER_PLAYGROUND,
    `n=${orig.drawings.length}`);
}

// ---- 7. fail-loud ------------------------------------------------------------------------------
{
  let threw = 0;
  const tryThrow = (fn) => { try { fn(); } catch { threw++; } };
  const okEvents = [ev('relocation', 'yardA', 1)];

  tryThrow(() => new cd.ChildDrawings(null));
  tryThrow(() => new cd.ChildDrawings(makeDeps(NaN, okEvents)));
  tryThrow(() => new cd.ChildDrawings({ seed: 1, playgrounds: [], resolveSite: makeResolver() }));
  tryThrow(() => new cd.ChildDrawings(makeDeps(1, [{ kind: 'picnic', siteKey: 'yardA', whenSec: 1 }])));
  tryThrow(() => new cd.ChildDrawings(makeDeps(1, [{ kind: 'blackout', siteKey: '', whenSec: 1 }])));
  tryThrow(() => new cd.ChildDrawings(makeDeps(1, [{ kind: 'blackout', siteKey: 'yardA', whenSec: Infinity }])));
  tryThrow(() => new cd.ChildDrawings(makeDeps(1, okEvents, {
    playgrounds: [{ key: 'dup', x: 0, z: 0 }, { key: 'dup', x: 5, z: 5 }],
  })));
  tryThrow(() => new cd.ChildDrawings(makeDeps(1, okEvents, { playgrounds: [{ key: 'p', x: NaN, z: 0 }] })));
  tryThrow(() => new cd.ChildDrawings({ seed: 1, events: [], playgrounds: [] })); // no resolver

  // Restore junk.
  tryThrow(() => cd.ChildDrawings.restore(undefined));
  tryThrow(() => cd.ChildDrawings.restore([1, 2]));
  tryThrow(() => cd.ChildDrawings.restore({ version: 99, seed: 1, drawings: [] }));
  tryThrow(() => cd.ChildDrawings.restore({ version: 1, seed: NaN, drawings: [] }));
  tryThrow(() => cd.ChildDrawings.restore({ version: 1, seed: 1, drawings: 'nope' }));
  tryThrow(() => cd.ChildDrawings.restore({
    version: 1, seed: 1,
    drawings: [{ id: 'x', playgroundKey: 'p', sceneKind: 'picnic', sourceSiteKey: 's',
                 whenSec: 1, scribbleSeed: 2, x: 0, z: 0, captionFragment: '?' }],
  }));

  check('F65 fail-loud: 15 junk injections all throw', threw === 15, `threw=${threw}`);

  const healthy = new cd.ChildDrawings(makeDeps(1, okEvents));
  check('F65 fail-loud: healthy generator unaffected by rejected junk',
    healthy.drawings.length === 1);
}

console.log(failures === 0 ? 'CHILDDRAWINGS_PASS' : `CHILDDRAWINGS_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
