/**
 * GamepadManager test (run: node test/gamepad-test.mjs)
 *
 * Bundles the REAL src/player/gamepad.ts with esbuild (same module Vite
 * ships to the browser) and drives it against a synthetic Gamepad API:
 *   1. radial deadzone + cubic response curve behaviour
 *   2. stick -> move/look mapping incl. Y inversion and sensitivity
 *   3. RT sprint hold, LT crouch TOGGLE edge, A/X/Y/Start rising edges
 *   4. vibration: vibrate() / heartbeat() / watcherFreezePulse() effects
 *   5. connect/disconnect diffing + "GAMEPAD CONNECTED" toast hook
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

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

let passed = 0;
function ok(cond, label) {
  if (!cond) {
    console.error('FAIL:', label);
    process.exitCode = 1;
  } else {
    passed++;
    console.log('ok -', label);
  }
}
function approx(a, b, eps, label) { ok(Math.abs(a - b) <= eps, label + ' (' + a + ')'); }

// ---- synthetic standard-layout pad ----
// ---- synthetic standard-layout pad ----
function makePad(index, id) {
  const effects = [];
  const pad = {
    index, id, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], // moveX, moveY, lookX, lookY
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    vibrationActuator: {
      playEffect(type, params) { effects.push({ type, params }); return Promise.resolve('complete'); },
    },
  };
  return { pad, effects };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmb-gamepad-'));
  const out = path.join(tmp, 'gamepad.node.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/player/gamepad.ts')],
    bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent',
  });
  const { GamepadManager, processStick, DEFAULT_DEADZONE } = await import(out);

  // ---- 1. response curve ----
  ok(JSON.stringify(processStick(0.05, 0, DEFAULT_DEADZONE)) === '[0,0]', 'deadzone kills sub-threshold deflection');
  const [fx, fy] = processStick(1, 0, DEFAULT_DEADZONE);
  approx(fx, 1, 1e-9, 'full throw stays at 1.0');
  approx(fy, 0, 1e-9, 'full throw keeps direction');
  // cubic ease: mid-range raw magnitude maps well below linear
  const [mx] = processStick(0.575, 0, 0.15);
  ok(mx < 0.5 && mx > 0.1, 'cubic curve softens centre response');
  // diagonal preserved directionally
  const [dx, dy] = processStick(0.70710678, 0.70710678, 0.15);
  approx(Math.hypot(dx, dy), Math.pow((Math.hypot(0.70710678, 0.70710678) - 0.15) / 0.85, 3), 1e-6, 'radial magnitude follows t^3 curve');
  approx(dx, dy, 1e-12, 'diagonal stays symmetric');

  // ---- manager wiring ----
  let pads = [];
  const mgr = new GamepadManager({ getGamepads: () => pads });
  let toasts = [], disconnects = [];
  mgr.onConnect = (i) => toasts.push(i);
  mgr.onDisconnect = (i) => disconnects.push(i);

  // no pad yet
  let f = mgr.update();
  ok(!mgr.connected, 'starts disconnected');
  ok(f.interactPressed === false && f.sprint === false && f.crouchToggle === false, 'empty frame when disconnected');

  // ---- 5. connect + toast hook ----
  const { pad, effects } = makePad(0, 'Test Pad (Vendor 046d)');
  pads = [null, pad];
  f = mgr.update();
  ok(mgr.connected, 'connected after poll sees pad');
  ok(toasts.length === 1 && toasts[0].toast === 'GAMEPAD CONNECTED', 'onConnect fired with GAMEPAD CONNECTED toast');
  ok(toasts[0].index === 0 && /Vendor/.test(toasts[0].id), 'connect payload carries index+id');
  mgr.update();
  ok(toasts.length === 1, 'no duplicate connect event while present');

  // ---- 2. sticks ----
  pad.axes[0] = 1;                              // left stick right only
  f = mgr.update();
  approx(f.moveY, 0, 1e-12, 'no phantom forward from pure strafe');
  pad.axes[3] = -1;                              // right stick up
  f = mgr.update();
  approx(f.moveX, 1, 1e-9, 'moveX full-right analog');
  pad.axes = [0, -1, 0, 0];                     // left stick up (raw Y negative)
  f = mgr.update();
  approx(f.moveY, 1, 1e-9, 'stick up gives positive moveY (Y inverted)');
  approx(f.lookY, 1, 1e-9, 'lookY positive looking up');
  pad.axes[0] = 0; pad.axes[1] = 0; pad.axes[3] = 0;
  pad.axes[2] = 0.4;
  f = mgr.update();
  ok(f.lookX > 0 && f.lookX < 0.4, 'lookX deadzoned+curved below raw');
  // sensitivity config scales look output only
  const sensMgr = new GamepadManager({ getGamepads: () => pads, config: { lookSensitivity: 2.5 } });
  sensMgr.update();
  f = sensMgr.update();
  approx(f.lookX, processStick(0.4, 0, 0.15)[0] * 2.5, 1e-9, 'lookSensitivity multiplies look axes');
  approx(f.moveX, 0, 1e-12, 'sensitivity does not touch movement');

  // ---- 3. buttons & triggers ----
  const b = (i) => pad.buttons[i];
  b(7).value = 0.9; b(7).pressed = true;         // RT
  b(6).value = 0.8; b(6).pressed = true;         // LT press edge
  b(0).pressed = true;                           // A
  f = mgr.update();
  ok(f.sprint === true, 'RT hold reads as sprint');
  ok(f.crouchToggle === true, 'LT press fires crouchToggle');
  ok(f.interactPressed === true, 'A fires interactPressed');
  f = mgr.update();
  ok(f.crouchToggle === false, 'crouchToggle is single-shot per press');
  ok(f.interactPressed === false, 'interact is rising-edge only');
  b(0).pressed = false; b(6).value = 0; b(6).pressed = false;
  f = mgr.update();
  ok(f.sprint === true, 'still sprinting while RT held');
  b(6).value = 0.8; b(6).pressed = true;         // re-press LT
  f = mgr.update();
  ok(f.crouchToggle === true, 're-pressing LT toggles again');
  b(6).value = 0; b(6).pressed = false; b(7).value = 0; b(7).pressed = false;

  b(2).pressed = true; b(3).pressed = true; b(9).pressed = true;
  f = mgr.update();
  ok(f.torchPressed && f.logPressed && f.pausePressed, 'X/Y/Start all fire on one frame');
  f = mgr.update();
  ok(!f.torchPressed && !f.logPressed && !f.pausePressed, 'X/Y/Start edges do not repeat');
  b(2).pressed = false; b(3).pressed = false; b(9).pressed = false;
  mgr.update();

  // ---- 4. vibration ----
  effects.length = 0;
  ok(await mgr.vibrate(0.6, 120) === true, 'vibrate resolves true with actuator');
  let e = pad.effects.at(-1);
  approx(e.params.weakMagnitude, 0.6, 1e-9, 'vibrate intensity -> weakMagnitude');
  e = pad.effects.at(-1);
  approx(e.params.strongMagnitude, 0.6, 1e-9, 'vibrate intensity -> strongMagnitude');
  approx(e.params.duration, 120, 1e-9, 'duration passes through');
  ok(await mgr.vibrate(0, 100) === false, 'zero-intensity vibrate is a no-op');
  ok(await mgr.vibrate(1.8, 50) === true, 'intensity clamps above 1');
  e = pad.effects.at(-1);
  approx(e.params.weakMagnitude, 1, 1e-9, 'clamped intensity applied');

  effects.length = 0;
  ok(await mgr.heartbeat(0.4) === true, 'heartbeat rumbles');
  e = pad.effects.at(-1);
  approx(e.params.weakMagnitude, 0.4, 1e-9, 'heartbeat leads on weak motor');
  approx(e.params.strongMagnitude, 0.14, 1e-9, 'heartbeat strong motor damped (x0.35)');

  effects.length = 0;
  ok(await mgr.watcherFreezePulse() === true, 'watcher freeze pulse rumbles');
  e = pad.effects.at(-1);
  approx(e.params.strongMagnitude, 1, 1e-9, 'freeze pulse hits strong motor at max');
  ok(e.type === 'dual-rumble', 'effects use standard dual-rumble');

  // vibration without connection
  pads = [null];
  mgr.update();
  ok(disconnects.length === 1 && !mgr.connected, 'disconnect detected on next poll');
  ok(await mgr.vibrate(1, 100) === false, 'vibrate no-ops when disconnected');
  f = mgr.update();
  ok(!f.sprint && !f.interactPressed, 'frame empty after disconnect');

  // reconnect resets edge memory (stale button must not replay)
  pad.buttons[0].pressed = true;                 // A held during unplug
  pads = [pad];
  mgr.update();
  ok(mgr.connected && toasts.length === 2, 'reconnect fires connect again');
  f = mgr.update();
  f = mgr.update();
  ok(!f.interactPressed, 'edge memory reset prevents stale replay after hot-plug swap');

  console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' (WITH FAILURES)' : ''));
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });


