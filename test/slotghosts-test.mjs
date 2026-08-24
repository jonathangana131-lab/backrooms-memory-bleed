/**
 * Save-slot ghost tests (F89) - pure Node, no renderer.
 * Verifies the F89 acceptance proof:
 *   1. AC echo lifetime - lifetime scales linearly with staleness up to
 *      ECHO_LIFETIME_CAP_SEC then stays constant; fresh saves get the base
 *      lifetime and negative staleness clamps to it
 *   2. exactly one echo burst per load event - repeat notifyLoad calls are
 *      silent until unload() re-arms the slot
 *   3. stale slots (> 30 days proxy seconds) emit none, though they still
 *      count as loaded (no burst on retry either)
 *   4. determinism per (slotId, seed) - identical metadata replays
 *      byte-identical cues; a different seed diverges in flicker rhythm;
 *      different slotIds never collide
 *   5. echoes never interact - every cue carries visualOnly === true and no
 *      entity/collider/gameplay fields beyond display data
 *   6. junk inputs safe - non-finite clocks/positions return []; missing or
 *      empty slotId fails loud
 *
 * Run: node test/slotghosts-test.mjs  (prints SLOTGHOSTS ALL PASS, exits 0)
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
  SlotGhosts, echoLifetimeSec,
  ECHO_LIFETIME_CAP_SEC, ECHO_LIFETIME_BASE_SEC,
  ECHO_LIFETIME_RAMP_SEC, STALE_CUTOFF_SEC, FLICKER_COUNT,
} = await import('../src/save/slotghosts.ts');

let failures = 0;
let check = 0;
const ok = (cond, msg) => {
  check++;
  if (cond) console.log('  PASS', msg);
  else { failures++; console.error('  FAIL', msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** Slot metadata factory. */
const meta = (over = {}) => ({
  slotId: 'slot-a',
  savedAtSec: 1000,
  seed: 0xC0FFEE,
  position: [3.5, 1.7, -2.25],
  ...over,
});

// ---------------------------------------------------------------------------
console.log('1. Echo lifetime scales with staleness up to cap, then constant');
{
  ok(near(echoLifetimeSec(0), ECHO_LIFETIME_BASE_SEC, 1e-12), 'fresh save gets base lifetime');
  ok(echoLifetimeSec(-50) === echoLifetimeSec(0), 'negative staleness clamps to base');
  let mono = true;
  for (let s = 0; s < ECHO_LIFETIME_RAMP_SEC; s += 15) {
    if (!(echoLifetimeSec(s + 15) > echoLifetimeSec(s))) { mono = false; break; }
  }
  ok(mono, `lifetime strictly increases through the ${ECHO_LIFETIME_RAMP_SEC}s ramp`);
  const atCap = echoLifetimeSec(ECHO_LIFETIME_RAMP_SEC);
  ok(near(atCap, ECHO_LIFETIME_CAP_SEC, 1e-12), 'ramp lands exactly on the cap');
  ok(
    echoLifetimeSec(ECHO_LIFETIME_RAMP_SEC * 10) === ECHO_LIFETIME_CAP_SEC &&
    echoLifetimeSec(STALE_CUTOFF_SEC / 2) === ECHO_LIFETIME_CAP_SEC,
    'lifetime constant at the cap beyond the ramp',
  );
  ok(near(echoLifetimeSec(60), ECHO_LIFETIME_BASE_SEC + (26 / ECHO_LIFETIME_RAMP_SEC) * 60, 1e-9),
    'mid-ramp value is exactly linear');
  // End-to-end through notifyLoad.
  const g = new SlotGhosts();
  const cue = g.notifyLoad(meta({ savedAtSec: 1000 }), 1300)[0];
  ok(cue.lifetimeSec > ECHO_LIFETIME_BASE_SEC && cue.lifetimeSec < ECHO_LIFETIME_CAP_SEC,
    `cue lifetime reflects mid-ramp staleness (${cue.lifetimeSec.toFixed(2)}s)`);
}

// ---------------------------------------------------------------------------
console.log('2. Exactly one echo burst per load event');
{
  const g = new SlotGhosts();
  const first = g.notifyLoad(meta(), 1100);
  ok(first.length === 1 && first[0].slotId === 'slot-a', 'first load bursts one cue');
  for (let i = 0; i < 5; i++) {
    if (g.notifyLoad(meta(), 1200 + i).length !== 0) { ok(false, 'repeat notification re-burst'); break; }
    if (i === 4) ok(true, 'repeat notifications stay silent');
  }
  g.unload('slot-a');
  const again = g.notifyLoad(meta(), 2000);
  ok(again.length === 1 && again[0].lifetimeSec > first[0].lifetimeSec,
    'unload() re-arms the slot with a fresher-bounded lifetime');
  // A second slot loads independently.
  ok(g.notifyLoad(meta({ slotId: 'slot-b' }), 2100).length === 1, 'independent slots each burst once');
}

// ---------------------------------------------------------------------------
console.log('3. Stale slots (>30-day proxy) emit none');
{
  const g = new SlotGhosts();
  const now = 1_000_000;
  const boundary = g.notifyLoad(meta({ savedAtSec: now - STALE_CUTOFF_SEC }), now);
  ok(boundary.length === 1, 'staleness exactly at the cutoff still echoes');
  const stale = g.notifyLoad(meta({ slotId: 'ancient', savedAtSec: now - STALE_CUTOFF_SEC - 1 }), now);
  ok(stale.length === 0, 'one second past the cutoff emits nothing');
  ok(g.notifyLoad(meta({ slotId: 'ancient', savedAtSec: now - STALE_CUTOFF_SEC - 1 }), now).length === 0,
    'stale slot stays silent AND counts as loaded on retry');
  const farStale = g.notifyLoad(meta({ slotId: 'ruins', savedAtSec: 0 }), 365 * 86400);
  ok(farStale.length === 0, 'year-old slots emit nothing');
}

// ---------------------------------------------------------------------------
console.log('4. Determinism per (slotId, seed)');
{
  const g1 = new SlotGhosts();
  const g2 = new SlotGhosts();
  const c1 = g1.notifyLoad(meta(), 5000)[0];
  const c2 = g2.notifyLoad(meta(), 5000)[0];
  ok(JSON.stringify(c1) === JSON.stringify(c2), 'same (slotId, seed, staleness) replays byte-identical');
  const c3 = new SlotGhosts().notifyLoad(meta({ seed: 999 }), 5000)[0];
  ok(
    JSON.stringify(c3.flickerOffsetsSec) !== JSON.stringify(c1.flickerOffsetsSec),
    'different seed shifts the flicker rhythm',
  );
  ok(near(c1.lifetimeSec, c3.lifetimeSec, 1e-12), 'seed does not touch lifetime physics');
  const c4 = new SlotGhosts().notifyLoad(meta({ slotId: 'other-slot' }), 5000)[0];
  ok(
    JSON.stringify(c4.flickerOffsetsSec) !== JSON.stringify(c1.flickerOffsetsSec),
    'different slotId shifts the flicker rhythm',
  );
  ok(
    c1.flickerOffsetsSec.length === FLICKER_COUNT &&
    c1.flickerOffsetsSec.every((v, i) => v >= 0 && v < c1.lifetimeSec && (i === 0 || v > c1.flickerOffsetsSec[i - 1])),
    'flicker offsets are FLICKER_COUNT distinct ascending beats inside the lifetime',
  );
}

// ---------------------------------------------------------------------------
console.log('5. Echoes never interact');
{
  const cue = new SlotGhosts().notifyLoad(meta(), 1500)[0];
  ok(cue.visualOnly === true, 'visualOnly flag hard-set true');
  const keys = Object.keys(cue);
  ok(
    keys.every((k) => ['slotId', 'position', 'lifetimeSec', 'flickerOffsetsSec', 'visualOnly'].includes(k)),
    `cue carries only display data (${keys.join(', ')})`,
  );
  ok(
    cue.position.length === 3 && cue.position.every(Number.isFinite),
    'position is plain world coordinates',
  );
}

// ---------------------------------------------------------------------------
console.log('6. Junk inputs safe');
{
  const g = new SlotGhosts();
  ok(g.notifyLoad(meta({ savedAtSec: NaN }), 1000).length === 0, 'NaN savedAt silent');
  ok(g.notifyLoad(meta(), NaN).length === 0, 'NaN nowSec silent');
  ok(g.notifyLoad(meta({ position: [1, Infinity, 2] }), 1000).length === 0, 'non-finite position silent');
  try {
    g.notifyLoad(meta({ slotId: '' }), 1000);
    ok(false, 'empty slotId fails loud');
  } catch { ok(true, 'empty slotId fails loud'); }
  try {
    g.notifyLoad(null, 1000);
    ok(false, 'missing metadata fails loud');
  } catch { ok(true, 'missing metadata fails loud'); }
  ok(g.loaded.includes('slot-a') === false, 'junk loads never mark the slot loaded');
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? `SLOTGHOSTS ALL PASS (${check} checks)` : `SLOTGHOSTS FAILURES: ${failures}/${check}`);
process.exit(failures === 0 ? 0 : 1);
