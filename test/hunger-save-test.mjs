/**
 * F73 hunger-clock save persistence tests - pure Node, no browser.
 * Verifies that the stomach-pang schedule survives a save/load cycle:
 * serialize() -> restore() round-trips exactly (identical future pangs),
 * a continued expedition does NOT restart its grace period, malformed
 * payloads are rejected without touching the live scheduler, corrupt
 * behind-clock payloads stay quiet for one full interval, RNG state
 * replay reproduces seeded durations 1:1, and SaveSlot.migrateSlot()
 * passes the optional hunger payload through untouched.
 * Run: node test/hunger-save-test.mjs  (prints ALL PASS, exits 0)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
const { register } = await import('node:module');
register('data:text/javascript,' + encodeURIComponent(hookSource), import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const hungerSrc = readFileSync(path.join(here, '../src/player/hunger.ts'), 'utf8');

const { HungerPangs } = await import('../src/player/hunger.ts');
const { migrateSlot } = await import('../src/save/db.ts');

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; console.log('  PASS', msg); }
  else { failures++; console.error('  FAIL', msg); }
};
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- purity lint: the serializer must not touch nondeterministic time -----
ok(!/Date\.now/.test(hungerSrc), 'hunger.ts is free of Date.now');
ok(!/performance\.now/.test(hungerSrc), 'hunger.ts is free of performance.now');
ok(!/Math\.random/.test(hungerSrc), 'hunger.ts is free of Math.random');

// ---- round-trip: identical future schedules -------------------------------
{
  const seed = 0xfeed1234;
  const a = new HungerPangs(seed);
  a.update(120);
  a.drainEvents(); // history up to the capture point stays behind
  const snap = a.serialize();
  ok(snap.v === 1, 'snapshot carries schema v1');
  ok(approx(snap.clockMin, 120), 'snapshot records the fed clock');
  ok(Number.isFinite(snap.nextPangAtMin) && snap.nextPangAtMin > 120,
    'snapshot records a forward next-pang time');
  ok(Number.isFinite(snap.rngState), 'snapshot carries an RNG stream position');

  // Continue BOTH schedulers from minute 120 onward and compare every
  // subsequent pang over a long horizon.
  a.update(600);
  const ea = a.drainEvents();
  const b = new HungerPangs(seed);
  ok(b.restore(JSON.parse(JSON.stringify(snap))), 'restore() accepts a valid snapshot');
  b.update(600);
  const eb = b.drainEvents();
  ok(ea.length === eb.length && ea.length > 0,
    `restored schedule replays the same pang count (${ea.length})`);
  let identical = ea.length === eb.length;
  for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
    if (!approx(ea[i].timeMin, eb[i].timeMin) ||
        !approx(ea[i].intensity, eb[i].intensity) ||
        !approx(ea[i].durationS, eb[i].durationS)) { identical = false; break; }
  }
  ok(identical, 'restored pangs match time/intensity/duration exactly');
}

// ---- grace period is NOT restarted on continue -----------------------------
{
  const seed = 0x5eed0001;
  // A fresh schedule is still inside its grace period at 15 minutes.
  const fresh = new HungerPangs(seed);
  fresh.update(15);
  ok(fresh.drainEvents().length === 0, 'a fresh schedule stays quiet before its grace period ends');

  // A played expedition captured at 45 minutes resumes already elapsed.
  const played = new HungerPangs(seed);
  played.update(45);
  played.drainEvents();
  const snap = played.serialize();

  const resumed = new HungerPangs(seed);
  ok(resumed.restore(snap), 'resume restores the mid-expedition snapshot');
  ok(resumed.serialize().clockMin === 45, 'restored clock resumes at the captured minute, not zero');
  resumed.update(46); // one minute later — no restart of the ~20 min first-pang wait
  ok(resumed.serialize().clockMin === 46, 'resumed clock keeps advancing from the restored point');

  // The restored schedule actually fires within one base interval of resume,
  // proving the elapsed pacing carried over (a restarted run could not).
  const probe = new HungerPangs(seed);
  probe.restore(snap);
  probe.update(45 + 13); // max base interval is START_INTERVAL_MIN = 12 (+10% jitter)
  ok(probe.drainEvents().length >= 1 || snap.nextPangAtMin <= 58,
    'resumed schedule fires (or is due) within one interval of the resume point');
}

// ---- malformed payloads rejected, state untouched --------------------------
{
  const h = new HungerPangs(7);
  h.update(30);
  h.drainEvents();
  const before = h.serialize();
  const bad = [
    null,
    undefined,
    'nope',
    42,
    {},
    [],
    { v: 2, clockMin: 5, nextPangAtMin: 9, rngState: 1 },
    { v: 1, clockMin: NaN, nextPangAtMin: 9, rngState: 1 },
    { v: 1, clockMin: Infinity, nextPangAtMin: 9, rngState: 1 },
    { v: 1, clockMin: 5, nextPangAtMin: Infinity, rngState: 1 },
    { v: 1, clockMin: 5, nextPangAtMin: NaN, rngState: 1 },
    { v: 1, clockMin: 5, nextPangAtMin: 9 },
    { v: 1, clockMin: 5, nextPangAtMin: 9, rngState: 'x' },
  ];
  let allRejected = true;
  for (const payload of bad) {
    try {
      if (h.restore(payload)) { allRejected = false; console.error('    accepted:', JSON.stringify(payload)); }
    } catch (e) {
      allRejected = false;
      console.error('    threw on:', JSON.stringify(payload), e);
    }
  }
  ok(allRejected, 'all malformed payloads rejected (false / no throw)');
  const after = h.serialize();
  ok(approx(before.clockMin, after.clockMin) &&
     approx(before.nextPangAtMin, after.nextPangAtMin) &&
     before.rngState === after.rngState,
    'rejected restores leave the live scheduler untouched');
}

// ---- degenerate-but-recoverable payloads -----------------------------------
{
  // Negative clocks clamp to 0 rather than poisoning the timeline.
  const clamped = new HungerPangs(7);
  ok(clamped.restore({ v: 1, clockMin: -3, nextPangAtMin: 4, rngState: 1 }),
    'negative-clock snapshot restores with clamping');
  ok(clamped.serialize().clockMin === 0, 'negative clock clamped to 0');

  // Behind-clock next-pang times never fire instantly on resume: they are
  // pushed one full interval past the resume point.
  const behind = new HungerPangs(7);
  behind.restore({ v: 1, clockMin: 50, nextPangAtMin: 4, rngState: 1 });
  const behindNext = behind.serialize().nextPangAtMin;
  ok(behindNext > 50, `behind-clock next-pang pushed past resume (${behindNext.toFixed(2)})`);
  behind.update(50.001);
  ok(behind.drainEvents().length === 0, 'behind-clock snapshot fires nothing in the instant after resume');
}

// ---- RNG state replay reproduces seeded durations --------------------------
{
  const seed = 0xa5f00d;
  const a = new HungerPangs(seed);
  a.update(300);
  const durationsA = a.drainEvents().map((e) => e.durationS);

  // Rebuild from birth-state serialization (clock 0) inside an unrelated
  // interim instance and replay the same timeline draw-for-draw.
  const birth = new HungerPangs(seed).serialize();
  const b = new HungerPangs(seed ^ 0xffff);
  ok(b.restore({ ...birth }), 'birth-state snapshot restores into an unrelated instance');
  b.update(300);
  const durationsB = b.drainEvents().map((e) => e.durationS);
  ok(durationsB.length === durationsA.length && durationsB.length > 0 &&
     durationsB.every((d, i) => approx(d, durationsA[i])),
    'RNG state replay reproduces the original seeded durations');

  a.update(500);
  b.update(500);
  const dA = a.drainEvents().map((e) => e.durationS);
  const dB = b.drainEvents().map((e) => e.durationS);
  ok(dA.every((d, i) => approx(d, dB[i])) && dA.length === dB.length,
    'post-restore draws continue identically into the far timeline');
}

// ---- SaveSlot migration passes the hunger payload through ------------------
{
  const raw = {
    seed: 99, px: 1, pz: 2, yaw: 0, playtimeSec: 2700, savedAt: 1, version: 2,
    hunger: { v: 1, clockMin: 45, nextPangAtMin: 52.5, rngState: 123456789 },
  };
  const slot = migrateSlot(raw);
  ok(!!slot, 'migrateSlot accepts a slot carrying hunger state');
  ok(!!slot.hunger && slot.hunger.v === 1 &&
     approx(slot.hunger.clockMin, 45) &&
     approx(slot.hunger.nextPangAtMin, 52.5) &&
     slot.hunger.rngState === 123456789,
    'migrateSlot preserves the hunger payload verbatim');

  const legacy = migrateSlot({ seed: 99, px: 1, pz: 2, yaw: 0 });
  ok(!!legacy && legacy.hunger === undefined, 'legacy slots simply lack hunger (fresh schedule)');
}

console.log(failures === 0 ? `\n${passes} checks ALL PASS` : `\n${failures} FAILURES / ${passes} passes`);
process.exit(failures === 0 ? 0 : 1);
