/**
 * Slide tests: sprint+crouch trigger, boost burst with half-life decay,
 * end conditions (crouch release, speed floor), cooldown, standstill guard,
 * and camera drop/pitch/turn-rate helpers.
 *
 * Runs with plain node (node test/slide-test.mjs): the TypeScript source is
 * transpiled in-memory with the repo's own typescript dep - no browser needed.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// ---- tiny CJS-in-memory loader (slide.ts has no imports) ----
function loadModule(filePath) {
  const cjs = ts.transpileModule(SRC(filePath), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', cjs)(
    () => { throw new Error('unexpected import'); },
    module,
    module.exports,
  );
  return module.exports;
}

const {
  SlideController,
  SLIDE_TRIGGER_SPEED, SLIDE_BOOST, SLIDE_HALF_LIFE,
  SLIDE_END_SPEED, SLIDE_COOLDOWN, SLIDE_PITCH, SLIDE_TURN_SCALE,
} = loadModule('src/player/slide.ts');

const EPS = 1e-9;
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b} (tol ${tol})`);

// ---- harness: fixed-step simulation ----
const DT = 1 / 60;

function makeSlide() {
  const s = new SlideController();
  let last = s.update(DT, { sprinting: false, crouching: false, speed: 0 });
  return {
    s,
    last: () => last,
    /** step once with given input, remembering the returned state */
    step(input = {}) {
      last = s.update(DT, {
        sprinting: false, crouching: false, speed: 0, ...input,
      });
      return last;
    },
    /** start a slide from a full sprint and return immediately after */
    start(speed = 4.4) {
      this.step({ sprinting: true, crouching: true, speed });
      assert.ok(s.slideActive, 'slide should have started');
      return last;
    },
  };
}

let n = 0;
const test = (name, fn) => { n++; fn(); console.log('ok  ' + name); };

// ---- trigger conditions ----

test('no slide while sprinting but not crouching', () => {
  const h = makeSlide();
  h.step({ sprinting: true, speed: 4.4 });
  assert.equal(h.s.slideActive, false);
  near(h.last().slideBoost, 1);
});

test('no slide while crouching below sprint speed (walk pace)', () => {
  const h = makeSlide();
  h.step({ sprinting: false, crouching: true, speed: SLIDE_TRIGGER_SPEED - 0.5 });


  assert.equal(h.s.slideActive, false);
});

test('sprint + crouch at speed starts the slide', () => {
  const h = makeSlide();
  h.step({ sprinting: true, crouching: true, speed: SLIDE_TRIGGER_SPEED + 0.2 });
  assert.equal(h.s.slideActive, true);
  near(h.last().slideBoost, SLIDE_BOOST);
});

// ---- boost decay ----

test('boost decays by half every SLIDE_HALF_LIFE seconds', () => {
  const h = makeSlide();
  h.start(SLIDE_TRIGGER_SPEED + 0.5);
  const stepsPerHalf = Math.round(SLIDE_HALF_LIFE / DT);
  for (let i = 0; i < stepsPerHalf; i++) h.step({ sprinting: false, crouching: true, speed: SLIDE_TRIGGER_SPEED + 0.5 });
  const afterOneHalf = h.last().slideBoost;
  near(afterOneHalf, 1 + (SLIDE_BOOST - 1) / 2, 1e-3);
  for (let i = 0; i < stepsPerHalf; i++) h.step({ sprinting: false, crouching: true, speed: SLIDE_TRIGGER_SPEED + 0.5 });
  near(h.last().slideBoost, 1 + (SLIDE_BOOST - 1) / 4, 5e-3);
});

// ---- end conditions ----

test('releasing crouch ends the slide', () => {
  const h = makeSlide();
  h.start();
  h.step({ sprinting: false, crouching: false, speed: SLIDE_TRIGGER_SPEED + 0.5 });
  assert.equal(h.s.slideActive, false);
});

test('slide ends once base speed falls below the floor', () => {
  const h = makeSlide();
  h.start(4.4);
  let speed = 4.4;
  let ended = false;
  for (let i = 0; i < 600; i++) {
    // the player released sprint: momentum bleeds off until the floor hits
    speed *= 0.95;
    h.step({ sprinting: false, crouching: true, speed });
    if (!h.s.slideActive) { ended = true; break; }
  }
  assert.ok(ended, 'slide should end once base speed drops under the floor');
  assert.ok(speed < SLIDE_END_SPEED, 'ended at speed=' + speed.toFixed(3));
  near(h.last().slideBoost, 1, 1e-6);
});

test('standstill ends the slide immediately', () => {
  const h = makeSlide();
  h.start();
  h.step({ sprinting: false, crouching: true, speed: 0 });
  assert.equal(h.s.slideActive, false);
});

// ---- cooldown ----

test('no re-trigger during the cooldown window', () => {
  const h = makeSlide();
  h.start();
  // end it
  h.step({ sprinting: false, crouching: true, speed: 0 });
  // try to restart immediately
  let restarted = false;
  try {
    h.start();
    restarted = h.s.slideActive;
  } catch { /* start() asserts slide started; a blocked restart throws */ }
  assert.equal(restarted || h.s.slideActive, false, 'cooldown must block re-slide');
  // wait out SLIDE_COOLDOWN
  const steps = Math.ceil((SLIDE_COOLDOWN * 60) / 1) + 2;
  for (let i = 0; i < Math.ceil(SLIDE_COOLDOWN / DT); i++) {
    h.step({ sprinting: false, crouching: false, speed: 0 });
  }
  void steps;
  h.step({ sprinting: true, crouching: true, speed: SLIDE_TRIGGER_SPEED + 0.2 });
  assert.equal(h.s.slideActive, true, 'after cooldown a new slide may start');
});

// ---- camera helpers ----

test('camera drop/pitch/turn-rate follow the blend', () => {
  const h = makeSlide();
  const s = h.s;
  near(s.cameraDrop, 0);             // idle: no offset
  near(s.cameraPitchOffset, 0, 1e-6);
  near(s.turnRateScale, 1, 1e-6);
  h.start();
  for (let i = 0; i < Math.ceil(0.35 / DT); i++) {
    h.step({ sprinting: false, crouching: true, speed: 4.4 });
  }
  // fully blended in: pitch at -5 deg, turn rate scaled down
  near(s.cameraPitchOffset, SLIDE_PITCH, 1e-3);
  near(s.turnRateScale, SLIDE_TURN_SCALE, 1e-3);
});

console.log('ok  ' + n + ' slide tests passed');
process.exit(0);
