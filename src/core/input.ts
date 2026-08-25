/** Keyboard + mouse input with pointer lock management. */
import {
  GamepadManager,
  type GamepadFrame,
} from '../player/gamepad';

/**
 * Gamepad look rate at full throw, rad/s. Applied by the controller as a
 * rate-based turn (scaled by dt) so pad look is framerate-independent —
 * unlike mouse deltas, which are already per-frame pixel displacements.
 */
export const GAMEPAD_TURN_RATE = 2.4;

/**
 * Digital gate on the (deadzoned + curved) stick output for synthesizing
 * held movement keys. The controller's walk speed is binary, so a gentle
 * push below this gate reads as "not moving" rather than full-speed creep.
 */
export const PAD_MOVE_GATE = 0.1;

export class Input {
  keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  /**
   * Optional gamepad adapter. When attached (attachGamepad), updateGamepad()
   * polls it once per frame and merges its state into down()/padLook, so
   * keyboard and pad drive the same consumer surface.
   */
  gamepad: GamepadManager | null = null;
  /** Last polled pad frame (null until a poll ran or when never attached). */
  lastGamepadFrame: GamepadFrame | null = null;
  /** Analog look axes from the pad, already deadzoned/curved/scaled. */
  readonly padLook: { x: number; y: number } = { x: 0, y: 0 };
  /** Keys currently synthesized from the pad (stick gates + sprint/latch). */
  private readonly padDown = new Set<string>();
  /** LT toggle latch: the controller is hold-to-crouch, the pad toggles. */
  private padCrouchLatch = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  requestLock(): void {
    if (!this.locked) {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => { /* headless / denied */ });
    }
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /**
   * Attach a gamepad adapter. The manager's connect/disconnect hooks stay
   * owned by the caller (game.ts wires toasts); this only clears transient
   * pad state so a stale frame can never outlive its manager.
   */
  attachGamepad(manager: GamepadManager): void {
    this.gamepad = manager;
    this.clearPadState();
  }

  /**
   * Poll the attached pad once per frame: refresh padLook, rebuild the
   * synthesized key set and step the crouch latch. Safe to call with no
   * adapter attached (no-op) — the poll itself never throws past here.
   */
  updateGamepad(): GamepadFrame | null {
    if (!this.gamepad) return null;
    const f = this.gamepad.update();
    this.lastGamepadFrame = f;
    if (!this.gamepad.connected) {
      this.clearPadState();
      return f;
    }
    if (f.crouchToggle) this.padCrouchLatch = !this.padCrouchLatch;
    this.padDown.clear();
    // stick -> held movement keys (binary gate; speed is binary downstream)
    if (f.moveY >= PAD_MOVE_GATE) this.padDown.add('KeyW');
    if (f.moveY <= -PAD_MOVE_GATE) this.padDown.add('KeyS');
    if (f.moveX >= PAD_MOVE_GATE) this.padDown.add('KeyD');
    if (f.moveX <= -PAD_MOVE_GATE) this.padDown.add('KeyA');
    if (f.sprint) this.padDown.add('ShiftLeft');
    if (this.padCrouchLatch) this.padDown.add('KeyC');
    this.padLook.x = f.lookX;
    this.padLook.y = f.lookY;
    return f;
  }

  /** Crouch latch + synthesized keys, e.g. on run start or pad loss. */
  resetGamepadTransient(): void {
    this.clearPadState();
  }

  private clearPadState(): void {
    this.padDown.clear();
    this.padCrouchLatch = false;
    this.padLook.x = 0;
    this.padLook.y = 0;
  }

  down(code: string): boolean {
    return this.keys.has(code) || this.padDown.has(code);
  }

  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return r;
  }
}


