/**
 * Echo geography tests (F17): deterministic replay per site, once-per-visit
 * echo discipline, and empty schedules for never-recorded sites.
 *
 * The TypeScript module is transpiled to a temp dir (extensionless relative
 * imports rewritten for Node ESM), then imported. Run:
 *
 *   node test/echogeography-test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import fsMod from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fsMod.mkdtempSync(path.join(os.tmpdir(), 'bmb-echogeography-'));
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
emit('src/story/echogeography.ts', 'src/story/echogeography.mjs');
process.on('exit', () => { try { fsMod.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

const { EchoGeography, buildEchoSchedule } = await import('file://' + path.join(tmp, 'src/story/echogeography.mjs'));

/** Standard feed used by determinism comparisons. */
function feed(g) {
  g.recordFootstepBurst('hall-a', 12, 5);
  g.recordMemoMoment('hall-a', 16, 'day 9: the wallpaper is breathing again');
  g.recordFootstepBurst('hall-a', 41, 2);
}

test('identical feed -> byte-identical schedules across instances and seeds differ per site key', () => {
  const a = new EchoGeography(1337);
  feed(a);
  const b = new EchoGeography(1337);
  feed(b);
  const sa = a.enterSite('hall-a');
  const sb = b.enterSite('hall-a');
  assert.deepEqual(sb, sa);
  assert.ok(sa.length > 0);

  // same seed but different site key -> different schedule stream
  const c = new EchoGeography(1337);
  c.recordFootstepBurst('hall-b', 12, 5);
  const sc = c.enterSite('hall-b');
  assert.notDeepEqual(
    sa.filter((q) => q.kind === 'footstep').map((q) => q.delaySec),
    sc.filter((q) => q.kind === 'footstep').map((q) => q.delaySec),
  );

  // pure builder agrees with the class output for the same visit index
  assert.deepEqual(buildEchoSchedule(1337, 'hall-a', 0, [
    { kind: 'footstep', atSec: 12 }, { kind: 'footstep', atSec: 12.55 },
    { kind: 'footstep', atSec: 13.1 }, { kind: 'footstep', atSec: 13.65 },
    { kind: 'footstep', atSec: 14.2 }, { kind: 'memo', atSec: 16, memoText: 'day 9: the wallpaper is breathing again' },
    { kind: 'footstep', atSec: 41 }, { kind: 'footstep', atSec: 41.55 },
  ]), sa);
});

test('events echo exactly ONCE per visit; repeat entry is empty until new recordings land', () => {
  const g = new EchoGeography(99);
  g.recordFootstepBurst('site-1', 3, 4);
  const first = g.enterSite('site-1');
  assert.equal(first.length, 4);
  assert.deepEqual(g.enterSite('site-1'), []);
  assert.equal(g.visits('site-1'), 2); // entry counted even when nothing echoes

  // only the NEW event echoes on the next visit
  g.recordMemoMoment('site-1', 30, 'still walking');
  const second = g.enterSite('site-1');
  assert.equal(second.length, 1);
  assert.equal(second[0].kind, 'memo');
  assert.equal(second[0].memoText, 'still walking');
});

test('never-recorded sites produce empty schedules', () => {
  const g = new EchoGeography(5);
  assert.deepEqual(g.enterSite('void-site'), []);
  assert.equal(g.pendingCount('void-site'), 0);
  assert.equal(g.visits('void-site'), 1);
});

test('schedule cues stay in sane audio bounds and preserve memo text', () => {
  const g = new EchoGeography(777);
  g.recordFootstepBurst('long-hall', 0, 8);
  g.recordMemoMoment('long-hall', 60, 'check the ceiling tiles');
  g.recordMemoMoment('long-hall', 90, 'it heard me say that');
  const cues = g.enterSite('long-hall');
  assert.equal(cues.length, 10);
  let prev = -Infinity;
  for (const q of cues) {
    assert.ok(q.delaySec >= 1.2, 'delay below minimum');
    assert.ok(q.gain > 0 && q.gain <= 1, 'gain out of range');
    assert.ok(q.distanceM >= 9 && q.distanceM <= 28, 'distance out of band');
    if (q.kind === 'memo' && q.memoText === 'check the ceiling tiles') prev = q.delaySec;
  }
  assert.ok(prev > 0, 'first memo text preserved verbatim');
  assert.equal(cues[cues.length - 1].memoText, 'it heard me say that');

  // long recordings are compressed into the max window: last delay bounded
  const last = cues[cues.length - 1];
  assert.ok(last.delaySec <= 2.6 + 6 + 0.18 + 1e-9, 'compressed window exceeded');
});

console.log('echogeography-test: all checks passed');
