/*
 * F26 + F32 + F61 social entities -- headless behavior-table tests.
 *
 * Bundles each pure module with esbuild so its imports resolve under
 * plain Node (same loader as archivist-test), then drives:
 *   F26 The Archivist  reaction table, cross-session persistence,
 *                      stand-off invariant, never-approaches.
 *   F32 The Custodian  removal table (oldest-first bounded plan, protected
 *                      kinds spared), squeak-precedes-removal ordering,
 *                      ledger completeness, wiring dedup/resurrection
 *                      guard, serialize/restore, deterministic replay.
 *   F61 The Hymn       lyric grounding vs the injected discovery ledger
 *                      (provenance ids; empty ledger hums wordless),
 *                      service gating by day phase, stagger determinism,
 *                      rolling dedup window.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';

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
const OUT = process.cwd() + '/test/.social-build';
await esbuild.build({
  entryPoints: [
    process.cwd() + '/src/entities/archivist.ts',
    process.cwd() + '/src/entities/custodian.ts',
    process.cwd() + '/src/entities/hymn.ts',
    process.cwd() + '/src/story/custodian.ts',
  ],
  bundle: true,
  format: 'esm',
  outdir: OUT,
});
// esbuild keeps each entry's path below its common root under the outdir
const { Archivist, reactionForPhotos, ARCHIVIST_STORE_PREFIX } = await import(OUT + '/entities/archivist.js');
const { CustodianWiring, graffitiMarkingId, parseGraffitiMarkingId } = await import(OUT + '/entities/custodian.js');
const { ChapelChoir, HYMN_LINE_INTERVAL_SEC } = await import(OUT + '/entities/hymn.js');
const { Custodian } = await import(OUT + '/story/custodian.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; } else { failed++; console.log('  FAIL ' + name); }
}
// ------------------------------------------------------------------
// F26 The Archivist -- reaction table
// ------------------------------------------------------------------
check('F26 0 photos -> shy', reactionForPhotos(0) === 'shy');
check('F26 1 photo -> curious', reactionForPhotos(1) === 'curious');
check('F26 3 photos -> curious', reactionForPhotos(3) === 'curious');
check('F26 4 photos -> receptive', reactionForPhotos(4) === 'receptive');
check('F26 40 photos -> receptive', reactionForPhotos(40) === 'receptive');
check('F26 negative clamps to shy', reactionForPhotos(-5) === 'shy');
check('F26 fractional floors', reactionForPhotos(3.9) === 'curious' && reactionForPhotos(0.5) === 'shy');

{
  // cross-session persistence through a JSON round trip
  const backing = {};
  const store = {
    get: (k) => (k in backing ? JSON.parse(backing[k]) : undefined),
    set: (k, v) => { backing[k] = JSON.stringify(v); },
  };
  const landmarks = [{ x: 10, z: 0 }, { x: -10, z: 0 }];
  const runA = new Archivist({ landmarks, store, runId: 'run-a', priorRunIds: [], seed: 12345 });
  check('F26 fresh session starts shy', runA.mood === 'shy');
  for (let i = 0; i < 2; i++) runA.photograph();
  check('F26 photos recorded this run', runA.photosThisRun === 2);
  const runB = new Archivist({ landmarks, store, runId: 'run-b', priorRunIds: ['run-a'], seed: 12345 });
  check('F26 next session curious after 2 photos', runB.mood === 'curious');
  for (let i = 0; i < 2; i++) runB.photograph();
  const runC = new Archivist({ landmarks, store, runId: 'run-c', priorRunIds: ['run-a', 'run-b'], seed: 12345 });
  check('F26 cumulative photos reach receptive tier', runC.mood === 'receptive');
  const runAResume = new Archivist({ landmarks, store, runId: 'run-a', priorRunIds: [], seed: 999 });
  check('F26 same-run resume restores tally', runAResume.photosThisRun === 2 && runAResume.mood === 'curious');
  check('F26 records stored under prefixed keys', Object.keys(backing).every((k) => k.startsWith(ARCHIVIST_STORE_PREFIX)));
}

{
  // stand-off invariant under direct pursuit across all three tiers
  const tiers = [['shy', 0], ['curious', 2], ['receptive', 6]];
  for (const [name, priorPhotos] of tiers) {
    const store = { get: () => ({ version: 1, photos: priorPhotos }), set: () => {} };
    const a = new Archivist({ landmarks: [{ x: 30, z: 30 }], store, runId: 'r', seed: 777, standoffRadius: 5 });
    let worst = Infinity;
    let px = a.body.x + a.standoff * 0.99;
    let pz = a.body.z;
    for (let t = 0; t < 600; t++) {
      px += Math.sign(a.body.x - px) * (4.4 / 60);
      pz += Math.sign(a.body.z - pz) * (4.4 / 60);
      a.update(1 / 60, px, pz, []);
      worst = Math.min(worst, Math.hypot(a.body.x - px, a.body.z - pz));
    }
    check('F26 stand-off holds under pursuit (' + name + ')', worst >= a.standoff - 1e-6);
  }
  const a2 = new Archivist({ landmarks: [{ x: 12, z: 0 }, { x: -12, z: 9 }], store: { get: () => undefined, set: () => {} }, runId: 'r2', seed: 42 });
  let closest = Infinity;
  for (let t = 0; t < 1800; t++) {
    a2.update(1 / 60, 0, 0, []);
    closest = Math.min(closest, Math.hypot(a2.body.x, a2.body.z));
  }
  check('F26 never approaches stationary player', closest >= a2.standoff - 1e-6);
}
// ------------------------------------------------------------------
// F32 The Custodian -- removal table (pass level)
// ------------------------------------------------------------------
{
  const freshMarkings = () => [
    { id: 'old-1', chunkKey: '0,0', appliedSession: 0, kind: 'graffiti' },
    { id: 'old-2', chunkKey: '0,0', appliedSession: 0, kind: 'stencil' },
    { id: 'mem-1', chunkKey: '1,0', appliedSession: 0, kind: 'memorial' }, // protected
    { id: 'new-1', chunkKey: '1,1', appliedSession: 5, kind: 'graffiti' },
    { id: 'new-2', chunkKey: '1,1', appliedSession: 7, kind: 'smear' },
  ];
  const markings = freshMarkings();
  const c = new Custodian(markings, { seed: 2024, sessionOrdinal: 3 });
  c.beginNight(0);
  for (let t = 0; t < 400; t++) c.update(1);
  check('F32 bounded removals per night', c.removals.length === 3);
  check('F32 oldest-first order', c.removals[0].markingId === 'old-1' || c.removals[0].markingId === 'old-2');
  check('F32 protected memorial spared', !c.removals.some((r) => r.markingId === 'mem-1'));
  check('F32 newest player marks survive bound', c.removals.every((r) => r.appliedSession <= 5));
  check('F32 ledger mutates injected list', !markings.some((m) => c.removals.some((r) => r.markingId === m.id)));
  for (const r of c.removals) {
    const cue = c.squeaks.find((s) => s.markingId === r.markingId);
    check('F32 squeak precedes removal (' + r.markingId + ')', !!cue && cue.atNightTime + cue.leadSeconds <= r.removedAtNightTime + 1e-9);
  }
  check('F32 one squeak per removal', c.squeaks.length === c.removals.length);
  // deterministic replay of the same night key (fresh ledger: the first
  // pass splices its own injected list)
  const markings2 = freshMarkings();
  const c2 = new Custodian(markings2, { seed: 2024, sessionOrdinal: 3 });
  c2.beginNight(0);
  for (let t = 0; t < 400; t++) c2.update(1);
  const keyOf = (cc) => JSON.stringify(cc.removals.map((r) => [r.markingId, Math.round(r.removedAtNightTime)]));
  check('F32 identical night replays identically', keyOf(c) === keyOf(c2));
}

// ------------------------------------------------------------------
// F32 The Custodian -- wiring layer
// ------------------------------------------------------------------
{
  const w = new CustodianWiring({ seed: 555, sessionOrdinal: 1 });
  const hits = [];
  for (let i = 0; i < 6; i++) hits.push({ cx: Math.floor(i / 3), cz: i % 3, x: i * 1.5, z: i * 2.25 });
  check('F32 wiring registers fresh scrawls', w.registerGraffiti(hits) === 6);
  check('F32 wiring re-registration is idempotent', w.registerGraffiti(hits) === 0);
  const roundTrip = parseGraffitiMarkingId(graffitiMarkingId(hits[0]));
  check('F32 marking id is position-stable', !!roundTrip && roundTrip.cx === 0 && roundTrip.x === 0);
  check('F32 unparsable ids rejected', parseGraffitiMarkingId('nonsense') === null);
  w.applyPlayerMarking('player:1', '9,9', 'graffiti');
  w.beginNight(0);
  for (let t = 0; t < 500; t++) w.update(1);
  check('F32 wiring drains removals incrementally', w.drainRemovals().length === w.removalLedger.length);
  check('F32 drained twice yields nothing', w.drainRemovals().length === 0);
  check('F32 audit ledgers line up', w.squeakLog.length >= w.removalLedger.length && w.currentNight === 0);

  const snap = w.serialize();
  const json = JSON.parse(JSON.stringify(snap));
  const w2 = CustodianWiring.restore(json, { seed: 555, sessionOrdinal: 1 });
  check('F32 restore accepts valid payload', !!w2);
  if (w2) {
    check('F32 restored ledger intact', w2.removalLedger.length === w.removalLedger.length);
    check('F32 restored night count continues', w2.nightCount === w.nightCount);
    const erasedIds = new Set(w.removalLedger.map((r) => r.markingId));
    const resurrected = w2.registerGraffiti(hits.filter((h) => erasedIds.has(graffitiMarkingId(h))));
    check('F32 erased scrawls cannot re-register', resurrected === 0);
  }
  check('F32 restore rejects garbage', CustodianWiring.restore(null) === null && CustodianWiring.restore({ version: 2 }) === null);
}
// ------------------------------------------------------------------
// F61 The Congregation's Hymn -- grounding + choir table
// ------------------------------------------------------------------
{
  const ledger = [
    { id: 'landmark:CHAPEL', name: 'CHAPEL' },
    { id: 'landmark:ARCHIVE', name: 'ARCHIVE' },
    { id: 'beacon:b1', name: 'the beacon at 3,-2' },
  ];
  const names = ledger.map((d) => d.name);
  const ids = new Set(ledger.map((d) => d.id));
  const choir = new ChapelChoir(
    { name: 'CHAPEL', x: 40, z: -12 },
    ledger,
    31337,
    () => 0.87, // mid-kneel phase: the service is always running
  );
  check('F61 seats generated for the choir', choir.seats.length === 9);
  choir.update(1);
  check('F61 active during the service', choir.active);

  const lines = [];
  for (let t = 0; t < 4000 && lines.length < 40; t++) {
    choir.update(1 / 60);
    lines.push(...choir.drainLines());
  }
  check('F61 lines arrive while the service runs', lines.length >= 8);
  check('F61 every lyric grounds to a ledger discovery',
    lines.filter((l) => l.kind === 'lyric').every((l) =>
      l.discoveryId !== null && ids.has(l.discoveryId) &&
      names.some((n) => l.text.includes(n))));
  check('F61 no ungrounded names enter the hymn',
    lines.every((l) => l.kind !== 'lyric' || names.some((n) => l.text.includes(n))));
  check('F61 voices stay inside the voice count', lines.every((l) => l.voice >= 0 && l.voice < 4));
  let dup = false;
  for (let i = 0; i < lines.length; i++) {
    for (let j = Math.max(0, i - 8); j < i; j++) {
      if (lines[i].text === lines[j].text && lines[i].kind === 'lyric') dup = true;
    }
  }
  check('F61 dedup window holds', !dup);

  const idle = new ChapelChoir({ name: 'CHAPEL', x: 0, z: 0 }, ledger, 7, () => 0.5);
  for (let t = 0; t < 6000; t++) idle.update(1 / 60);
  check('F61 idle chapel sings nothing', idle.drainLines().length === 0 && !idle.active);

  const mute = new ChapelChoir({ name: 'CHAPEL', x: 0, z: 0 }, [], 11, () => 0.86);
  const hums = [];
  for (let t = 0; t < 8000 && hums.length < 12; t++) {
    mute.update(1 / 60);
    hums.push(...mute.drainLines());
  }
  check('F61 empty ledger hums only', hums.length > 0 && hums.every((l) => l.kind === 'hum' && l.discoveryId === null && !names.some((n) => l.text.includes(n))));

  const a = new ChapelChoir({ name: 'CHAPEL', x: 0, z: 0 }, ledger, 4242, () => 0.86);
  const b = new ChapelChoir({ name: 'CHAPEL', x: 0, z: 0 }, ledger, 4242, () => 0.86);
  const c = new ChapelChoir({ name: 'CHAPEL', x: 0, z: 0 }, ledger, 99, () => 0.86);
  check('F61 same seed reproduces staggers', [0, 1, 2, 3].every((v) => a.voiceStagger(v) === b.voiceStagger(v)));
  check('F61 different seed diverges somewhere', [0, 1, 2, 3].some((v) => a.voiceStagger(v) !== c.voiceStagger(v)));
  check('F61 cadence interval is the documented mean', HYMN_LINE_INTERVAL_SEC === 5);
}

console.log(failed === 0
  ? 'SOCIAL_ENTITIES_PASS (' + passed + ' checks)'
  : 'SOCIAL_ENTITIES_FAIL: ' + failed + ' failed, ' + passed + ' passed');
process.exit(failed === 0 ? 0 : 1);
