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
  SLIDE_END_SPEED, SLIDE_COOLDOWN, SLIDE_PITCH,
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

(Showing lines 1-80 of 223. Use offset=81 to continue.)

