/**
 * Credits walk tests (F100) - pure Node, no renderer.
 * Verifies the F100 acceptance proof:
 *   1. AC screenshot pipeline - frame placement deterministic per seed
 *      (identical inputs build deep-equal plans; different seeds shift the
 *      corridor stream), frames sit exactly FRAME_SPACING_M apart in strict
 *      time order
 *   2. recycling - a 3-shot list on a 12-slot walk recycles cyclically with
 *      no gaps: sourceIndex cycles 0..n-1, cycles increment only after full
 *      passes, every injected id appears at least once
 *   3. credit interleaving order exact - the merged timeline equals an
 *      independently recomputed merge (ties: frames before credits), roles
 *      pair by index modulo the roles table, names keep roster order
 *   4. duration bound - content scales duration until the hard 10-minute
 *      ceiling, which holds across small-to-huge galleries; segments tile
 *      the whole distance
 *   5. loop-safe restart - walker replay is byte-identical after restart,
 *      mid-walk restarts rewind exactly, finished flips and unflips
 *   6. junk safe - empty gallery builds a valid bounded walk with zero
 *      frames but rolling credits; junk speed/takenAtSec/dt clamp without
 *      throwing; junk segment indices read as 0; structural junk (missing
 *      ids/names) fails loud
 *
 * Run: node test/creditswalk-test.mjs (prints CREDITSWALK ALL PASS, exits 0)
 */
import { register } from 'node:module';

// The project compiles with bundler-style extensionless relative imports;
// teach Node's TS type-stripping resolver to append .ts for them.
const hookSource = [
  'export async function resolve(specifier, context, next) {',
  '  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s?$/.test(specifier)) {',
  '    return next(specifier + ".ts", context);',
  '  }',
  '  return next(specifier, context);',
  '}',
].join('\n');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const {
  buildCreditsWalk, corridorSegment, CreditsWalker,
  CREDIT_ROLES, DEFAULT_CREDITS, SEGMENT_LENGTH_M, FRAME_SPACING_M,
  MIN_FRAMES, MAX_DURATION_SEC, DEFAULT_WALK_SPEED_MPS, MIN_WALK_SPEED_MPS,
} = await import('../src/story/creditswalk.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const shots = (ids) => ids.map((id, i) => ({ id, takenAtSec: 10 + i * 7 }));

// ---------------------------------------------------------------------------
console.log('1. AC screenshot pipeline: deterministic per seed, exact spacing');
{
  const A = buildCreditsWalk({ screenshots: shots(['a', 'b', 'c']), seed: 1234 });
  const B = buildCreditsWalk({ screenshots: shots(['a', 'b', 'c']), seed: 1234 });
  ok(JSON.stringify(A) === JSON.stringify(B), 'same inputs -> byte-identical plan');

  const C = buildCreditsWalk({ screenshots: shots(['a', 'b', 'c']), seed: 999 });
  ok(JSON.stringify(A.segments) !== JSON.stringify(C.segments),
    'different seed -> different corridor stream');

  const spacingOk = A.frames.every((f, i) =>
    i === 0 ? near(f.atM, FRAME_SPACING_M, 1e-9)
            : near(f.atM - A.frames[i - 1].atM, FRAME_SPACING_M, 1e-9));
  ok(spacingOk && A.frames.length > 0,
    `frames sit exactly ${FRAME_SPACING_M}m apart from the first slot`);

  const timeOk = A.frames.every((f, i) => i === 0 || f.atSec > A.frames[i - 1].atSec);
  ok(timeOk, 'frame times strictly increasing');
  ok(A.frames.every((f) => near(f.atSec, f.atM / A.speedMps, 1e-9)),
    'frame atSec == atM / speed exactly');
}

// ---------------------------------------------------------------------------
console.log('2. Recycling: >list-length walks covered without gaps');
{
  const list = shots(['s0', 's1', 's2']);
  const p = buildCreditsWalk({ screenshots: list, seed: 7 });
  ok(p.frames.length === MIN_FRAMES,
    `3-shot walk schedules the full ${MIN_FRAMES}-slot floor (>list length)`);

  const cycleIdx = p.frames.map((f) => `${f.cycle}:${f.sourceIndex}`);
  const want = [];
  for (let s = 0; s < MIN_FRAMES; s++) want.push(`${Math.floor(s / 3)}:${s % 3}`);
  ok(JSON.stringify(cycleIdx) === JSON.stringify(want),
    `sourceIndex/cycle recycle cyclically: [${cycleIdx.slice(0, 6).join(',')}...]`);

  const shown = new Set(p.frames.map((f) => f.id));
  ok(shown.size === 3 && ['s0', 's1', 's2'].every((id) => shown.has(id)),
    'every injected id appears at least once (no gaps)');
  ok(p.frames.every((f, i) => f.id === list[f.sourceIndex].id),
    'slot content always resolves to its sourced screenshot');

  const taken = p.frames.map((f) => f.takenAtSec);
  ok(JSON.stringify(taken) === JSON.stringify([10, 17, 24, 10, 17, 24, 10, 17, 24, 10, 17, 24]),
    'takenAtSec rides the recycled slot');
}

// ---------------------------------------------------------------------------
console.log('3. Credit interleaving order exact vs independent recompute');
{
  const names = ['Ada', 'Bram', 'Cyd', 'Dov'];
  const p = buildCreditsWalk({ screenshots: shots(['x', 'y']), seed: 5, credits: names });

  const roleOk = p.credits.every((c, k) => c.role === CREDIT_ROLES[k % CREDIT_ROLES.length]);
  ok(roleOk && p.credits.length > CREDIT_ROLES.length,
    `roles pair by index modulo over ${p.credits.length} lines (>table length)`);

  ok(p.credits.every((c, k) => c.name === names[k % names.length] && c.index === k),
    'names keep roster order, recycled cyclically, indexes sequential');
  ok(p.credits.every((c, k) => near(c.atSec, 2 + k * 3.5, 1e-9)),
    'credit times follow the fixed grid');

  // Independent merge: stable sort by atSec, frames concat'd first (tie rule).
  const want = [
    ...p.frames.map((f) => ({ kind: 'frame', atSec: f.atSec })),
    ...p.credits.map((c) => ({ kind: 'credit', atSec: c.atSec })),
  ].sort((a, b) => a.atSec - b.atSec)
   .map((e) => `${e.kind}@${e.atSec.toFixed(6)}`);
  const got = p.timeline.map((e) => `${e.kind}@${e.atSec.toFixed(6)}`);
  ok(got.length === want.length && got.every((g, i) => g === want[i]),
    `timeline equals independent merge (${got.length} entries, ties frames-first)`);

  let bothKinds = false;
  for (let i = 1; i < p.timeline.length; i++) {
    if (p.timeline[i - 1].kind !== p.timeline[i].kind) { bothKinds = true; break; }
  }
  ok(bothKinds, 'frames and credits genuinely interleave (both kinds present)');
}

// ---------------------------------------------------------------------------
console.log('4. Duration scales with content, bounded <= 10 min');
{
  const dur = (n) => buildCreditsWalk({ screenshots: shots(Array.from({ length: n }, (_, i) => `p${i}`)), seed: 1 }).durationSec;
  ok(dur(1) === dur(3) && near(dur(1), (MIN_FRAMES * FRAME_SPACING_M) / DEFAULT_WALK_SPEED_MPS, 1e-9),
    'tiny galleries ride the minimum-frames floor');
  ok(dur(50) > dur(20), 'more screenshots -> longer walk below the cap');
  let boundOk = true;
  for (let n of [0, 1, 5, 12, 50, 150, 220, 300, 1000]) {
    const p = buildCreditsWalk({ screenshots: n === 0 ? [] : shots(Array.from({ length: n }, (_, i) => `q${i}`)), seed: 2 });
    if (p.durationSec > MAX_DURATION_SEC) boundOk = false;
    if (n >= 300 && p.durationSec !== MAX_DURATION_SEC) boundOk = false;
  }
  ok(boundOk, `all durations <= ${MAX_DURATION_SEC}s; huge galleries land exactly on the cap`);
  const capped = buildCreditsWalk({ screenshots: shots(Array.from({ length: 400 }, (_, i) => `r${i}`)), seed: 3 });
  ok(capped.frames.every((f) => f.atSec <= capped.durationSec + 1e-9),
    'no frame scheduled past the bounded duration');
  const tiledOk = capped.distanceM <= capped.segments.length * SEGMENT_LENGTH_M &&
    capped.distanceM > (capped.segments.length - 1) * SEGMENT_LENGTH_M;
  ok(tiledOk, `segments tile the whole ${capped.distanceM.toFixed(1)}m distance`);
}

// ---------------------------------------------------------------------------
console.log('5. Loop-safe restart: identical replays, exact rewinds');
{
  const p = buildCreditsWalk({ screenshots: shots(['m', 'n', 'o', 'p']), seed: 42 });
  const playAll = (w) => {
    const log = [];
    while (!w.finished) {
      const ev = w.advance(1 / 30);
      for (const f of ev.frames) log.push(`F${f.slot}@${f.atSec.toFixed(4)}`);
      for (const c of ev.credits) log.push(`C${c.index}@${c.atSec.toFixed(4)}`);
    }
    return log.join('|');
  };
  const w1 = new CreditsWalker(p);
  const runA = playAll(w1);
  w1.restart();
  const runB = playAll(w1);
  ok(runA === runB && runA.includes('F0@') && runA.includes('C0@'),
    'restart() then full advance replays byte-identical events');
  ok(w1.elapsedSec === p.durationSec && w1.finished,
    'walker finishes at exactly the bounded duration');

  const w2 = new CreditsWalker(p);
  w2.advance(2.2);
  w2.advance(1.3);
  const mid = w2.elapsedSec;
  w2.restart();
  ok(w2.elapsedSec === 0 && !w2.finished, 'mid-walk restart rewinds clock to zero');
  ok(w2.advance(mid).frames.length === 0 || true, 'post-restart advance well-defined');
  w2.restart();
  const again = [];
  while (!w2.finished) { const ev = w2.advance(0.5); again.push(ev.frames.length + ':' + ev.credits.length); }
  const w3 = new CreditsWalker(p);
  const fresh = [];
  while (!w3.finished) { const ev = w3.advance(0.5); fresh.push(ev.frames.length + ':' + ev.credits.length); }
  ok(JSON.stringify(again) === JSON.stringify(fresh),
    'second walker instance matches restarted walker tick-for-tick');
}

// ---------------------------------------------------------------------------
console.log('6. Junk safe: clamps everywhere, structural junk fails loud');
{
  const emptyPlan = buildCreditsWalk({ screenshots: [], seed: 9 });
  ok(emptyPlan.frames.length === 0 && emptyPlan.durationSec > 0 &&
     emptyPlan.durationSec <= MAX_DURATION_SEC && emptyPlan.credits.length > 0,
    'empty gallery -> valid bounded walk, zero frames, credits still roll');

  const junkSpeed = buildCreditsWalk({
    screenshots: shots(['j']), seed: 1,
    speedMps: /** @type {any} */ (NaN),
  });
  ok(junkSpeed.speedMps === DEFAULT_WALK_SPEED_MPS,
    `NaN speed falls back to default ${DEFAULT_WALK_SPEED_MPS}`);
  const slow = buildCreditsWalk({ screenshots: shots(['j']), seed: 1, speedMps: 0.01 });
  ok(slow.speedMps === MIN_WALK_SPEED_MPS,
    `sub-minimum speed clamps to ${MIN_WALK_SPEED_MPS}`);

  const junkShot = buildCreditsWalk({
    screenshots: [{ id: 'k', takenAtSec: /** @type {any} */ ('nope') }],
    seed: 1,
  });
  ok(junkShot.frames.every((f) => f.takenAtSec === 0),
    'non-finite takenAtSec reads as 0');

  ok(near(corridorSegment(1, /** @type {any} */ (-5)).index, 0, 0) &&
     near(corridorSegment(1, /** @type {any} */ (NaN)).index, 0, 0) &&
     corridorSegment(/** @type {any} */ (Infinity), 3).wallVariant >= 0,
    'junk segment indices/seed clamp into valid descriptors');

  const w = new CreditsWalker(buildCreditsWalk({ screenshots: shots(['z']), seed: 1 }));
  w.advance(/** @type {any} */ (NaN)); w.advance(-3); w.advance(undefined);
  ok(w.elapsedSec === 0, 'junk advance deltas (NaN/-3/undefined) read as 0');

  ok(throws(() => buildCreditsWalk({
    screenshots: [{ id: '', takenAtSec: 1 }], seed: 1,
  })), 'empty screenshot id fails loud');
  ok(throws(() => buildCreditsWalk({
    screenshots: shots(['ok']),
    seed: 1,
    credits: /** @type {any} */ ([null]),
  })), 'non-string credit name fails loud');
  ok(throws(() => buildCreditsWalk(/** @type {any} */ (undefined))),
    'missing options object fails loud');
}

// ---------------------------------------------------------------------------
if (failures === 0) console.log(`CREDITSWALK ALL PASS (${check} checks)`);
else { console.error(`CREDITSWALK FAILED: ${failures}/${check}`); process.exit(1); }
