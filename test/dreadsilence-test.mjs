/*
 * Headless tests for the dread silence director duck (feature F6).
 *
 * DreadSilence is a pure scheduler over an injected gain parameter, so
 * these run in plain Node against a recording stub bus and prove the
 * acceptance criteria on the scripted automation timeline:
 *   1. duck curve: master gain scheduled below -24 dB within <= 1 s,
 *      held flat, returned to >= -1 dB over a >= 2 s exhale ramp
 *   2. hold durations drawn from the seeded RNG always land in [8, 20]
 *      and are deterministic for a fixed seed
 *   3. ration: a second requestDuck inside the 25-minute window returns
 *      false; canDuck() reports when the window has cleared
 *   4. lifecycle phases progress idle -> ducking -> holding ->
 *      recovering -> idle along the session clock
 *
 * Run: node test/dreadsilence-test.mjs
 */
// Project sources import each other without extensions (bundler-style).
// Node's strip-types loader needs explicit extensions, so register a
// resolve hook that retries with '.ts' appended when plain resolution fails.
let hooksRegistered = false;
try {
  const { registerHooks } = await import('node:module');
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        return nextResolve(specifier + '.ts', context);
      }
    },
  });
  hooksRegistered = true;
} catch {
  hooksRegistered = false; // older Node without synchronous module hooks
}
if (!hooksRegistered) console.warn('  note: no resolve hook available; test may fail to load sources');
const {
  DreadSilence,
  DUCK_ATTACK_SEC,
  DUCK_FLOOR_LINEAR,
  DUCK_RETURN_LINEAR,
  EXHALE_SEC,
  HOLD_MIN_SEC,
  HOLD_MAX_SEC,
  COOLDOWN_SEC,
} = await import('../src/audio/dreadsilence.ts');

const failures = [];
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (cond ? '' : ' — ' + detail));
  if (!cond) failures.push(name);
}

/** Recording stub of the injected master-gain param. */
function makeBus() {
  const ops = [];
  const param = {
    value: 1,
    ops,
    setValueAtTime(v, t) { this.value = v; ops.push({ op: 'set', v, t }); },
    linearRampToValueAtTime(v, t) { ops.push({ op: 'linear', v, t }); },
    cancelScheduledValues() { ops.push({ op: 'cancel', v: null, t: null }); },
  };
  return { gain: param };
}

const NEG_24_DB_LINEAR = Math.pow(10, -24 / 20); // spec ceiling for the floor
const NEG_1_DB_LINEAR = Math.pow(10, -1 / 20);   // spec floor for recovery

// ---- 1. scripted timeline: the full duck curve ------------------------------
{
  const bus = makeBus();
  const dread = new DreadSilence(bus, { seed: 12345 });
  const START = 100;

  check('constants: attack within the 1 s budget', DUCK_ATTACK_SEC > 0 && DUCK_ATTACK_SEC <= 1,
    String(DUCK_ATTACK_SEC));
  check('constants: exhale meets the >= 2 s release minimum', EXHALE_SEC >= 2);
  check('constants: floor sits below -24 dB', DUCK_FLOOR_LINEAR < NEG_24_DB_LINEAR,
    `${DUCK_FLOOR_LINEAR.toFixed(4)} vs ${NEG_24_DB_LINEAR.toFixed(4)}`);
  check('constants: return target at/above -1 dB', DUCK_RETURN_LINEAR >= NEG_1_DB_LINEAR);

  check('requestDuck starts on a fresh instance', dread.requestDuck(START) === true);

  // read back the exact schedule from the audit trail
  const ramps = dread.automation.filter((e) => e.op === 'linear');
  const duckRamp = ramps[0];
  const exhaleRamp = ramps.at(-1);
  const holdEndSet = dread.automation.findLast((e) => e.op === 'set' && e.at > START);

  check('automation: gain dives below -24 dB',
    duckRamp.value < NEG_24_DB_LINEAR && holdEndSet.value < NEG_24_DB_LINEAR,
    JSON.stringify({ dive: duckRamp.value, hold: holdEndSet.value }));
  check('automation: dive completes within 1 s of the command',
    duckRamp.at - START <= 1, `${duckRamp.at - START}s`);
  const holdSec = holdEndSet.at - duckRamp.at;
  check('automation: hold duration inside [8, 20]',
    holdSec >= HOLD_MIN_SEC && holdSec <= HOLD_MAX_SEC, `${holdSec}s`);
  check('automation: recovery lands at >= -1 dB', exhaleRamp.value >= NEG_1_DB_LINEAR,
    String(exhaleRamp.value));
  check('automation: exhale ramp lasts >= 2 s',
    exhaleRamp.at - holdEndSet.at >= 2, `${exhaleRamp.at - holdEndSet.at}s`);
  check('automation: audit trail records every scheduled event',
    dread.automation.length === 4, String(dread.automation.length));
  check('lastHoldSec mirrors the drawn duration', Math.abs(dread.lastHoldSec - holdSec) < 1e-9);

  // ---- 4. lifecycle phases along the session clock ---------------------------
  check('phase: ducking during the dive',
    dread.tick(START + 0.1) === 'ducking');
  check('phase: holding through the flat floor',
    dread.tick(START + DUCK_ATTACK_SEC + holdSec / 2) === 'holding');
  check('phase: still holding just before the exhale',
    dread.tick(holdEndSet.at - 0.01) === 'holding');
  check('phase: recovering across the exhale ramp',
    dread.tick(holdEndSet.at + 0.5) === 'recovering');
  check('phase: idle after the curve completes',
    dread.tick(exhaleRamp.at + 0.01) === 'idle');
}

// ---- 3. the 25-minute ration -------------------------------------------------
{
  const bus = makeBus();
  const dread = new DreadSilence(bus, { seed: 777 });
  const START = 500;
  dread.requestDuck(START);

  check('ration: second request inside 25 min returns false',
    dread.requestDuck(START + 60) === false &&
    dread.requestDuck(START + COOLDOWN_SEC - 1) === false);
  check('ration: canDuck stays false inside the window',
    dread.canDuck(START + COOLDOWN_SEC - 1) === false);
  check('ration: canDuck flips true once the window clears',
    dread.canDuck(START + COOLDOWN_SEC) === true);
  check('ration: request exactly one cooldown later is accepted',
    dread.requestDuck(START + COOLDOWN_SEC) === true);
  check('ration: refused attempts schedule nothing',
    dread.automation.length === 8, String(dread.automation.length));

  // default clock source: canDuck() with no argument uses observed time
  const dread2 = new DreadSilence(makeBus(), { seed: 778 });
  dread2.tick(1000);
  check('ration: no-arg canDuck uses the tick-fed clock', dread2.canDuck() === true);
  dread2.requestDuck(1000);
  check('ration: no-arg canDuck refuses after an in-window duck',
    dread2.canDuck(2000) === false);

  check('guards: negative session time is refused', dread2.requestDuck(-1) === false);
}

// ---- 2. seeded durations stay in [8, 20] and reproduce -----------------------
{
  let allInWindow = true;
  let minHeld = Infinity;
  let maxHeld = -Infinity;
  for (let seed = 0; seed < 60; seed++) {
    const dread = new DreadSilence(makeBus(), { seed });
    if (!dread.requestDuck(0)) { allInWindow = false; break; }
    const h = dread.lastHoldSec;
    minHeld = Math.min(minHeld, h);
    maxHeld = Math.max(maxHeld, h);
    if (!(h >= HOLD_MIN_SEC && h <= HOLD_MAX_SEC)) allInWindow = false;
  }
  check('seeded holds: 60 seeds all land in [8, 20]', allInWindow,
    `range [${minHeld.toFixed(2)}, ${maxHeld.toFixed(2)}]`);
  check('seeded holds: the draw actually varies across seeds', maxHeld - minHeld > 1,
    `spread ${(maxHeld - minHeld).toFixed(2)}`);

  const a = new DreadSilence(makeBus(), { seed: 42 });
  const b = new DreadSilence(makeBus(), { seed: 42 });
  a.requestDuck(10);
  b.requestDuck(10);
  check('seeded holds: identical seeds draw identical durations',
    Math.abs(a.lastHoldSec - b.lastHoldSec) < 1e-12);
}

console.log(failures.length === 0
  ? '\nALL PASS'
  : `\n${failures.length} FAILURE(S): ${failures.join(', ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
