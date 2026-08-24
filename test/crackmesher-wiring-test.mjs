/**
 * Unit tests for the crack -> mesher game wiring.
 * Standalone (no browser): transpiles the pipeline (cracks/crackmesher/
 * cornerao/constants/rng) into a temp dir and drives the real composition
 * end-to-end: WallCracks memory -> CrackInstance list -> CrackMesherPass
 * damage-decal quads.
 *
 * REPAIR NOTE: the original test drove a CrackMesherWiring adapter class
 * (src/world/crackmesher-wiring.ts) that was never recovered — no such
 * module exists anywhere in git history, so its cache/invalidate API has
 * no referent. This repair tests the same wiring at pipeline level with
 * the real modules; the mock-cache assertions were replaced by their
 * pipeline equivalents (repeat-query stability + activity-driven regen).
 * Run: node test/crackmesher-wiring-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-crackwiring-'));
fs.mkdirSync(path.join(tmp, 'gfx'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'core'), { recursive: true });

// transpile a src file, rewriting extensionless relative imports to .mjs
function emit(relTs, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relTs), 'utf8'),
    { fileName: relTs, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const fixed = js.replace(/(from\s+)'(\.[^']*)'/g, "$1'$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), fixed);
}
emit('src/core/rng.ts', 'core/rng.mjs');
emit('src/gfx/cornerao.ts', 'gfx/cornerao.mjs');
emit('src/world/constants.ts', 'world/constants.mjs');
emit('src/world/cracks.ts', 'world/cracks.mjs');
emit('src/world/crackmesher.ts', 'world/crackmesher.mjs');

const mesherMod = await import(pathToFileURL(path.join(tmp, 'world', 'crackmesher.mjs')).href);
const cracksMod = await import(pathToFileURL(path.join(tmp, 'world', 'cracks.mjs')).href);
const { CrackMesherPass } = mesherMod;
const {
  createWallCracks,
  MAX_CRACKS_PER_CHUNK,
  ACTIVITY_SECONDS_PER_CRACK,
  CRACK_AWAY_MS,
} = cracksMod;

// --- mock-free pipeline determinism -----------------------------------------

/** Minimal Storage double so createWallCracks never touches localStorage. */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

function makeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** The wiring under test, rebuilt as its runtime composition:
 *  memory system query -> mesher pass -> quad list. */
function wireCracks(cracks, seed) {
  return (cx, cz) => new CrackMesherPass({ seed }).generate(cracks.generateForChunk(cx, cz, seed));
}

{
  const storageA = makeStorage();
  const clockA = makeClock();
  const real = createWallCracks(clockA.now, storageA);
  const build = wireCracks(real, 12345);

  // a partial dwell guarantees a non-empty baseline (ambient chance alone
  // can legitimately deal zero cracks for an unlucky seed/chunk pair)
  real.addActivity(15, 15, ACTIVITY_SECONDS_PER_CRACK);
  const fresh = build(0, 0); // world coords 0..CHUNK_SIZE
  check('real pipeline emits well-formed quads',
    fresh.length > 0 &&
    fresh.every((q) =>
      q.positions.length === 12 && q.tints.length === 12 &&
      q.normal.length === 3 && q.normal.every(Number.isFinite)),
    'quads=' + (fresh ? fresh.length : 'null'));

  check('same wiring rebuilds identically while nothing changed',
    JSON.stringify(build(0, 0)) === JSON.stringify(fresh));

  // activity earns cracks: ACTIVITY_SECONDS_PER_CRACK seconds per slot;
  // top up from the partial baseline to the full MAX_CRACKS_PER_CHUNK slots
  for (let i = 1; i < MAX_CRACKS_PER_CHUNK; i++) {
    real.addActivity(15, 15, ACTIVITY_SECONDS_PER_CRACK);
  }
  const afterDwell = build(0, 0);
  check('dwelling in a chunk grows its quad count',
    afterDwell.length > fresh.length,
    fresh.length + ' -> ' + afterDwell.length);

  // returning after CRACK_AWAY_MS deepens stages: revisited rooms worsen
  clockA.advance(CRACK_AWAY_MS);
  const afterReturn = build(0, 0);
  const minTint = (quads) => Math.min(...quads.map((q) => Math.min(...q.tints)));
  check('returning after CRACK_AWAY_MS darkens the decals (stage growth)',
    afterReturn.length > 0 && minTint(afterReturn) < minTint(fresh),
    'minTint ' + minTint(fresh).toFixed(3) + ' -> ' + minTint(afterReturn).toFixed(3));
}

{
  // --- cross-instance determinism: independent memory systems agree --------
  const mk = () => {
    const cracks = createWallCracks(makeClock().now, makeStorage());
    // identical dwell so both instances hold the same guaranteed non-empty set
    // (chunk (4,5) spans world x/z 120..150)
    cracks.addActivity(135, 165, ACTIVITY_SECONDS_PER_CRACK);
    return wireCracks(cracks, 9);
  };
  const a = mk();
  const b = mk();
  const qa = a(4, 5);
  const qb = b(4, 5);
  check('independent pipelines produce byte-identical quads for identical inputs',
    qa.length > 0 && JSON.stringify(qa) === JSON.stringify(qb));

  const otherSeedCracks = createWallCracks(makeClock().now, makeStorage());
  otherSeedCracks.addActivity(135, 165, ACTIVITY_SECONDS_PER_CRACK);
  const otherSeed = wireCracks(otherSeedCracks, 10)(4, 5);
  check('a different world seed diverges the decal set',
    JSON.stringify(otherSeed) !== JSON.stringify(qa));
}

{
  // --- repeat-query stability is the cache contract at pipeline level ------
  const storage = makeStorage();
  const clock = makeClock();
  const real = createWallCracks(clock.now, storage);
  let genCount = 0;
  const counted = {
    generateForChunk(cx, cz, seed) { genCount++; return real.generateForChunk(cx, cz, seed); },
    addActivity: (...args) => real.addActivity(...args),
    getCracks: (...args) => real.getCracks(...args),
  };
  const build = wireCracks(counted, 7);

  // dwell in the queried chunk (4,5) so the stability checks are non-vacuous
  counted.addActivity(135, 165, ACTIVITY_SECONDS_PER_CRACK);
  const first = build(4, 5);
  const second = build(4, 5);
  check('repeat queries re-derive byte-identical output',
    second !== first && JSON.stringify(second) === JSON.stringify(first));
  const before = genCount;
  check('queries with no intervening activity do not change the crack list',
    JSON.stringify(build(4, 5)) === JSON.stringify(first) && genCount > before);
  const third = build(4, 5);
  check('subsequent builds stay stable again',
    JSON.stringify(third) === JSON.stringify(first));
}

console.log(failures === 0 ? '\nALL CRACKMESHER-WIRING TESTS PASSED'
  : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
