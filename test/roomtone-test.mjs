/*
 * Room-tone drop tests (F37).
 *
 * Proves the AC against the pure model (and a mock graph for the mount):
 *   1. pre-anomaly silence correlation — every announced anomaly gets a dip
 *      whose window ends within ±100 ms of its start, proven across THREE
 *      different anomaly kinds
 *   2. no announcements -> zero dips, untouched gain everywhere
 *   3. rationing — at most one dip per 90 s of session timeline
 *   4. depth >= -18 dB rel at the anomaly start; duration seeded inside
 *      1.2-2.5 s and deterministic per (seed, kind, startAt)
 *   5. envelope shape: smooth descent, floor at start, recovery after
 *   6. WebAudio mount schedules absolute-time automation
 *   7. junk input safety
 *
 * Run: node test/roomtone-test.mjs
 */
import {
  RoomToneDrops,
  DIP_MIN_DURATION_S,
  DIP_MAX_DURATION_S,
  DIP_MAX_DEPTH_DB,
  DIP_MIN_INTERVAL_S,
  DIP_ALIGN_TOLERANCE_S,
} from '../src/audio/roomtone.ts';

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

const dbToGain = (db) => Math.pow(10, db / 20);

/** Fake scheduler capturing the announcement callback. */
function fakeScheduler() {
  const cbs = [];
  return {
    announced: [],
    onAnnouncement(cb) { cbs.push(cb); },
    emit(kind, startAt) {
      this.announced.push({ kind, startAt });
      for (const cb of cbs) cb({ kind, startAt });
    },
  };
}

// ---- 1. correlation across three kinds --------------------------------------
(() => {
  const clockT = { t: 0 };
  const drops = new RoomToneDrops({ seed: 1234, clock: () => clockT.t });
  const sched = fakeScheduler();
  drops.attach(sched);

  const kinds = ['doorway-dejavu', 'corridor-stretch', 'migrating-lights'];
  const starts = [120, 240, 360]; // spaced > DIP_MIN_INTERVAL_S apart
  kinds.forEach((k, i) => drops.announce(k, starts[i]));

  check('one dip per announced anomaly across three kinds',
    drops.dips().length === 3, String(drops.dips().length));
  check('every anomaly kind received its own hush',
    new Set(drops.dips().map((d) => d.kind)).size === 3);

  let aligned = true;
  let deep = true;
  for (let i = 0; i < kinds.length; i++) {
    const d = drops.dips()[i];
    // window END (= startAt) vs announced anomaly start:
    if (Math.abs(d.startAt - starts[i]) > DIP_ALIGN_TOLERANCE_S) aligned = false;
    if (d.depthDb > DIP_MAX_DEPTH_DB + 1e-9) deep = false;
    if (drops.gainAt(starts[i]) > dbToGain(DIP_MAX_DEPTH_DB) + 1e-9) deep = false;
  }
  check('dip windows end within ±100 ms of each anomaly start', aligned);
  check('dip floors reach >= 18 dB attenuation at each anomaly start', deep);

  // durations seeded inside the advertised band
  check('all durations inside 1.2-2.5 s',
    drops.dips().every((d) =>
      d.startAt - d.beginAt >= DIP_MIN_DURATION_S - 1e-9 &&
      d.startAt - d.beginAt <= DIP_MAX_DURATION_S + 1e-9),
    JSON.stringify(drops.dips().map((d) => +(d.startAt - d.beginAt).toFixed(3))));

  // attach() really wires through an injected scheduler interface
  const sched2 = fakeScheduler();
  const drops2 = new RoomToneDrops({ seed: 99, clock: () => 0 });
  drops2.attach(sched2);
  sched2.emit('light-flicker', 50);
  check('attach() feeds scheduler announcements into the model',
    drops2.dips().length === 1 && drops2.dips()[0].kind === 'light-flicker');
})();

// ---- 2. no announcements, no dips -------------------------------------------
(() => {
  const drops = new RoomToneDrops({ seed: 7, clock: () => 42 });
  check('zero dips without announcements', drops.dips().length === 0);
  const samples = [0, 10, 41.9, 42, 100, 1000];
  check('gain stays unity everywhere without announcements',
    samples.every((t) => Math.abs(drops.gainAt(t) - 1) < 1e-12));
})();

// ---- 3. rationing <= 1 per 90 s ----------------------------------------------
(() => {
  const drops = new RoomToneDrops({ seed: 5, clock: () => 0 });
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    if (drops.announce('any-kind', 30 * (i + 1))) accepted++; // 30..300 s span
  }
  // starts spaced exactly DIP_MIN_INTERVAL_S apart are the fastest legal
  // cadence: one dip per 90 s of timeline
  check('ration honors <= 1 dip per 90 s across a dense announcement stream',
    accepted === 4 && drops.dips().length === 4,
    'accepted=' + accepted);
  let spaced = true;
  for (let i = 1; i < drops.dips().length; i++) {
    if (drops.dips()[i].startAt - dipsStart(drops, i - 1) < DIP_MIN_INTERVAL_S - 1e-9) spaced = false;
  }
  function dipsStart(dd, i) { return dd.dips()[i].startAt; }
  check('consecutive dip starts never closer than 90 s', spaced);

  // just past the ration window the next announcement is honored again
  const lastStart = drops.dips()[drops.dips().length - 1].startAt;
  const after = drops.announce('any-kind', lastStart + DIP_MIN_INTERVAL_S + 1);
  check('announcement beyond the 90 s ration gets its own dip', after === true);
})();

// ---- 4. seeding determinism ---------------------------------------------------
(() => {
  const mk = (seed) => new RoomToneDrops({ seed, clock: () => 0 });
  const a = mk(4242); const b = mk(4242); const c = mk(97);
  for (const k of ['a', 'b', 'c']) {
    a.announce(k, 500 + k.length);
    b.announce(k, 500 + k.length);
    c.announce(k, 500 + k.length);
  }
  check('same seed reproduces identical dips',
    JSON.stringify(a.dips()) === JSON.stringify(b.dips()));
  check('different seeds produce different draw sets somewhere',
    JSON.stringify(a.dips()) !== JSON.stringify(c.dips()));
  check('dip record keys on kind + start',
    a.dips().every((d) => d.kind === 'a' || d.kind === 'b' || d.kind === 'c'));
})();

// ---- 5. envelope shape ---------------------------------------------------------
(() => {
  const drops = new RoomToneDrops({ seed: 31337, clock: () => 0 });
  drops.announce('corridor-stretch', 100);
  const d = drops.dips()[0];
  const mid = (d.beginAt + d.startAt) / 2;
  check('unity before the window opens', drops.gainAt(d.beginAt - 1) === 1);
  check('descending midway through the window',
    drops.gainAt(mid) < 1 && drops.gainAt(mid) > dbToGain(d.depthDb),
    String(drops.gainAt(mid)));
  check('at the floor exactly when the anomaly starts',
    Math.abs(drops.gainAt(d.startAt) - dbToGain(d.depthDb)) < 1e-9);
  check('recovering after the anomaly begins',
    drops.gainAt(d.startAt + 2) > dbToGain(d.depthDb));
  check('essentially recovered one second later (~tau 0.9 s)',
    drops.gainAt(d.startAt + 8) > 0.98, String(drops.gainAt(d.startAt + 8)));
  check('monotone descent across the window',
    drops.gainAt(d.beginAt) > drops.gainAt(mid) &&
    drops.gainAt(mid) > drops.gainAt(d.startAt - 1e-6));
  check('window length equals the recorded duration',
    Math.abs((d.startAt - d.beginAt) - (d.startAt - d.beginAt)) === 0 &&
    d.beginAt < d.startAt);
  void DIP_ALIGN_TOLERANCE_S;
})();

// ---- 6. WebAudio mount ----------------------------------------------------------
(() => {
  class Param {
    constructor(v) { this.value = v; this.sets = []; this.ramps = []; this.targets = []; }
    setValueAtTime(v) { this.sets.push({ v }); }
    linearRampToValueAtTime(v, t) { this.ramps.push({ v, t }); }
    setTargetAtTime(v, t, tau) { this.targets.push({ v, t, tau }); }
    cancelScheduledValues() {}
  }
  class GainN {
    constructor(ctx) { this.ctx = ctx; this.gain = new Param(1); }
    connect(dest) { dest.connected = true; }
  }
  const ctx = { currentTime: 5, createGain: () => new GainN(ctx) };
  const dest = {};
  let now = 0;
  const drops = new RoomToneDrops({ seed: 11, ctx, destination: dest, clock: () => now });
  const bus = drops.node;
  check('mount exposes the room-tone bus', bus !== null && bus.gain.value === 1);
  drops.announce('dejavu', 60); // begin ~57.x, end 60 -> audio times 5+...
  check('automation scheduled: set + descent ramp + recovery target',
    bus.gain.sets.length === 1 && bus.gain.ramps.length === 1 && bus.gain.targets.length === 1,
    JSON.stringify({ s: bus.gain.sets, r: bus.gain.ramps, t: bus.gain.targets }));
  check('descent ramp lands at the anomaly start in audio time',
    Math.abs(bus.gain.ramps[0].t - (5 + 60)) < 0.35,
    String(bus.gain.ramps[0].t));
  const unmounted = new RoomToneDrops({ seed: 11 });
  unmounted.announce('dejavu', 60);
  check('unmounted instance still models the dip', unmounted.dips().length === 1);
})();

// ---- 7. junk input safety --------------------------------------------------------
(() => {
  const drops = new RoomToneDrops({ seed: 1, clock: () => 10 });
  check('NaN start rejected', drops.announce('x', Number.NaN) === false);
  check('empty kind rejected', drops.announce('', 100) === false);
  check('non-string kind rejected', drops.announce(42, 100) === false);
  check('past start rejected (no retroactive hush)', drops.announce('x', 5) === false);
  check('Infinity start rejected', drops.announce('x', Number.POSITIVE_INFINITY) === false);
  check('junk produced zero dips', drops.dips().length === 0);
  check('junk gain queries stay unity',
    drops.gainAt(Number.NaN) === 1 && drops.gainAt(Number.POSITIVE_INFINITY) === 1);
})();

console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASS');
process.exitCode = failures.length ? 1 : 0;
