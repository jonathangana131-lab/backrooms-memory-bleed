/**
 * Fan dust shedding — visible fallout from long-spinning ceiling fans.
 *
 * Fans running at MEDIUM speed or faster slowly shake their own accrued
 * grime loose: dust motes pinch off the blade disc, get thrown on the
 * blade's tangential arc and then spiral down through the room with a
 * decaying residual rotation. Shedding ramps up the longer a fan has
 * been running continuously — a fan that just kicked on is clean, one
 * that has been chewing air for half a minute sheds freely.
 *
 * Budget is deliberately tiny: a single global pool of MAX_PARTICLES
 * point-sprite motes shared by every registered fan, recycled through a
 * free list. Nothing spawns or animates unless the player stands within
 * ACTIVATE_DIST meters of the fan, mirroring the other proximity-gated
 * gfx systems.
 */

import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';

/** Global hard cap on live dust motes across ALL fans. */
export const MAX_PARTICLES = 20;
/** Player proximity gate in meters: beyond this a fan neither sheds nor animates. */
export const ACTIVATE_DIST = 15;
/**
 * Minimum fan speed (revolutions/second) that sheds dust. Matches
 * CeilingFan's FAN_SPEEDS table: slow = 0.3 stays clean, medium = 0.8
 * and fast = 1.5 shed.
 */
export const SHED_SPEED_MIN = 0.5;
/** Seconds of continuous running needed to reach full shedding intensity. */
export const WARMUP_S = 30;
/** Vertical drop from the registered mount Y down to the blade disc. */
const BLADE_DROP_Y = 0.37;
/** Hub radius where blades bolt on (meters), matching ceilingfan.ts. */
const HUB_R = 0.09;
/** Blade tip radius (meters), matching ceilingfan.ts. */
const TIP_R = 0.37;
/** Gentle settle gravity for light motes (m/s^2) — they drift, not drop. */
const GRAVITY = 0.55;
/** Fraction of blade-tip linear speed imparted as launch velocity. */
const THROW = 0.35;
/** Upper bound on a mote's lifetime even if it never lands (seconds). */
const TTL_MAX = 6;
/** Parked Y for dead pool slots — far below any floor, never rendered. */
const PARK_Y = -100;

/** One registered fan and its shedding state. */
interface FanRec {
  /** World X of the ceiling mount. */
  x: number;
  /** World Z of the ceiling mount. */
  z: number;
  /** World Y of the ceiling mount. */
  y: number;
  /** Current fan speed in revolutions/second. */
  speed: number;
  /** Seconds accumulated running at shedding speed (the grime clock). */
  onTime: number;
  /** Fractional spawn budget carried between frames. */
  budget: number;
}

export class FanDust {
  private mesh: Mesh;
  private fans: FanRec[] = [];

  // ---- pooled particle state (SoA layout) --------------------------------
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pz = new Float32Array(MAX_PARTICLES);
  private pvx = new Float32Array(MAX_PARTICLES);
  private pvy = new Float32Array(MAX_PARTICLES);
  private pvz = new Float32Array(MAX_PARTICLES);
  /** Residual spin (rad/s) around the parent fan's vertical axis. */
  private pspin = new Float32Array(MAX_PARTICLES);
  /** Remaining lifetime in seconds. */
  private pttl = new Float32Array(MAX_PARTICLES);
  private alive = new Uint8Array(MAX_PARTICLES);
  /** Stack of free pool slots — the recycling core. */
  private free: number[] = [];
  /** True when the GPU position buffer needs re-upload. */
  private dirty = false;

  constructor(scene: Scene) {
    for (let i = MAX_PARTICLES - 1; i >= 0; i--) this.free.push(i);
    this.py.fill(PARK_Y);

    const mesh = new Mesh('fanDust', scene);
    const vd = new VertexData();
    const init = new Float32Array(MAX_PARTICLES * 3);
    for (let i = 0; i < MAX_PARTICLES; i++) init[i * 3 + 1] = PARK_Y;
    vd.positions = Array.from(init);
    vd.applyToMesh(mesh, true); // updatable

    const mat = new StandardMaterial('fanDustMat', scene);
    mat.emissiveColor = new Color3(0.52, 0.48, 0.38); // dull grey-brown grime
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.alpha = 0.4;
    mat.pointsCloud = true;
    mat.pointSize = 2;
    mesh.material = mat;
    this.mesh = mesh;
  }

  /** Live mote count across all fans (never exceeds MAX_PARTICLES). */
  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) if (this.alive[i]) n++;
    return n;
  }

  /** Total motes ever spawned this session (diagnostic / test observability). */
  get totalSpawned(): number {
    return this.spawnedTotal;
  }

  private spawnedTotal = 0;

  /**
   * Register a fan. Re-registering the same mount position updates the
   * existing record instead of duplicating it, so chunk regeneration is
   * idempotent. @param speed current speed in revolutions/second.
   */
  registerFan(fanX: number, fanZ: number, fanY: number, speed: number): void {
    for (const f of this.fans) {
      if (Math.abs(f.x - fanX) < 0.01 && Math.abs(f.z - fanZ) < 0.01) {
        f.y = fanY;
        f.speed = speed;
        return;
      }
    }
    this.fans.push({ x: fanX, z: fanZ, y: fanY, speed, onTime: 0, budget: 0 });
  }

  /**
   * Advance shedding + mote physics. @param px/pz are the player's world
   * X/Z. Fans beyond ACTIVATE_DIST contribute nothing at all.
   */
  update(dt: number, px: number, pz: number): void {
    if (!(dt > 0) || !isFinite(dt)) return;
    const d2max = ACTIVATE_DIST * ACTIVATE_DIST;

    let anyNear = false;
    for (const f of this.fans) {
      const dx = f.x - px;
      const dz = f.z - pz;
      if (dx * dx + dz * dz > d2max) continue;
      anyNear = true;

      if (f.speed >= SHED_SPEED_MIN) {
        // Grime clock only runs while actually shedding.
        f.onTime = Math.min(f.onTime + dt, WARMUP_S * 4);
        const warmth = Math.min(1, f.onTime / WARMUP_S);
        // Faster fans fling more loose; longer-running fans shed much more.
        f.budget += (0.8 + f.speed) * warmth * dt;
        let n = Math.floor(f.budget);
        f.budget -= n;
        while (n-- > 0) this.spawnOne(f);
      } else {
        // Slowed or stopped: settled dust, the clock winds back down.
        f.onTime = Math.max(0, f.onTime - dt * 2);
        f.budget = 0;
      }
    }

    if (!anyNear) return; // fully dormant when nowhere near a fan

    const damp = Math.exp(-dt * 1.2);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (!this.alive[i]) continue;
      // Residual rotation: carry velocity around the fan axis, decaying.
      const a = this.pspin[i] * dt;
      if (a !== 0) {
        const c = Math.cos(a);
        const s = Math.sin(a);
        const vx = this.pvx[i];
        const vz = this.pvz[i];
        this.pvx[i] = vx * c - vz * s;
        this.pvz[i] = vx * s + vz * c;
      }
      this.pspin[i] *= damp;
      this.pvy[i] -= GRAVITY * dt;
      this.px[i] += this.pvx[i] * dt;
      this.py[i] += this.pvy[i] * dt;
      this.pz[i] += this.pvz[i] * dt;
      this.pttl[i] -= dt;
      if (this.py[i] <= 0.03 || this.pttl[i] <= 0) this.recycle(i);
    }

    if (this.dirty) {
      this.dirty = false;
      const buf = new Float32Array(MAX_PARTICLES * 3);
      for (let i = 0; i < MAX_PARTICLES; i++) {
        buf[i * 3] = this.px[i];
        buf[i * 3 + 1] = this.alive[i] ? this.py[i] : PARK_Y;
        buf[i * 3 + 2] = this.pz[i];
      }
      this.mesh.setVerticesData('position', buf);
    }
  }

  /** Unregister every fan, kill every mote, restore the pristine pool. */
  clear(): void {
    this.fans.length = 0;
    this.free.length = 0;
    for (let i = MAX_PARTICLES - 1; i >= 0; i--) {
      this.alive[i] = 0;
      this.py[i] = PARK_Y;
      this.pttl[i] = 0;
      this.free.push(i);
    }
    this.dirty = true;
    this.spawnedTotal = 0;
  }

  /** Release one mote back into the pool. */
  private recycle(i: number): void {
    this.alive[i] = 0;
    this.py[i] = PARK_Y;
    this.free.push(i);
    this.dirty = true;
  }

  /** Pinch a mote off a random point on the blade disc. */
  private spawnOne(f: FanRec): void {
    const slot = this.free.pop();
    if (slot === undefined) return; // pool exhausted: silently skip
    const ang = Math.random() * Math.PI * 2;
    const r = HUB_R + Math.random() * (TIP_R - HUB_R);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const i = slot;
    this.px[i] = f.x + ca * r;
    this.py[i] = f.y - BLADE_DROP_Y;
    this.pz[i] = f.z + sa * r;
    // Tangential launch: positive speed spins CCW seen from below.
    const w = f.speed * Math.PI * 2;
    const v = Math.min(w * r, 2.5) * THROW;
    this.pvx[i] = -sa * v + (Math.random() - 0.5) * 0.06;
    this.pvz[i] = ca * v + (Math.random() - 0.5) * 0.06;
    this.pvy[i] = -(0.04 + Math.random() * 0.08);
    this.pspin[i] = w * (0.25 + Math.random() * 0.3);
    this.pttl[i] = TTL_MAX * (0.7 + Math.random() * 0.3);
    this.alive[i] = 1;
    this.spawnedTotal++;
    this.dirty = true;
  }
}


