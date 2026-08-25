/**
 * Gamepad mount tests — whole-input-path accessibility wiring.
 * Pure Node, no GPU. Verifies the whole chain:
 *   merge      Input merges a polled pad into down()/padLook: stick gates
 *              synthesize WASD, RT synthesizes ShiftLeft, LT toggles a crouch
 *              LATCH (controller stays hold-to-crouch), disconnect clears
 *              every transient, keyboard state is never touched;
 *   controller PlayerController turns rate-based off padLook (scaled by dt,
 *              framerate-independent) and walks/crouches from synthesized
 *              keys under NullEngine-free stubs;
 *   wiring     game.ts greps: one construction site, attach, per-frame poll,
 *              edge routing through the SAME action methods as the keyboard,
 *              beginRun transient reset, Start->pause().
 * Run: node test/gamepad-wiring-test.mjs  (prints ALL PASS, exits 0)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEsbuild() {
  try { return require('esbuild'); } catch { /* fall through */ }
  const nm = path.join(root, 'node_modules');
  const candidates = [];
  const pnpm = path.join(nm, '.pnpm');
  if (fs.existsSync(pnpm)) {
    for (const d of fs.readdirSync(pnpm)) {
      if (d.startsWith('esbuild@')) candidates.push(path.join(pnpm, d, 'node_modules', 'esbuild'));
    }
  }
  candidates.push(path.join(nm, 'esbuild'));
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error('esbuild not found under ' + nm + ' (is vite installed?)');
}
const esbuild = loadEsbuild();

let failures = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { passes++; }
  else { failures++; console.error('FAIL:', msg); }
};

const here = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------- minimal DOM stubs --- */
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  addEventListener() {},
  pointerLockElement: null,
};

async function bundle(entry) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-padwiring-'));
  const out = path.join(tmp, path.basename(entry).replace(/\.ts$/, '.mjs'));
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
  });
  return await import(out);
}

function makePad(index, id) {
  const effects = [];
  const pad = {
    index, id, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    vibrationActuator: {
      playEffect(type, params) { effects.push({ type, params }); return Promise.resolve('x'); },
    },
  };
  pad.effects = effects;
  return { pad, effects };
}

/* --------------------------------------------------------- merge stage --- */
{
  const { Input, GAMEPAD_TURN_RATE, PAD_MOVE_GATE } = await bundle('src/core/input.ts');
  const { GamepadManager, processStick, DEFAULT_DEADZONE } = await bundle('src/player/gamepad.ts');

  ok(GAMEPAD_TURN_RATE > 0, 'GAMEPAD_TURN_RATE exported positive');
  ok(PAD_MOVE_GATE > 0 && PAD_MOVE_GATE < 0.5, 'PAD_MOVE_GATE is a sane digital gate');

  const canvas = { requestPointerLock() {} };
  const input = new Input(canvas);
  let pads = [null, null];
  const mgr = new GamepadManager({ getGamepads: () => pads });
  input.attachGamepad(mgr);

  // no adapter / no pad: harmless
  ok(input.updateGamepad() === null || input.updateGamepad(), 'updateGamepad runs without a pad present');
  const bare = new Input(canvas);
  ok(bare.updateGamepad() === null, 'updateGamepad is a no-op before attachGamepad');

  // deadzone-level deflection must NOT synthesize movement
  const { pad } = makePad(1, 'Wired Pad');
  pads[1] = pad;
  input.updateGamepad();
  pad.axes[1] = -0.5; // gentle push: curved output below the gate
  const gentleMag = processStick(0, -0.5, DEFAULT_DEADZONE)[1];
  input.updateGamepad();
  ok(gentleMag < PAD_MOVE_GATE && !input.down('KeyW'),
    'gentle push below the gate does not synthesize KeyW (' + gentleMag.toFixed(3) + ')');

  // firm push walks, and it is the KEYBOARD surface that lights up
  pad.axes[1] = -1;
  input.updateGamepad();
  ok(input.down('KeyW'), 'stick up synthesizes KeyW');
  ok(!input.keys.has('KeyW'), 'synthesized key never pollutes the physical key set');
  ok(!input.down('KeyS') && !input.down('KeyA') && !input.down('KeyD'), 'opposite directions stay clean');
  pad.axes[1] = 1;
  input.updateGamepad();
  ok(input.down('KeyS') && !input.down('KeyW'), 'stick down flips to KeyS');

  // analog look lands in padLook
  pad.axes[1] = 0; pad.axes[2] = 0.6;
  input.updateGamepad();
  ok(input.padLook.x > 0 && input.padLook.y === 0, 'look stick feeds padLook.x');
  ok(Math.abs(input.padLook.x - processStick(0.6, 0, DEFAULT_DEADZONE)[0]) < 1e-12,
    'padLook carries the deadzoned+curved value verbatim');

  // sprint hold
  pad.axes[2] = 0;
  pad.buttons[7] = { pressed: true, value: 0.9 }; // RT
  input.updateGamepad();
  ok(input.down('ShiftLeft'), 'RT hold synthesizes ShiftLeft');
  pad.buttons[7] = { pressed: false, value: 0 };

  // crouch TOGGLE latch against the hold-based controller
  pad.buttons[6] = { pressed: true, value: 0.8 }; // LT press edge
  input.updateGamepad();
  ok(input.down('KeyC'), 'LT press latches crouch on');
  pad.buttons[6] = { pressed: false, value: 0 };
  input.updateGamepad();
  ok(input.down('KeyC'), 'latch survives releasing LT');
  pad.buttons[6] = { pressed: true, value: 0.8 };
  input.updateGamepad();
  pad.buttons[6] = { pressed: false, value: 0 };
  input.updateGamepad();
  ok(!input.down('KeyC'), 'second LT press unlatches');
  pad.buttons[6] = { pressed: true, value: 0.8 };
  input.updateGamepad();

  // keyboard and pad coexist: physical KeyC holds regardless of latch state
  input.updateGamepad();
  ok(input.down('KeyC'), 'latched again for the disconnect test');
  pads = [null];
  input.updateGamepad(); // fires onDisconnect -> clearPadState
  ok(!input.down('KeyC') && !input.down('ShiftLeft'), 'disconnect clears synthesized keys');
  ok(input.padLook.x === 0 && input.padLook.y === 0, 'disconnect zeroes padLook');

  // resetGamepadTransient clears a fresh latch (beginRun path)
  pads = [pad];
  input.updateGamepad();
  pad.buttons[6] = { pressed: true, value: 0.8 };
  input.updateGamepad();
  ok(input.down('KeyC'), 'reconnected pad can latch again');
  input.resetGamepadTransient();
  ok(!input.down('KeyC'), 'resetGamepadTransient clears the latch');

  // keyboard surface untouched by any of this
  bare.keys.add('KeyW');
  ok(bare.down('KeyW'), 'keyboard-only Input keeps working');
}

/* ---------------------------------------------------- controller stage --- */
{
  const { Input, GAMEPAD_TURN_RATE } = await bundle('src/core/input.ts');
  const { PlayerController } = await bundle('src/player/controller.ts');
  const { GamepadManager } = await bundle('src/player/gamepad.ts');

  const canvas = { requestPointerLock() {} };
  const mk = () => {
    const input = new Input(canvas);
    const camera = {
      position: { set() {} },
      rotation: { set() {}, z: 0 },
      fov: 1.25,
    };
    const pc = new PlayerController(camera, input, {});
    pc.enabled = true;
    pc.wakeT = 0;
    return { input, pc };
  };

  // rate-based turn: yaw += padLook.x * RATE * dt
  {
    const { input, pc } = mk();
    let pads = [{ index: 0, id: 'p', connected: true, axes: [0, 0, 0.75, 0], buttons: [] }];
    input.attachGamepad(new GamepadManager({ getGamepads: () => pads }));
    input.updateGamepad();
    const yaw0 = pc.yaw;
    pc.update(0.1, []);
    const d1 = pc.yaw - yaw0;
    ok(d1 > 0, 'rightward padLook yaws right');
    ok(Math.abs(d1 - input.padLook.x * GAMEPAD_TURN_RATE * 0.1) < 1e-9,
      'turn follows padLook * GAMEPAD_TURN_RATE * dt exactly');
    // framerate independence: two half-steps equal one full step
    const total = d1;
    const { input: i2, pc: pc2 } = mk();
    i2.attachGamepad(new GamepadManager({ getGamepads: () => pads }));
    i2.updateGamepad();
    const yaw2 = pc2.yaw; // controller spawns at yaw = Math.PI — compare deltas
    pc2.update(0.05, []);
    pc2.update(0.05, []);
    ok(Math.abs((pc2.yaw - yaw2) - total) < 1e-9, 'two 50ms frames turn identically to one 100ms frame');
  }

  // pitch clamp still applies to pad-driven look
  {
    const { input, pc } = mk();
    const lim = Math.PI / 2 - 0.02;
    const pads = [{ index: 0, id: 'p', connected: true, axes: [0, 0, 0, -1], buttons: [] }];
    input.attachGamepad(new GamepadManager({ getGamepads: () => pads }));
    input.updateGamepad();
    for (let i = 0; i < 40; i++) pc.update(0.1, []);
    ok(pc.pitch <= lim + 1e-9, 'pad-driven pitch respects the existing clamp');
  }

  // walking + crouching come through the synthesized keys
  {
    const { input, pc } = mk();
    const pad = makePad(0, 'p').pad;
    pad.axes[1] = -1;
    pad.buttons[6] = { pressed: true, value: 0.8 };
    const pads = [pad];
    input.attachGamepad(new GamepadManager({ getGamepads: () => pads }));
    input.updateGamepad();
    const z0 = pc.body.z;
    pc.update(0.25, []);
    ok(pc.body.z !== z0, 'synthesized KeyW moves the body');
    ok(pc.crouching === true, 'latched crouch reaches the controller stance');
    ok(pc.eye < 1.62, 'crouch eye height engaged');
  }
}

/* ------------------------------------------------------- wiring greps --- */
{
  const game = readFileSync(path.join(here, '..', 'src', 'core', 'game.ts'), 'utf8');
  const count = (s) => game.split(s).length - 1;

  ok(count('new GamepadManager()') === 1, 'exactly one GamepadManager construction site');
  ok(game.includes('this.input.attachGamepad(this.gamepad)'), 'manager attaches into Input at init');
  ok(game.includes("import { GamepadManager } from '../player/gamepad'"), 'game.ts imports the adapter');
  ok(/this\.input\.updateGamepad\(\)/.test(game), 'frame loop polls the pad every frame');
  ok(/pf\.interactPressed && this\.state === 'playing'\) this\.pressInteractKey\(\)/.test(game),
    'A edge routes through the shared interact method');
  ok(/pf\.torchPressed && this\.state === 'playing'\) this\.pressTorchKey\(\)/.test(game),
    'X edge routes through the shared torch method');
  ok(/pf\.logPressed\) this\.toggleLogKey\(\)/.test(game), 'Y edge routes through the shared log toggle');
  ok(/pf\.pausePressed && this\.state === 'playing'\) this\.pause\(\)/.test(game),
    'Start pauses while playing');
  ok(/beginRun[\s\S]{0,200}this\.input\.resetGamepadTransient\(\)/.test(game),
    'beginRun resets pad transients');
  ok(/if \(e\.code === 'KeyE' && this\.state === 'playing'\) this\.pressInteractKey\(\);/.test(game),
    'keydown handler delegates to the same shared methods');

  const ctrl = readFileSync(path.join(here, '..', 'src', 'player', 'controller.ts'), 'utf8');
  ok(ctrl.includes('GAMEPAD_TURN_RATE'), 'controller consumes the exported turn rate');
  const inputTs = readFileSync(path.join(here, '..', 'src', 'core', 'input.ts'), 'utf8');
  ok(inputTs.includes("from '../player/gamepad'"), 'Input imports the adapter module');
  ok(!/Math\.random/.test(inputTs), 'input merge stays deterministic');
}

console.log('\n' + passes + ' checks passed' + (failures ? ', ' + failures + ' FAILED' : '') +
  (failures ? '' : ' — ALL PASS'));
process.exitCode = failures ? 1 : 0;
