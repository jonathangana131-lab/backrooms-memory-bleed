/**
 * First-person player controller: mouse look, walk/sprint/crouch,
 * capsule-vs-AABB collision, head bob, footstep events.
 */
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { TargetCamera } from '@babylonjs/core/Cameras/targetCamera';
import type { Scene } from '@babylonjs/core/scene';
import { Input } from '../core/input';
import { moveCircle, type CircleBody } from '../world/collision';
import type { Box2 } from '../world/architect';
import { Emitter } from '../core/events';
import { Stamina } from './stamina';
import { LeanPeek, LeanPeekMode, LEAN_HEAD_RADIUS, LEAN_MARGIN } from './leanpeek';

export const PLAYER_RADIUS = 0.34;
export const EYE_STAND = 1.62;
export const EYE_CROUCH = 0.98;

// ---- movement-feel tuning ----
/** Head-bob vertical amplitude in metres while walking. */
export const BOB_AMPLITUDE = 0.02;
/** Bob phase gain: phase advances at hspeed * BOB_FREQUENCY rad/s. */
export const BOB_FREQUENCY = 3.4;
/** Landing impact: camera dips this far (metres, negative) on a hard landing. */
export const LAND_DIP_DEPTH = -0.05;
/** Landing impact: time (s) to reach full dip. */
export const LAND_DIP_DOWN_TIME = 0.15;
/** Landing impact: time (s) to recover from full dip. */
export const LAND_DIP_RECOVER_TIME = 0.3;
/** Downward speed (m/s) at touchdown that counts as a hard landing. */
export const LAND_TRIGGER_VY = -2.5;
/** Crouch stand<->crouch eye-height transition time (s). */
export const CROUCH_LERP_TIME = 0.3;
/** Sprint FOV ease duration (s), applied with smoothstep easing. */
export const FOV_EASE_TIME = 0.22;
/** Momentum: time-constant (s) for speeding up toward intended pace. */
export const MOMENTUM_ACCEL_TAU = 0.09;
/** Momentum: time-constant (s) for bleeding off speed when intent stops. */
export const MOMENTUM_DECEL_TAU = 0.18;

function smoothstep01(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return t * t * (3 - 2 * t);
}

export interface PlayerEvents extends Record<string, unknown> {
  footstep: { running: boolean };
  /** F14: touchdown harder than LAND_TRIGGER_VY; vy is the impact speed. */
  hardfall: { vy: number };
}

export class PlayerController {
  events = new Emitter<PlayerEvents>();
  /**
   * Direct audio-sync hook: fired at every bob-cycle peak while walking,
   * alongside the 'footstep' event. Assign a callback (or null).
   */
  onFootstep: ((running: boolean) => void) | null = null;
  body: CircleBody & { y: number } = { x: 0, z: 6, y: 0, radius: PLAYER_RADIUS };
  yaw = Math.PI;         // facing -Z initially? adjust per spawn
  pitch = 0;
  crouching = false;
  sprinting = false;
  speed = 0;
  /** F9: fatigue model — drain/regen plus the three monotone outputs. */
  readonly staminaEngine = new Stamina();
  /** Fatigue level in [0,1] (1 fresh → 0 winded), read by HUD + audio mounts. */
  get stamina(): number {
    return this.staminaEngine.level;
  }
  /** F14: external control-damp multiplier applied to movement this frame. */
  inputScale = 1;
  /** F10: external micro-timing scale on stride onset advance (1 = neutral). */
  strideRateScale = 1;
  /**
   * Base vertical FOV in radians for the per-frame camera write. Settings
   * owners write this field (game.ts applySettings maps the user's FOV
   * degrees here); sprint kick and stamina pulse are relative multipliers on
   * top of it, so assigning it never disturbs that math.
   */
  baseFovRad = 1.25;
  /** F10: Q/E lean envelope with collision-safe lateral offset. */
  private readonly lean = new LeanPeek(LeanPeekMode.Hold);
  /** F9: FOV pulse oscillator phase (radians). */
  private pulsePhase = 0;
  eye = EYE_STAND;
  private bobPhase = 0;
  private idleTime = 0;
  private vy = 0;
  /** Time since last hard landing; +Infinity until one happens. */
  private landDipAge = Number.POSITIVE_INFINITY;
  /** 0 = standing, 1 = fully crouched; lerped over CROUCH_LERP_TIME. */
  private crouchBlend = 0;
  /** Raw (pre-ease) sprint FOV blend amount, eased with smoothstep for the camera. */
  private fovBlend = 0;
  /** Last vertical-bob peak index that fired a footstep. */
  private lastBobPeak = -1;
  sensitivity = 0.0022;
  enabled = false;

  constructor(private camera: TargetCamera, private input: Input, private scene: Scene) {}

  teleport(x: number, z: number, yaw: number): void {
    this.body.x = x; this.body.z = z; this.body.y = 0; this.vy = 0;
    this.yaw = yaw; this.pitch = 0;
  }

  update(dt: number, colliders: readonly Box2[]): void {
    // ---- look ----
    const m = this.input.consumeMouse();
    this.yaw += m.dx * this.sensitivity;
    this.pitch += m.dy * this.sensitivity;
    const lim = Math.PI / 2 - 0.02;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;

    // ---- waking intro: real-time clock so clamped dt can't stretch it ----
    if (this.wakeT > 0) {
      this.wakeT = Math.max(0, 1.8 - (performance.now() / 1000 - this.wakeStartReal));
      const k = Math.max(0, Math.min(1, 1 - this.wakeT / 1.8));
      const ease = k * k * (3 - 2 * k);
      this.eye = 0.38 + (EYE_STAND - 0.38) * ease;
      this.pitch = 0.55 * (1 - ease);
      this.camera.position.set(this.body.x, this.eye + this.body.y, this.body.z);
      this.camera.rotation.set(this.pitch, this.yaw, Math.sin(this.wakeT * 2.1) * 0.04);
      if (this.wakeT <= 0) {
        this.enabled = true;
        this.eye = EYE_STAND;
        this.pitch = 0;
      }
      return;
    }

    if (!this.enabled) return;

    // ---- stance ----
    // hold to crouch
    this.crouching = this.input.down('KeyC') || this.input.down('ControlLeft');

    // ---- movement intent ----
    let fx = 0, fz = 0;
    if (this.input.down('KeyW') || this.input.down('ArrowUp')) fz += 1;
    if (this.input.down('KeyS') || this.input.down('ArrowDown')) fz -= 1;
    if (this.input.down('KeyA') || this.input.down('ArrowLeft')) fx -= 1;
    if (this.input.down('KeyD') || this.input.down('ArrowRight')) fx += 1;
    const moving = fx !== 0 || fz !== 0;

    const canSprint = this.input.down('ShiftLeft') || this.input.down('ShiftRight');
    this.sprinting = canSprint && !this.crouching && fz > 0 && this.stamina > 0.05 && moving;

    // stamina: F9 engine owns drain/regen + breath/stride/fov outputs
    this.staminaEngine.update(dt, { sprinting: this.sprinting });

    const targetSpeed = this.crouching ? 1.15 : this.sprinting ? 4.4 : 2.35;
    // momentum: real bodies have mass - speed eases toward intent instead of
    // snapping, so starts have push and stops bleed off over a few steps
    const tau = moving ? MOMENTUM_ACCEL_TAU : MOMENTUM_DECEL_TAU;
    this.speed += ((moving ? targetSpeed : 0) - this.speed) * (1 - Math.exp(-dt / tau));
    if (!moving && this.speed < 0.02) this.speed = 0;

    if (moving) {
      const len = Math.hypot(fx, fz);
      fx /= len; fz /= len;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      // Babylon yaw: forward = (-sin, 0, -cos), right = (cos, 0, -sin)
      const wx = -sin * fz + cos * fx;
      const wz = -cos * fz - sin * fx;
      // F14: fall stagger damps movement intent while the stagger runs
      const damp = this.inputScale;
      const dx = wx * this.speed * dt * damp;
      const dz = wz * this.speed * dt * damp;
      moveCircle(this.body, dx, dz, colliders);
    }

    // ---- gravity (floor flat for now, kept for future pits) ----
    const prevVy = this.vy;
    this.vy -= 18 * dt;
    this.body.y += this.vy * dt;
    let hardLanding = false;
    if (this.body.y <= 0) {
      this.body.y = 0;
      // fall detection: only a real fall triggers the dip (per-frame ground
      // clamp always sees prevVy == 0 here, so idle standing never trips it)
      if (prevVy < LAND_TRIGGER_VY) {
        hardLanding = true;
        // F14: publish the impact so mounts can drive stagger/blur envelopes
        this.events.emit('hardfall', { vy: prevVy });
      }
      this.vy = 0;
    }
    this.landDipAge += dt;
    if (hardLanding) this.landDipAge = 0;
    // landing impact: plunge to LAND_DIP_DEPTH over LAND_DIP_DOWN_TIME, then recover
    let landY = 0;
    if (this.landDipAge < LAND_DIP_DOWN_TIME) {
      landY = LAND_DIP_DEPTH * (this.landDipAge / LAND_DIP_DOWN_TIME);
    } else if (this.landDipAge < LAND_DIP_DOWN_TIME + LAND_DIP_RECOVER_TIME) {
      const k = (this.landDipAge - LAND_DIP_DOWN_TIME) / LAND_DIP_RECOVER_TIME;
      landY = LAND_DIP_DEPTH * (1 - smoothstep01(k));
    }

    // ---- crouch smoothing: lerp stance blend over CROUCH_LERP_TIME ----
    const crouchTarget = this.crouching ? 1 : 0;
    const crouchStep = dt / CROUCH_LERP_TIME;
    if (crouchTarget > this.crouchBlend) {
      this.crouchBlend = Math.min(crouchTarget, this.crouchBlend + crouchStep);
    } else if (crouchTarget < this.crouchBlend) {
      this.crouchBlend = Math.max(crouchTarget, this.crouchBlend - crouchStep);
    }
    this.eye = EYE_STAND + (EYE_CROUCH - EYE_STAND) * smoothstep01(this.crouchBlend);

    // ---- head bob: sine wave while walking, amplitude/frequency tied to
    // the EASED speed so bob swells through the first steps and fades out
    // as momentum bleeds off. F8: strideRateScale pulls onsets toward the
    // heartbeat under tension (set externally each frame). ----
    const hspeed = this.speed;
    this.bobPhase += dt * hspeed * BOB_FREQUENCY * this.strideRateScale;
    const bobAmp = Math.min(1, hspeed / 4) * BOB_AMPLITUDE * (this.crouching ? 0.7 : 1);
    const bobY = moving ? Math.sin(this.bobPhase * 2) * bobAmp : 0;
    const bobX = moving ? Math.cos(this.bobPhase) * bobAmp * 0.7 : 0;

    // footstep hook: fired at each vertical-bob cycle peak (bobPhase*2 == PI/2 + n*2PI)
    const peakIdx = Math.floor((this.bobPhase * 2 - Math.PI / 2) / (2 * Math.PI));
    if (moving && peakIdx > this.lastBobPeak) {
      this.lastBobPeak = peakIdx;
      this.events.emit('footstep', { running: this.sprinting });
      if (this.onFootstep) this.onFootstep(this.sprinting);
    } else if (!moving) {
      // re-arm while idle so a stale peak can't fire on the first step after stopping
      this.lastBobPeak = peakIdx;
    }

    // F10: Q/E lean envelope — hold Q leans left, hold E leans right.
    // E doubles as the interact key; a brief roll while interacting is
    // harmless and the collision clamp keeps the head out of walls.
    const leanState = this.lean.update(dt, {
      leanLeft: this.input.down('KeyQ'),
      leanRight: this.input.down('KeyE'),
      yaw: this.yaw,
      bodyX: this.body.x,
      bodyZ: this.body.z,
    }, { headBlocked: (x, z) => this.headBlockedAt(x, z, colliders) });

    // waking intro overrides stance until risen
    if (this.wakeT > 0) {
      this.wakeT -= dt;
      const k = Math.max(0, Math.min(1, 1 - this.wakeT / 1.8));
      const ease = k * k * (3 - 2 * k);
      this.eye = 0.38 + (EYE_STAND - 0.38) * ease;
      this.pitch = 0.55 * (1 - ease);
      if (this.wakeT <= 0) { this.enabled = true; this.eye = EYE_STAND; this.pitch = 0; }
      const cx2 = this.body.x;
      const cz2 = this.body.z;
      this.camera.position.set(cx2, this.eye + this.body.y, cz2);
      this.camera.rotation.set(this.pitch, this.yaw, Math.sin(this.wakeT * 2.1) * 0.04);
      return;
    }

    // ---- apply to camera ----
    // F10: lateral eye offset rides the yaw frame alongside bob sway
    const cx = this.body.x + bobX * Math.cos(this.yaw) + leanState.offsetX;
    const cz = this.body.z - bobX * Math.sin(this.yaw) + leanState.offsetZ;
    // idle sway: barely-there breathing so stillness never looks frozen
    let swayY = 0, swayP = 0;
    if (!moving) {
      this.idleTime += dt;
      swayY = Math.sin(this.idleTime * 0.55) * 0.0016 + Math.sin(this.idleTime * 1.31) * 0.0007;
      swayP = Math.cos(this.idleTime * 0.42) * 0.0022;
    } else {
      this.idleTime = 0;
    }
    // sprint speed-feel: fov kick eased with smoothstep over FOV_EASE_TIME,
    // plus F9 exertion pulse whose amplitude rises as stamina drains.
    // Base FOV comes from this.baseFovRad — settings owners assign it, so the
    // user's FOV choice survives this every-frame write.
    const MAX_FOV_KICK = 0.06;
    const FOV_PULSE_MAX = 0.022;
    this.pulsePhase += dt * 5.4;
    // same input ramp as before: kick grows from 2.5 m/s, capped by MAX_FOV_KICK
    const desiredBlend = Math.max(0, Math.min(1, (hspeed - 2.5) / 3));
    const fovStep = dt / FOV_EASE_TIME;
    if (desiredBlend > this.fovBlend) this.fovBlend = Math.min(desiredBlend, this.fovBlend + fovStep);
    else if (desiredBlend < this.fovBlend) this.fovBlend = Math.max(desiredBlend, this.fovBlend - fovStep);
    const camAny = this.camera as unknown as { fov: number };
    camAny.fov = this.baseFovRad
      * (1 + MAX_FOV_KICK * smoothstep01(this.fovBlend)
        + FOV_PULSE_MAX * this.staminaEngine.fovPulseAmp * Math.sin(this.pulsePhase));

    this.camera.position.set(cx, this.eye + this.body.y + bobY + landY, cz);
    // F10: lean roll rides the camera z-axis; idle sway keeps pitch/yaw alive
    this.camera.rotation.set(this.pitch + swayP, this.yaw + swayY, leanState.roll);
  }

  /**
   * F10 collision probe: would a head circle (LEAN_HEAD_RADIUS, inflated by
   * LEAN_MARGIN) centred at (x, z) overlap any solid collider?
   * @param x candidate head-centre world x
   * @param z candidate head-centre world z
   * @param colliders solid boxes around the player this frame
   * @returns true when the position is too tight to lean into
   */
  private headBlockedAt(x: number, z: number, colliders: readonly Box2[]): boolean {
    const r = LEAN_HEAD_RADIUS + LEAN_MARGIN;
    for (const b of colliders) {
      const nx = Math.max(b.minX, Math.min(x, b.maxX));
      const nz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - nx;
      const dz = z - nz;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  }
  /** waking intro: >0 while rising from the carpet */
  wakeT = 0;
  private wakeStartReal = 0;

  beginWake(): void {
    this.wakeT = 1.8;
    this.wakeStartReal = performance.now() / 1000;
    this.enabled = false;
    this.eye = 0.38;
    this.pitch = 0.55;
    this.yaw += Math.PI * 0.15;
  }
}


