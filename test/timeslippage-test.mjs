/**
 * Time slippage tests (F18): zero drift at s=0, monotone growth with
 * saturation, bounded magnitude, per-zone-seed consistency across instances,
 * and clock-vs-clock disagreement inside saturated zones.
 *
 * The TypeScript module is transpiled to a temp dir (extensionless relative
 * imports rewritten for Node ESM), then imported. Run:
 *
 *   node test/timeslippage-test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-timeslippage-'));
fsMod.mkdirSync(path.join(tmp, 'src/story'), { recursive: true });
fsMod.mkdirSync(path.join(tmp, 'src/core'), { recursive: true });

function emit(relSrc, outRel) {
  const js = ts.transpileModule(
    fsMod.readFileSync(path.join(ROOT, relSrc), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText
    // Node ESM needs explicit extensions on the relative cross-file import.
    .replace(/(from\s+')(\.[^']*)'/g, "$1$2.mjs'");
  fsMod.writeFileSync(path.join(tmp, outRel), js);
}
emit('src/core/rng.ts', 'src/core/rng.mjs');
emit('src/story/timeslippage.ts', 'src/story/timeslippage.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const {
  TimeSlippage,
  slipOffsetSec,
  slipSpreadSec,
  slippageZoneSeed,
  CLOCK_IDS,
  SLIP_MAX_DRIFT_SEC,
} = await import('file://' + path.join(tmp, 'src/story/timeslippage.mjs'));

test('offsets are exactly zero at s=0 for every clock and zone', () => {
  for (const zoneKey of ['zone-a', 'zone-b', 'unregistered']) {
    const zs = slippageZoneSeed(42, zoneKey);
    for (const id of CLOCK_IDS) {
      assert.equal(slipOffsetSec(42, id, zs, 0), 0);
    }
    const t = new TimeSlippage(42);
    t.enterZone(zoneKey, 0);
    assert.deepEqual(t.offsets(), { wallclock: 0, camcorder: 0, session: 0 });
    assert.equal(t.disagreementSec(), 0);
  }
});

test('|offset| grows monotonically with saturation and stays bounded', () => {
  const zsA = slippageZoneSeed(7, 'sat-zone');
  const zsB = slippageZoneSeed(7, 'sat-zone-2');
  for (const zs of [zsA, zsB]) {
    for (const id of CLOCK_IDS) {
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const o = slipOffsetSec(7, id, zs, i / 20);
        const mag = Math.abs(o);
        assert.ok(mag >= prev - 1e-12, 'magnitude decreased with saturation');
        prev = mag;
        assert.ok(mag <= SLIP_MAX_DRIFT_SEC + 1e-9, 'drift exceeded bound');
      }
      // at full saturation some real drift exists
      assert.ok(Math.abs(slipOffsetSec(7, id, zs, 1)) > 0);
    }
  }
  // spread between clocks also grows monotonically
  let prevSpread = -1;
  for (let i = 0; i <= 10; i++) {
    const sp = slipSpreadSec(7, zsA, i / 10);
    assert.ok(sp >= prevSpread - 1e-12, 'spread not monotone');
    prevSpread = sp;
  }
});

test('consistent per zone seed across instances; different zones diverge', () => {
  const feed = (t) => {
    t.registerZone('pinned-zone', 999);
    t.enterZone('pinned-zone', 0.7);
    return [t.offsets(), t.reading('camcorder', 3600), t.disagreementSec()];
  };
  const a = feed(new TimeSlippage(1337));
  const b = feed(new TimeSlippage(1337));
  assert.deepEqual(b, a);

  // a different master seed produces different drift for the same zone
  const c = feed(new TimeSlippage(1338));
  assert.notDeepEqual(c[0], a[0]);

  // unregistered keys are equally stable across instances
  const d1 = new TimeSlippage(55);
  const d2 = new TimeSlippage(55);
  d1.enterZone('wild-hall', 0.9);
  d2.enterZone('wild-hall', 0.9);
  assert.deepEqual(d2.offsets(), d1.offsets());

  // different zone seeds disagree somewhere at full saturation
  const zs1 = slippageZoneSeed(55, 'wild-hall');
  const zs2 = slippageZoneSeed(55, 'other-hall');
  assert.ok(
    CLOCK_IDS.some((id) => slipOffsetSec(55, id, zs1, 1) !== slipOffsetSec(55, id, zs2, 1)),
    'distinct zones produced identical offsets',
  );
});

test('clocks disagree inside saturated zones; readings track offsets', () => {
  let foundDisagreement = false;
  for (let seed = 1; seed <= 25 && !foundDisagreement; seed++) {
    const t = new TimeSlippage(seed);
    t.enterZone('saturation-4', 1);
    if (t.disagreementSec() > 5) foundDisagreement = true;
  }
  assert.ok(foundDisagreement, 'no sampled run showed meaningful clock disagreement');

  const t = new TimeSlippage(3);
  t.enterZone('saturation-4', 1);
  const offs = t.offsets();
  for (const id of CLOCK_IDS) {
    assert.equal(t.reading(id, 100), 100 + offs[id], 'reading != session + offset');
  }
  // before any zone entry clocks hold true time
  const fresh = new TimeSlippage(3);
  assert.equal(fresh.disagreementSec(), 0);
  assert.equal(fresh.reading('wallclock', 50), 50);

  // unknown clock ids read zero (not registered)
  const subset = new TimeSlippage(3, ['session']);
  subset.enterZone('z', 1);
  assert.equal(subset.offset('camcorder'), 0);
  assert.equal(subset.reading('session', 10), 10 + subset.offsets().session);
});

console.log('timeslippage-test: all checks passed');
