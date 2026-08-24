/**
 * Long Hall tests (src/world/longhall.ts, F54).
 * Standalone (no browser): transpiles rng.ts + longhall.ts into a temp dir
 * and drives the model directly, same idiom as doorswap-test.
 *
 * Acceptance:
 *   1. cycle determinism - same seed + walk timeline -> byte-identical exit
 *      sequences and cycle logs across independent runs
 *   2. cycles only behind the player - forward slot ids never change while
 *      behind-slot ids demonstrably rotate across thresholds
 *   3. rarity gate - ~1 hall per 40 chunks across seeds within tolerance;
 *      gate + descriptor are deterministic
 *
 * Run: node test/longhall-test.mjs
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-longhall-'));
fs.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'src/world'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText.replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fs.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/world/longhall.ts', 'src/world/longhall.mjs');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const lh = await import(pathToFileURL(path.join(tmp, 'src/world/longhall.mjs')).href);

// ---- 1. descriptor generation -------------------------------------------
const SEED = 0xc0ffee;

let found = null;
let foundChunk = -1;
for (let c = 0; c < 4000 && !found; c++) {
  const d = lh.createLongHall(SEED, c);
  if (d) { found = d; foundChunk = c; }
}
check('rarity gate yields a hall within 4000 chunks', !!found, 'none rolled true');
if (found) {
  check('gate rejects the chunk createLongHall accepted is impossible',
    lh.rollLongHallChunk(SEED, foundChunk) === true);
  check('descriptor null on ungated chunk',
    lh.createLongHall(SEED, foundChunk + 1) === null || lh.rollLongHallChunk(SEED, foundChunk + 1) === true);
  const d2 = lh.createLongHall(SEED, foundChunk);
  check('createLongHall deterministic (deep equal)', JSON.stringify(d2) === JSON.stringify(found));
  const perm = [...found.doorOrder].sort((a, b) => a - b);
  check('doorOrder is a permutation of 0..N-1',
    perm.every((v, i) => v === i), JSON.stringify(perm));
  check('hall length is 300m with 30m slots',
    lh.HALL_LENGTH_M === 300 && found.slots.length === 10 && found.slots[9].posM === 270);

  // ---- 2. cycle determinism ---------------------------------------------
  const timeline = [0, 10, 59, 60, 61, 119, 120, 150, 180, 240, 299, 300];
  const runTimeline = () => {
    const walker = new lh.LongHallWalker(found);
    const seqs = [walker.currentExits()];
    for (const t of timeline) {
      walker.advance(t);
      seqs.push(walker.currentExits());
    }
    return { seqs, log: JSON.parse(JSON.stringify(walker.cycleLog)) };
  };
  const a = runTimeline();
  const b = runTimeline();
  check('same seed + walk timeline -> identical exit sequences',
    JSON.stringify(a.seqs) === JSON.stringify(b.seqs));
  check('same seed + walk timeline -> identical cycle log',
    JSON.stringify(a.log) === JSON.stringify(b.log));

  // Pure replay equals stateful walker log.
  const replay = lh.cycleLog(found, 0, 300);
  check('pure cycleLog replay matches walker log',
    JSON.stringify(replay) === JSON.stringify(a.log),
    JSON.stringify({ replay, walker: a.log }));

  // ---- 3. cycles only behind the player ---------------------------------
  const base = lh.currentExits(found, 0);
  let forwardStable = true;
  for (const t of timeline) {
    const views = lh.currentExits(found, t);
    for (const v of views) {
      const b0 = base.find((x) => x.posM === v.posM);
      if (!v.behind && v.doorId !== b0.doorId) forwardStable = false;
    }
  }
  check('forward exits stable at every walked distance', forwardStable);

  // Behind ids actually rotate across thresholds.
  const atStart = lh.currentExits(found, 30).filter((v) => v.behind).map((v) => v.doorId);
  const atMid = lh.currentExits(found, 90).filter((v) => v.behind).map((v) => v.doorId);
  const atEnd = lh.currentExits(found, 250).filter((v) => v.behind).map((v) => v.doorId);
  check('behind ids differ between thresholds (cycling happens)',
    JSON.stringify(atStart) !== JSON.stringify(atMid) &&
    JSON.stringify(atMid) !== JSON.stringify(atEnd));
  check('behind set only grows as player walks deeper',
    atStart.length <= atMid.length && atMid.length <= atEnd.length);

  // Same-cycle stability inside one interval: slots behind at BOTH distances
  // keep identical ids (no mid-interval rotation); the set may still grow as
  // further slots fall behind.
  const vA = lh.currentExits(found, 61).filter((v) => v.behind);
  const vB = lh.currentExits(found, 119).filter((v) => v.behind);
  const stableWithin = vA.every((a) => {
    const bb = vB.find((x) => x.posM === a.posM);
    return bb && bb.doorId === a.doorId;
  });
  check('no cycling between thresholds (stable within interval)',
    stableWithin,
    JSON.stringify({ vA, vB }));

  // Walker ignores backwards motion.
  const wBack = new lh.LongHallWalker(found);
  wBack.advance(200);
  const beforeLog = JSON.stringify(wBack.cycleLog);
  const added = wBack.advance(50);
  check('backwards advance appends nothing', added.length === 0 &&
    JSON.stringify(wBack.cycleLog) === beforeLog);

  // Clamping beyond hall length.
  const over = new lh.LongHallWalker(found);
  over.advance(9999);
  check('walked distance clamps to hall length',
    over.walkedM === lh.HALL_LENGTH_M && over.cycleLog.length === Math.floor(300 / 60));
} else {
  failures++;
}

// ---- 4. rarity gate calibration across seeds ------------------------------
const SEEDS = 64;
const CHUNKS_PER_SEED = 320; // expected 8 halls per seed
let halls = 0;
for (let s = 0; s < SEEDS; s++) {
  for (let c = 0; c < CHUNKS_PER_SEED; c++) {
    if (lh.rollLongHallChunk((s * 2654435761) >>> 0, c)) halls++;
  }
}
const trials = SEEDS * CHUNKS_PER_SEED;
const observed = halls / trials;
const expected = 1 / 40;
// Binomial sigma for p=1/40, n=20480 is ~22; allow +-4 sigma (~+-25%).
check(`rarity gate ~1/40 across ${trials} chunks (got 1/${Math.round(1 / observed)})`,
  Math.abs(observed - expected) < 0.25 * expected,
  `observed=${observed}`);
check('rarity gate deterministic per (seed, chunk)',
  lh.rollLongHallChunk(SEED, 7) === lh.rollLongHallChunk(SEED, 7));

console.log(failures === 0 ? '\nLONGHALL_PASS' : `\nLONGHALL_FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
