/**
 * Gamepad input adapter (standard mapping) for the first-person controller.
 *
 * Wraps the browser Gamepad API behind a poll-based manager: update() diffs
 * connect/disconnect state, reads both sticks through a shared radial-deadzone
 * + cubic response curve, and converts buttons/triggers into the discrete
 * frame surface the controller consumes (move/look axes, sprint hold, crouch
 * toggle, rising-edge actions). Rumble effects (vibrate / heartbeat /
 * watcher freeze pulse) go through the standard dual-rumble actuator when the
 * pad exposes one.
 *
 * No engine dependencies: the pad source is injectable, so the module is
 * unit-testable in Node against a synthetic Gamepad API. All mapping is
 * deterministic - no RNG.
 */

/** Default radial deadzone applied to both sticks. */
export const DEFAULT_DEADZONE = 0.15;

/** Rumble duration for heartbeat(intensity), milliseconds. */
const HEARTBEAT_MS = 160;

/** Rumble duration for watcherFreezePulse(), milliseconds. */
const FREEZE_PULSE_MS = 250;

/** Fraction of `intensity` the heartbeat strong motor receives. */
const HEARTBEAT_STRONG_SCALE = 0.35;

/** Standard-mapping button indices used here. */
const BTN_INTERACT = 0; // A
const BTN_TORCH = 2; // X
const BTN_LOG = 3; // Y
const BTN_CROUCH = 6; // LT
const BTN_SPRINT = 7; // RT
const BTN_PAUSE = 9; // Start

/** Structural slice of a Gamepad this module relies on. */
export interface PadLike {
  index: number;
  id: string;
  connected: boolean;
  /** Standard mapping: [moveX, moveY, lookX, lookY, ...]. */
  readonly axes: readonly number[];
  readonly buttons: readonly { pressed: boolean; value: number }[];
  vibrationActuator?: {
    playEffect(type: string, params: Record<string, number>): Promise<unknown>;
  } | null;
}

/** One polled input frame consumed by the player controller. */
export interface GamepadFrame {
  moveX: number;
  moveY: number;
  lookX: number;
  lookY: number;
  sprint: boolean;
  crouchToggle: boolean;
  interactPressed: boolean;
  torchPressed: boolean;
  logPressed: boolean;
  pausePressed: boolean;
}

/** Manager construction options. */
export interface GamepadManagerOptions {
  /** Pad source; defaults to navigator.getGamepads(). Injectable for tests. */
  getGamepads?: () => readonly (PadLike | null)[];
  /** Tunables: per-stick deadzone and look-axis multiplier (movement exempt). */
  config?: { deadzone?: number; lookSensitivity?: number };
}

/** Connect payload handed to onConnect (drives the toast + HUD hint). */
export interface GamepadConnectEvent {
  toast: 'GAMEPAD CONNECTED';
  index: number;
  id: string;
}

/**
 * Radial deadzone + cubic response curve for one stick.
 *
 * @param x Raw horizontal axis value.
 * @param y Raw vertical axis value.
 * @param deadzone Radial deadzone radius; deflection at or below it reads 0.
 * @returns Filtered pair with magnitude ((mag - deadzone) / (1 - deadzone))^3
 *   along the raw direction - full throw stays at 1.0, centre stays soft.
 */
export function processStick(x: number, y: number, deadzone: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (!(mag > deadzone)) return [0, 0];
  const t = Math.min((mag - deadzone) / (1 - deadzone), 1);
  const eased = t * t * t;
  return [(x / mag) * eased, (y / mag) * eased];
}

function emptyFrame(): GamepadFrame {
  return {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    sprint: false, crouchToggle: false,
    interactPressed: false, torchPressed: false, logPressed: false, pausePressed: false,
  };
}

/**
 * Poll-based gamepad adapter. Call update() once per frame and consume the
 * returned frame; call vibrate()/heartbeat()/watcherFreezePulse() from game
 * events. Connect/disconnect transitions fire at most once per transition and
 * reset button edge memory, so a button held across an unplug cannot replay
 * its edge after hot-plug swap.
 */
export class GamepadManager {
  /** Whether a pad was present at the last update(). */
  connected = false;

  /** Called once when a pad appears; wire to the "GAMEPAD CONNECTED" toast. */
  onConnect: ((event: GamepadConnectEvent) => void) | null = null;

  /** Called once when the tracked pad disappears. */
  onDisconnect: ((index: number) => void) | null = null;

  private readonly getPads: () => readonly (PadLike | null)[];
  private readonly deadzone: number;
  private readonly lookSensitivity: number;
  private pad: PadLike | null = null;
  private lastPadIndex = 0;
  /** Rising-edge memory: standard-mapping button index -> pressed last frame. */
  private readonly prevButtons = new Map<number, boolean>();

  constructor(options: GamepadManagerOptions = {}) {
    this.getPads =
      options.getGamepads ??
      (() => (navigator.getGamepads?.() ?? []) as unknown as readonly (PadLike | null)[]);
    this.deadzone = options.config?.deadzone ?? DEFAULT_DEADZONE;
    this.lookSensitivity = options.config?.lookSensitivity ?? 1;
  }

  /**
   * Poll the pad source, diff connection state and produce one input frame.
   * Returns an all-zero frame while disconnected.
   */
  update(): GamepadFrame {
    const pads = this.getPads();
    const pad = pads.find((p) => p !== null && p.connected !== false) ?? null;

    if (!pad) {
      if (this.connected) {
        this.connected = false;
        this.pad = null;
        this.prevButtons.clear(); // stale edges must not survive a unplug
        this.onDisconnect?.(this.lastPadIndex);
      }
      return emptyFrame();
    }

    if (!this.connected) {
      this.connected = true;
      this.prevButtons.clear();
      this.pad = pad;
      this.lastPadIndex = pad.index;
      this.onConnect?.({ toast: 'GAMEPAD CONNECTED', index: pad.index, id: pad.id });
    }
    this.pad = pad;

    const [moveX, moveYRaw] = processStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, this.deadzone);
    const [lookX, lookYRaw] = processStick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.deadzone);
    return {
      moveX,
      moveY: -moveYRaw, // stick up (raw Y negative) means forward
      lookX: lookX * this.lookSensitivity,
      lookY: -lookYRaw * this.lookSensitivity, // stick up looks up
      sprint: this.held(BTN_SPRINT),
      crouchToggle: this.risingEdge(BTN_CROUCH),
      interactPressed: this.risingEdge(BTN_INTERACT),
      torchPressed: this.risingEdge(BTN_TORCH),
      logPressed: this.risingEdge(BTN_LOG),
      pausePressed: this.risingEdge(BTN_PAUSE),
    };
  }

  /**
   * Generic rumble pulse through the dual-rumble actuator.
   *
   * @param intensity Motor strength, clamped into (0, 1].
   * @param durationMs Effect duration in milliseconds.
   * @returns true when the effect played; false without a connected pad's
   *   actuator or at zero/non-positive intensity (no-op).
   */
  async vibrate(intensity: number, durationMs: number): Promise<boolean> {
    const actuator = this.actuator();
    if (!actuator || !(intensity > 0)) return false;
    const strength = Math.min(intensity, 1);
    await actuator.playEffect('dual-rumble', {
      duration: durationMs,
      weakMagnitude: strength,
      strongMagnitude: strength,
    });
    return true;
  }

  /**
   * Soft heartbeat rumble led by the weak motor (strong motor damped by
   * HEARTBEAT_STRONG_SCALE). Same no-op contract as vibrate().
   */
  async heartbeat(intensity: number): Promise<boolean> {
    return this.playRumble({
      duration: HEARTBEAT_MS,
      weakMagnitude: intensity,
      strongMagnitude: intensity * HEARTBEAT_STRONG_SCALE,
    }, Math.max(intensity, 0));
  }

  /**
   * Watcher-freeze sting: strong motor at maximum. Same no-op contract as
   * vibrate().
   */
  async watcherFreezePulse(): Promise<boolean> {
    return this.playRumble(
      { duration: FREEZE_PULSE_MS, weakMagnitude: 1, strongMagnitude: 1 },
      1,
    );
  }

  private actuator(): NonNullable<PadLike['vibrationActuator']> | null {
    return this.connected ? (this.pad?.vibrationActuator ?? null) : null;
  }

  /** Fire one dual-rumble effect after gating/clamping on `gate` strength. */
  private async playRumble(
    params: Record<string, number>,
    gate: number,
  ): Promise<boolean> {
    const actuator = this.actuator();
    if (!actuator || !(gate > 0)) return false;
    await actuator.playEffect('dual-rumble', params);
    return true;
  }

  private pressed(index: number): boolean {
    return this.pad?.buttons[index]?.pressed === true;
  }

  /** True while the trigger/button is held (RT sprint). */
  private held(index: number): boolean {
    return this.pressed(index);
  }

  /** Single-shot rising edge for `index`; updates edge memory. */
  private risingEdge(index: number): boolean {
    const now = this.pressed(index);
    const was = this.prevButtons.get(index) === true;
    this.prevButtons.set(index, now);
    return now && !was;
  }
}
