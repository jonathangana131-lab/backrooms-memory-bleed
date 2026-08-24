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
  stamina = 1;
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

    // stamina
    if (this.sprinting) this.stamina = Math.max(0, this.stamina - dt * 0.11);
    else this.stamina = Math.min(1, this.stamina + dt * 0.075);

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
      const dx = wx * this.speed * dt;
      const dz = wz * this.speed * dt;
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
    // as momentum bleeds off ----
    const hspeed = this.speed;
    this.bobPhase += dt * hspeed * BOB_FREQUENCY;
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
    const cx = this.body.x + bobX * Math.cos(this.yaw);
    const cz = this.body.z - bobX * Math.sin(this.yaw);
    // idle sway: barely-there breathing so stillness never looks frozen
    let swayY = 0, swayP = 0;
    if (!moving) {
      this.idleTime += dt;
      swayY = Math.sin(this.idleTime * 0.55) * 0.0016 + Math.sin(this.idleTime * 1.31) * 0.0007;
      swayP = Math.cos(this.idleTime * 0.42) * 0.0022;
    } else {
      this.idleTime = 0;
    }
    // sprint speed-feel: fov kick eased with smoothstep over FOV_EASE_TIME
    const BASE_FOV = 1.25;
    const MAX_FOV_KICK = 0.06;
    // same input ramp as before: kick grows from 2.5 m/s, capped by MAX_FOV_KICK
    const desiredBlend = Math.max(0, Math.min(1, (hspeed - 2.5) / 3));
    const fovStep = dt / FOV_EASE_TIME;
    if (desiredBlend > this.fovBlend) this.fovBlend = Math.min(desiredBlend, this.fovBlend + fovStep);
    else if (desiredBlend < this.fovBlend) this.fovBlend = Math.max(desiredBlend, this.fovBlend - fovStep);
    const camAny = this.camera as unknown as { fov: number };
    if (camAny.fov === undefined) camAny.fov = BASE_FOV;
    camAny.fov = BASE_FOV * (1 + MAX_FOV_KICK * smoothstep01(this.fovBlend));

    this.camera.position.set(cx, this.eye + this.body.y + bobY + landY, cz);
    this.camera.rotation.set(this.pitch + swayP, this.yaw + swayY, 0);
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


