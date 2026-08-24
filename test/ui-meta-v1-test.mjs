/**
 * UI/META V1 — consolidated acceptance tests for F47/F49/F93/F97.
 *
 * Covers exactly the four mission ACs against the standalone ui/ modules:
 *   F47  date-derived shared-seed derivation + UTC rollover
 *   F49  accessibility-pack toggles provably zero their effects
 *        (mocked settings -> effectors)
 *   F97  bureaucratic stamp routing table (+ queue burst safety)
 *   F93  projection raycast mount math (planeFrame/raycastPlane/
 *        faceTowards/DiegeticMenu coplanarity)
 *
 * Standalone in Node; the TS modules are bundled with esbuild (found in
 * the pnpm store, as in tracker-test.mjs / formtoasts-test.mjs).
 *
 *   node test/ui-meta-v1-test.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

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

const outDir = mkdtempSync(join(tmpdir(), 'uimeta-'));
const esbuild = loadEsbuild();
esbuild.buildSync({
  entryPoints: [{
    in: 'test/ui-meta-v1-entry.ts',
    out: 'ui-meta-bundle',
  }],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outfile: join(outDir, 'ui-meta-bundle.mjs'),
});

let passed = 0;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ': ' + e.message);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL ' + name + ': ' + e.message);
  }
}

const m = await import('file://' + join(outDir, 'ui-meta-bundle.mjs'));
const {
  DAILY_RITE_SALT, utcDateKey, dailySeed, seedFromString,
  DailyRite,
  validateAccessibilityPackOptions, createAccessibilityPack,
  DEFAULT_SPEAKER_TAGS, UNKNOWN_SPEAKER_TAG, ZERO_SHAKE, HIGH_CONTRAST_PALETTE,
  paletteCssText, resolveHighContrastPalette,
  FORM_IRONIC_DENIALS, routeStamp, formNumber, formHeading,
  FormToasts, FORM_QUEUE_VISIBLE,
  planeFrame, raycastPlane, faceTowards, labelAspectRatio,
  DiegeticMenu,
} = m;

/* ------------------------------------------------------------------ */
/* F47 — date-derived shared seed                                       */
/* ------------------------------------------------------------------ */

check('F47 utcDateKey formats UTC calendar date', () => {
  assert.equal(utcDateKey(new Date(Date.UTC(2026, 7, 24))), '2026-08-24');
  assert.equal(utcDateKey(new Date(Date.UTC(2024, 1, 29))), '2024-02-29');
  // local-timezone boundary crossing must not leak into the key
  const d = new Date(Date.UTC(2025, 11, 31, 23, 59));
  assert.equal(utcDateKey(d), '2025-12-31');
});

check('F47 daily seed is pure function of the date string', () => {
  assert.equal(dailySeed('2026-08-24'), dailySeed('2026-08-24'));
  assert.notEqual(dailySeed('2026-08-24'), dailySeed('2026-08-25'));
  // salted: disjoint from raw seedFromString space
  assert.notEqual(dailySeed('2026-08-24'), seedFromString('2026-08-24') >>> 0);
  // leap day hashes like any other string
  assert.equal(typeof dailySeed('2024-02-29'), 'number');
  assert.ok(Number.isFinite(dailySeed('2024-02-29')));
  assert.equal(DAILY_RITE_SALT >>> 0 > 0, true);
});

await checkAsync('F47 rite model derives seed + rolls over at midnight', async () => {
  const store = new Map();
  const storage = {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v) => void store.set(k, v),
  };
  let day = Date.UTC(2026, 7, 24, 12);
  const rite = new DailyRite({ storage, now: () => new Date(day) });
  assert.equal(rite.dateKey, '2026-08-24');
  assert.equal(rite.seed, dailySeed('2026-08-24'));
  // every player deriving independently gets the identical seed
  const other = new DailyRite({ storage, now: () => new Date(Date.UTC(2026, 7, 24, 3)) });
  assert.equal(other.seed, rite.seed);

  // milestones latch idempotently
  assert.equal(rite.report('notes'), false); // 1/3
  assert.equal(rite.report('notes'), false); // 2/3
  assert.equal(rite.report('notes'), true);  // 3/3 completes
  assert.equal(rite.report('notes'), false); // past-target reports are no-ops
  assert.equal(rite.report('landmark', 1), true);
  assert.equal(rite.report('blackout', 1), true);
  assert.equal(rite.complete, true);

  // rollover starts a fresh rite with the new day's seed
  day = Date.UTC(2026, 7, 25, 0, 30);
  assert.equal(rite.tick(), true);
  assert.equal(rite.dateKey, '2026-08-25');
  assert.equal(rite.seed, dailySeed('2026-08-25'));
  assert.equal(rite.complete, false);
  assert.equal(rite.progress.notes.count, 0);
  // same-day tick is a no-op
  assert.equal(rite.tick(), false);
});

/* ------------------------------------------------------------------ */
/* F49 — toggle zeroing via mocked settings                             */
/* ------------------------------------------------------------------ */

check('F49 junk settings fail loud', () => {
  for (const junk of [null, 'x', 42, {}, { motionSafety: true }, { motionSafety: 1, speakerTags: false, highContrast: false }]) {
    assert.throws(() => validateAccessibilityPackOptions(junk), TypeError);
  }
});

check('F49 all-off pack is the identity everywhere', () => {
  const off = createAccessibilityPack({ motionSafety: false, speakerTags: false, highContrast: false });
  const shakeVec = { x: 0.3, y: -0.7, z: 0.9 };
  assert.equal(off.filterShake(shakeVec), shakeVec); // passthrough by reference
  assert.equal(off.filterTilt(0.42), 0.42);
  assert.equal(off.tagSubtitle('watcher', 'it sees you'), 'it sees you');
  assert.equal(off.palette(), null);
  assert.equal(paletteCssText(null), '');
  assert.equal(resolveHighContrastPalette({ motionSafety: false, speakerTags: false, highContrast: false }), null);
});

check('F49 motionSafety zeroes shake + tilt outputs', () => {
  const on = createAccessibilityPack({ motionSafety: true, speakerTags: false, highContrast: false });
  const zeroed = on.filterShake({ x: 5, y: -9, z: 2 });
  assert.deepEqual([zeroed.x, zeroed.y, zeroed.z], [ZERO_SHAKE.x, ZERO_SHAKE.y, ZERO_SHAKE.z]);
  assert.equal(on.filterTilt(123.4), 0);
  assert.equal(on.filterTilt(-0.001), 0);
});

check('F49 speakerTags prefixes bracketed tags incl [VENT]', () => {
  const on = createAccessibilityPack({ motionSafety: false, speakerTags: true, highContrast: false });
  for (const [speaker, tag] of Object.entries(DEFAULT_SPEAKER_TAGS)) {
    assert.equal(on.tagSubtitle(speaker, 'line'), tag + ' line');
  }
  assert.equal(DEFAULT_SPEAKER_TAGS['vent'], '[VENT]');
  assert.equal(on.tagSubtitle('VENT', 'air moves'), '[VENT] air moves'); // case-insensitive
  assert.equal(on.tagSubtitle('nobody', '???'), UNKNOWN_SPEAKER_TAG + ' ???');
  // off-state stays byte-identical to untagged output
  const off = createAccessibilityPack({ motionSafety: false, speakerTags: false, highContrast: false });
  assert.equal(off.tagSubtitle('vent', 'air moves'), 'air moves');
});

check('F49 highContrast emits theme token swap only when on', () => {
  const on = createAccessibilityPack({ motionSafety: false, speakerTags: false, highContrast: true });
  const pal = on.palette();
  assert.ok(pal);
  assert.equal(pal.bgLift, HIGH_CONTRAST_PALETTE.bgLift);
  const css = paletteCssText(pal);
  assert.ok(css.includes('--bmb-hc-bg-lift: 0.240;'));
  assert.ok(css.includes('--bmb-hc-text-boost: 1.400;'));
  assert.ok(css.includes('--bmb-hc-outline-strength: 0.850;'));
  // clamping keeps injected palettes sane
  const clamped = resolveHighContrastPalette(
    { motionSafety: false, speakerTags: false, highContrast: true },
    { bgLift: 7, textBoost: 99, outlineStrength: -3 },
  );
  assert.deepEqual(clamped, { bgLift: 1, textBoost: 2, outlineStrength: 0 });
});

check('F49 toggles are independent of one another', () => {
  const mixed = createAccessibilityPack({ motionSafety: true, speakerTags: true, highContrast: false });
  assert.deepEqual(mixed.filterShake({ x: 1, y: 1, z: 1 }), { x: 0, y: 0, z: 0 });
  assert.ok(mixed.tagSubtitle('helper', 'go').startsWith(DEFAULT_SPEAKER_TAGS['helper'] + ' '));
  assert.equal(mixed.palette(), null); // untouched third toggle stays off
});

/* ------------------------------------------------------------------ */
/* F97 — stamp routing table                                            */
/* ------------------------------------------------------------------ */

check('F97 ironic requests are always DENIED', () => {
  assert.ok(FORM_IRONIC_DENIALS.length >= 4);
  for (const id of FORM_IRONIC_DENIALS) assert.equal(routeStamp(id), 'DENIED');
  // table wins over the hash fallback even if a hash would approve
  assert.equal(routeStamp(FORM_IRONIC_DENIALS[0]), 'DENIED');
});

check('F97 routing is deterministic per id and total', () => {
  const ids = ['FIRST_STEPS', 'FIRST_BEACON', 'HALF_WAY', 'ALL_BEACONS', 'LANDMARK_VISITOR', 'NOTE_COLLECTOR', 'SURVIVOR'];
  for (const id of ids) {
    assert.equal(routeStamp(id), routeStamp(id));
    assert.ok(routeStamp(id) === 'APPROVED' || routeStamp(id) === 'DENIED');
  }
  // the hash fallback does deny some non-ironic ids (~1 in 6)
  let denied = 0;
  for (let i = 0; i < 60; i++) if (routeStamp('GENERIC_' + i) === 'DENIED') denied++;
  assert.ok(denied > 0 && denied < 60, 'hash fallback should split outcomes');
});

check('F97 form numbers are deterministic and well-formed', () => {
  for (const id of ['FIRST_STEPS', 'PERMIT_TO_LEAVE']) {
    assert.equal(formNumber(id), formNumber(id));
    assert.match(formNumber(id), /^\d{3}-[A-Z]$/);
  }
  assert.equal(formHeading('FIRST_STEPS', 'RECOGNITION_OF_MOTION'),
    'FORM ' + formNumber('FIRST_STEPS') + ' \u2014 REQUEST: RECOGNITION_OF_MOTION');
});

await checkAsync('F97 queue never drops bursts; stamps ride the forms', async () => {
  const filed = [];
  const q = new FormToasts({
    onFiled: (rec) => void filed.push(rec.id),
  });
  const ids = [...FORM_IRONIC_DENIALS.slice(0, 2), 'FIRST_STEPS', 'ALL_BEACONS', 'SURVIVOR', 'HALF_WAY'];
  const recs = ids.map((id) => q.push({ id, request: 'TEST_REQUEST' }));
  assert.equal(q.pushedCount, ids.length);
  assert.equal(q.activeForms.length, FORM_QUEUE_VISIBLE);
  assert.equal(q.queuedCount, ids.length - FORM_QUEUE_VISIBLE);
  // ironic ids carry DENIED onto their record
  assert.equal(recs[0].stamp, 'DENIED');
  assert.ok(recs.every((r) => r.stamp === 'APPROVED' || r.stamp === 'DENIED'));

  // drive time until everything files away (bounded loop)
  let ticks = 0;
  while ((q.activeForms.length > 0 || q.queuedCount > 0) && ticks < 20000) {
    q.update(16);
    ticks++;
  }
  assert.equal(q.filedCount, ids.length);
  assert.equal(q.droppedAny, false);
  assert.deepEqual(filed.sort(), [...ids].sort());
});

/* ------------------------------------------------------------------ */
/* F93 — projection raycast mount math                                  */
/* ------------------------------------------------------------------ */

check('F93 plane frame is orthonormal', () => {
  const f = planeFrame({ origin: [1, 2, 3], normal: [0, 0, -1], up: [0, 1, 0] });
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const v of [f.right, f.up, f.normal]) assert.ok(Math.abs(dot(v, v) - 1) < 1e-9);
  assert.ok(Math.abs(dot(f.right, f.up)) < 1e-9);
  assert.ok(Math.abs(dot(f.up, f.normal)) < 1e-9);
  assert.ok(Math.abs(dot(f.right, f.normal)) < 1e-9);
  // handedness: right x up == normal
  const cross = [
    f.right[1] * f.up[2] - f.right[2] * f.up[1],
    f.right[2] * f.up[0] - f.right[0] * f.up[2],
    f.right[0] * f.up[1] - f.right[1] * f.up[0],
  ];
  assert.ok(Math.abs(dot(cross, f.normal) - 1) < 1e-9);
});

check('F93 degenerate wall planes fail loud', () => {
  assert.throws(() => planeFrame(null), /degenerate wall plane/);
  assert.throws(() => planeFrame({ origin: [NaN, 0, 0], normal: [0, 0, 1], up: [0, 1, 0] }), /degenerate wall plane/);
  assert.throws(() => planeFrame({ origin: [0, 0, 0], normal: [0, 0, 0], up: [0, 1, 0] }), /zero-length normal/);
  assert.throws(() => planeFrame({ origin: [0, 0, 0], normal: [0, 0, 1], up: [0, 0, 2] }), /collinear/);
});

check('F93 raycastPlane lands exactly on the wall', () => {
  const plane = { origin: [0, 0, -4], normal: [0, 0, 1], up: [0, 1, 0] };
  const hit = raycastPlane([1, 1.5, 2], [0.5, 0, -6], plane);
  assert.ok(hit);
  assert.ok(Math.abs(hit[2] - (-4)) < 1e-9);      // on the plane
  assert.ok(Math.abs(hit[0] - 1.5) < 1e-9);        // t = 1 along rd
  assert.ok(Math.abs(hit[1] - 1.5) < 1e-9);
  // parallel rays miss; rays pointing away miss; junk misses
  assert.equal(raycastPlane([0, 0, 0], [1, 0, 0], plane), null);
  assert.equal(raycastPlane([0, 0, 0], [0, 0, 1], plane), null);
  assert.equal(raycastPlane([NaN, 0, 0], [0, 0, -1], plane), null);
});

check('F93 faceTowards aims the readable side at the viewer', () => {
  const wall = { origin: [0, 0, -4], normal: [0, 0, 1], up: [0, 1, 0] };
  const front = faceTowards(wall, [0, 1.6, 0]);   // already facing viewer
  const back = faceTowards(wall, [0, 1.6, -8]);   // viewer behind the wall
  assert.ok(front.normal[2] > 0);
  assert.ok(back.normal[2] < 0);
});

await checkAsync('F93 menu projection is coplanar + cursor wraps', async () => {
  const content = {
    id: 't', title: 'BACKROOMS: MEMORY BLEED',
    items: [
      { id: 'new', label: 'NEW EXPEDITION' },
      { id: 'cont', label: 'CONTINUE' },
      { id: 'set', label: 'SETTINGS' },
    ],
  };
  const menu = new DiegeticMenu(content, { origin: [0, 1.55, -4], normal: [0, 0, 1], up: [0, 1, 0] });
  assert.equal(menu.selectedId, 'new');
  menu.input('down');
  assert.equal(menu.selectedId, 'cont');
  menu.input('up'); menu.input('up');
  assert.equal(menu.selectedId, 'set');           // wrapped first -> last
  menu.input('down');
  assert.equal(menu.selectedId, 'new');           // wrapped last -> first

  const proj = menu.project();
  const f = planeFrame({ origin: [0, 1.55, -4], normal: [0, 0, 1], up: [0, 1, 0] });
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const coplanar = (quad) =>
    quad.every((p) => Math.abs(dot([p[0] - 0, p[1] - 1.55, p[2] + 4], f.normal)) < 1e-9);
  assert.ok(coplanar(proj.titleQuad));
  for (const it of proj.items) {
    assert.ok(coplanar(it.quad));
    assert.ok(it.aspect >= 1.2 && it.aspect <= 16); // aspect clamp contract
  }
  assert.ok(coplanar(proj.highlightQuad));
  assert.equal(labelAspectRatio('CONTINUE'), Math.min(16, 'CONTINUE'.length * 0.6));
});

/* ------------------------------------------------------------------ */
console.log('UI_META_V1 ' + (failures === 0 ? 'PASS' : 'FAIL') +
  ' checks=' + (passed + failures) + ' failures=' + failures);
if (failures > 0) process.exitCode = 1;
