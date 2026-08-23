/**
 * Ambient fauna: the small, harmless lives that persist in the Backrooms
 * long after the people were taken. Nothing here threatens the player —
 * these exist so a silent corridor doesn't feel like a paused simulation.
 *
 *   Roaches     2-4 per chunk at floor level; scurry straight lines, take
 *               random turns, and FREEZE when caught in the torch beam.
 *               Despawn past 25 m.
 *   Dust devils 5% of corridor chunks grow a small swirling column of grit
 *               that drifts for ~20 s and collapses.
 *   Moths       flutter around alive fluorescent fixtures on sin-driven,
 *               erratic orbit paths; vanish if their light dies.
 *   Skitters    very quiet, panned tick-bursts tied to roach movement,
 *               synthesized with WebAudio (no assets).
 *
 * Budget: at most MAX_ACTIVE live entities, all updates O(particles).
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { RNG, hash2i } from '../core/rng';
import { moveCircle, type CircleBody } from '../world/collision';
import type { Box2 } from '../world/architect';
import { CELL, CHUNK_CELLS } from '../world/constants';

// ---- tuning ----------------------------------------------------------------

/** Hard budget across every fauna kind (cheap updates assumed, still capped). */
export const MAX_ACTIVE = 12;
/** Roaches vanish beyond this distance from the player. */
export const ROACH_DESPAWN_DIST = 25;
/** Dust devils and moths are visible further than roaches before culling. */
const FAR_DESPAWN_DIST = 32;
/** Chance a corridor chunk grows a dust devil. */
export const DUST_DEVIL_CHANCE = 0.05;
/** Seconds a dust devil swirls before collapsing. */
export const DUST_DEVIL_LIFETIME = 20;
/** Chance one alive light gains a resident moth when its chunk builds. */
const MOTH_CHANCE_PER_LIGHT = 0.55;
/** Torch-beam capture cone for roaches (dot of beam dir vs roach dir). */
const BEAM_DOT = 0.88;
const BEAM_RANGE = 12;

const CHUNK_SIZE = CELL * CHUNK_CELLS;

/** Minimal fixture surface the fauna system needs (subset of LightFixture). */
export interface FixtureRef {
  x: number;
  z: number;
  alive: boolean;
}

// ---- materials ---------------------------------------------------------------


(Showing lines 44-57 of 552. Use offset=58 to continue.)

function roachMat(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('roachMat') as StandardMaterial | null;
  if (existing) return existing;
  const m = new StandardMaterial('roachMat', scene);
  m.diffuseColor = new Color3(0.16, 0.11, 0.07);
  m.specularColor = new Color3(0.25, 0.22, 0.16);
  m.emissiveColor = new Color3(0.01, 0.008, 0.006);
  return m;
}

function gritMat(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('gritMat') as StandardMaterial | null;
  if (existing) return existing;
  const m = new StandardMaterial('gritMat', scene);
  m.diffuseColor = new Color3(0.42, 0.38, 0.3);
  m.emissiveColor = new Color3(0.05, 0.048, 0.04);
  m.specularColor = new Color3(0.01, 0.01, 0.01);
  m.alpha = 0.65;
  return m;
}

function mothMat(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('mothMat') as StandardMaterial | null;
  if (existing) return existing;
  const m = new StandardMaterial('mothMat', scene);
  m.diffuseColor = new Color3(0.55, 0.52, 0.44);
  m.emissiveColor = new Color3(0.16, 0.15, 0.11);
  m.specularColor = new Color3(0.02, 0.02, 0.02);
  return m;
}

// ---- roach -----------------------------------------------------------------

export class Roach {
  readonly kind = 'roach' as const;
  root: TransformNode;
  body: CircleBody;
  /** seconds since spawn */
  life = 0;
  /** true while holding still under the beam (plus a short scared linger) */
  frozen = false;
  private abdomen: Mesh;
  private rng: RNG;
  private heading: number;
  private mode: 'run' | 'pause' = 'run';
  private modeUntil = 0;
  private scaredUntil = 0;

  constructor(scene: Scene, x: number, z: number, seed: number) {
    this.rng = new RNG(seed);
    this.body = { x, z, radius: 0.05 };
    this.heading = this.rng.range(0, Math.PI * 2);
    this.root = new TransformNode('roach_' + seed.toString(36), scene);

    const mat = roachMat(scene);
    const thorax = MeshBuilder.CreateBox('roachBody', { width: 0.1, depth: 0.055, height: 0.024 }, scene);
    thorax.parent = this.root;
    this.abdomen = MeshBuilder.CreateBox('roachAbd', { width: 0.06, depth: 0.045, height: 0.02 }, scene);
    this.abdomen.position.z = -0.065;
    this.abdomen.parent = this.root;
    for (const m of [thorax, this.abdomen]) {
      m.material = mat;
      m.isPickable = false;
    }
    this.root.position.set(x, 0.02, z);
  }

  get x(): number { return this.body.x; }
  get z(): number { return this.body.z; }

  /** True while actually scurrying (used to gate skitter audio to movement). */
  isRunning(): boolean {
    return !this.frozen && this.mode === 'run';
  }

  /**
   * One frame. litByBeam comes from the manager's torch-cone test; while lit
   * (and briefly after) the roach holds perfectly still.
   */
  update(dt: number, colliders: readonly Box2[], litByBeam: boolean): void {
    this.life += dt;
    if (litByBeam) this.scaredUntil = this.life + 0.55;
    this.frozen = this.life < this.scaredUntil;

    if (!this.frozen) {
      if (this.mode === 'run') {
        const sp = 2.1;
        const bx = this.body.x;
        const bz = this.body.z;
        moveCircle(this.body, Math.sin(this.heading) * sp * dt, Math.cos(this.heading) * sp * dt, colliders);
        // wiggling abdomen sells the scurry
        this.abdomen.rotation.y = Math.sin(this.life * 34) * 0.28;
        // blocked (wall/prop) or run burst over -> turn somewhere new
        const moved = Math.hypot(this.body.x - bx, this.body.z - bz);
        if (this.life >= this.modeUntil || moved < sp * dt * 0.3) {
          this.heading += this.rng.range(-2.3, 2.3);
          if ((moved < sp * dt * 0.3 && this.rng.chance(0.7)) || this.rng.chance(0.25)) {
            this.mode = 'pause';
            this.modeUntil = this.life + this.rng.range(0.2, 0.8);
          } else {
            this.modeUntil = this.life + this.rng.range(0.4, 1.2);
          }
        }
      } else {
        this.abdomen.rotation.y *= 1 - Math.min(1, dt * 8);
        if (this.life >= this.modeUntil) {
          this.mode = 'run';
          this.modeUntil = this.life + this.rng.range(0.4, 1.2);
        }
      }
    }
    this.root.position.set(this.body.x, 0.02, this.body.z);
    this.root.rotation.y = this.heading;
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}

// ---- dust devil ------------------------------------------------------------

interface GritParticle {
  mesh: TransformNode;
  ang: number;
  rad: number;
  h: number;
  spd: number;
}

export class DustDevil {
  readonly kind = 'devil' as const;
  root: TransformNode;
  life = 0;
  dead = false;
  private particles: GritParticle[] = [];
  private driftYaw: number;
  private rng: RNG;
  private body: CircleBody;

  constructor(scene: Scene, x: number, z: number, seed: number) {
    this.rng = new RNG(seed ^ 0xdead);
    this.body = { x, z, radius: 0.25 };
    this.driftYaw = this.rng.range(0, Math.PI * 2);
    this.root = new TransformNode('dustDevil_' + seed.toString(36), scene);
    const mat = gritMat(scene);
    for (let i = 0; i < 7; i++) {
      const s = 0.06 + this.rng.next() * 0.07;
      const mesh = MeshBuilder.CreateBox('grit', { width: s, depth: s, height: s * 0.6 }, scene);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.parent = this.root;
      this.particles.push({
        mesh,
        ang: this.rng.range(0, Math.PI * 2),
        rad: 0.14 + this.rng.next() * 0.26,
        h: 0.1 + (i / 7) * 1.1,
        spd: 2.4 + this.rng.next() * 2.4,
      });
    }
    this.root.position.set(x, 0, z);
  }

  get x(): number { return this.body.x; }
  get z(): number { return this.body.z; }

  update(dt: number, colliders: readonly Box2[]): void {
    this.life += dt;
    if (this.life >= DUST_DEVIL_LIFETIME) {
      this.dead = true;
      return;
    }
    // slow wandering drift
    this.driftYaw += Math.sin(this.life * 0.37) * dt * 0.5;
    moveCircle(this.body, Math.sin(this.driftYaw) * 0.16 * dt, Math.cos(this.driftYaw) * 0.16 * dt, colliders);
    // spin the whole column; individual particles swirl at their own rates
    this.root.rotation.y += dt * 3.1;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.mesh.position.set(
        Math.cos(p.ang + this.root.rotation.y * p.spd * 0.31) * p.rad,
        p.h + Math.sin(this.life * 2 + i * 1.7) * 0.09,
        Math.sin(p.ang + this.root.rotation.y * p.spd * 0.31) * p.rad,
      );
    }
    // grow in fast, collapse out over the final seconds
    const grow = Math.min(1, this.life / 0.6);
    const fade = Math.min(1, (DUST_DEVIL_LIFETIME - this.life) / 2.5);
    const s = 0.001 + grow * fade;
    this.root.scaling.set(s, 0.7 + 0.3 * grow, s);
    this.root.position.set(this.body.x, 0, this.body.z);
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}

// ---- moth --------------------------------------------------------------------

export class Moth {
  readonly kind = 'moth' as const;
  root: TransformNode;
  life = 0;
  dead = false;
  readonly fixtureKey: string;
  private wingL: Mesh;
  private wingR: Mesh;
  private fx: number;
  private fz: number;
  private baseR: number;
  private ang: number;
  private angSpd: number;
  private p1: number;
  private p2: number;
  private p3: number;
  private prevX: number;
  private prevZ: number;

  constructor(scene: Scene, fx: number, fz: number, seed: number) {
    this.fixtureKey = fx + ',' + fz;
    this.fx = fx;
    this.fz = fz;
    const rng = new RNG(seed ^ 0x4d07);
    this.baseR = rng.range(0.3, 0.55);
    this.ang = rng.range(0, Math.PI * 2);
    this.angSpd = rng.range(1.4, 2.8);
    this.p1 = rng.range(0, Math.PI * 2);
    this.p2 = rng.range(0, Math.PI * 2);
    this.p3 = rng.range(0, Math.PI * 2);
    this.prevX = fx;
    this.prevZ = fz;

    this.root = new TransformNode('moth_' + seed.toString(36), scene);
    const mat = mothMat(scene);
    const bodyMesh = MeshBuilder.CreateBox('mothBody', { width: 0.03, depth: 0.05, height: 0.02 }, scene);
    bodyMesh.material = mat;
    bodyMesh.isPickable = false;
    bodyMesh.parent = this.root;
    this.wingL = MeshBuilder.CreateBox('wingL', { width: 0.09, depth: 0.045, height: 0.004 }, scene);
    this.wingL.material = mat;
    this.wingL.isPickable = false;
    this.wingL.parent = this.root;
    this.wingR = MeshBuilder.CreateBox('wingR', { width: 0.09, depth: 0.045, height: 0.004 }, scene);
    this.wingR.material = mat;
    this.wingR.isPickable = false;
    this.wingR.parent = this.root;
    this.root.position.set(fx, 2.5, fz);
  }

  update(dt: number): void {
    this.life += dt;
    // erratic angular speed + breathing radius + vertical bob: pure sin paths
    this.ang += dt * this.angSpd * (0.55 + 0.85 * Math.abs(Math.sin(this.life * 0.83 + this.p1)));
    const r = this.baseR * (0.7 + 0.45 * Math.sin(this.life * 0.91 + this.p2));
    const x = this.fx + Math.cos(this.ang) * r;
    const z = this.fz + Math.sin(this.ang) * r * 0.85;
    const y = 2.45 + 0.32 * Math.sin(this.life * 1.27 + this.p3);
    const dx = x - this.prevX;
    const dz = z - this.prevZ;
    this.prevX = x;
    this.prevZ = z;
    if (dx * dx + dz * dz > 1e-10) this.root.rotation.y = Math.atan2(dx, dz);
    this.root.position.set(x, y, z);
    // frantic flap
    const flap = 0.65 + 0.35 * Math.sin(this.life * 21 + this.p1);
    this.wingL.rotation.z = flap;
    this.wingR.rotation.z = -flap;
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}

// ---- skitter voice -----------------------------------------------------------

/**
 * Tiny WebAudio synth for roach skitters: short band-passed noise ticks,
 * stereo-panned toward the roach, mixed VERY quiet. Created only when the
 * game hands us an AudioContext (see FaunaManager.attachAudio).
 */
class SkitterVoice {
  private noise: AudioBuffer;
  private out: AudioNode;

  constructor(private ctx: AudioContext, destination: AudioNode) {
    const len = Math.floor(ctx.sampleRate * 0.22);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) {
      // sparse impulses rather than hiss reads as little feet, not static
      data[i] = (Math.random() * 2 - 1) * (Math.random() < 0.12 ? 1 : 0.15) * (1 - i / len);
    }
    this.out = destination;
  }

  play(volume: number, pan: number): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    // 2-4 rapid ticks per burst
    const ticks = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < ticks; i++) {
      const t = t0 + i * (0.03 + Math.random() * 0.04);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.6;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200 + Math.random() * 1600;
      bp.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(volume * (0.6 + Math.random() * 0.4), t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      const pn = ctx.createStereoPanner();
      pn.pan.value = Math.max(-1, Math.min(1, pan));
      src.connect(bp).connect(g).connect(pn).connect(this.out);
      src.start(t);
      src.stop(t + 0.09);
    }
  }
}

// ---- manager -----------------------------------------------------------------

/** Everything the game must feed per built chunk. */
export interface ChunkFaunaInfo {
  /** true when the layout is a corridor-style chunk */
  corridor: boolean;
  /** light fixtures belonging to this chunk */
  lights: ReadonlyArray<FixtureRef>;
}

export class FaunaManager {
  roaches: Roach[] = [];
  devils: DustDevil[] = [];
  moths: Moth[] = [];

  /** Fired with (pan [-1..1], volume) whenever nearby roaches are scurrying. */
  onSkitter: ((pan: number, volume: number) => void) | null = null;

  private clock = 0;
  private nextSkitterAt = 1.5;
  private rng = new RNG(0xfa17a);
  private voice: SkitterVoice | null = null;

  constructor(private scene: Scene) {}

  /** Optional audio hook: pass the game's AudioContext (audio.ctx) + output node. */
  attachAudio(ctx: AudioContext | null, destination?: AudioNode): void {
    this.voice = ctx ? new SkitterVoice(ctx, destination ?? ctx.destination) : null;
  }

  get count(): number {
    return this.roaches.length + this.devils.length + this.moths.length;
  }

  /** Live entities grouped by kind (debug overlays / perf counters). */
  census(): { roach: number; devil: number; moth: number } {
    return { roach: this.roaches.length, devil: this.devils.length, moth: this.moths.length };
  }

  private room(): number {
    return MAX_ACTIVE - this.count;
  }

  /** Populate a freshly built chunk. Safe to call for every chunk; caps apply. */
  onChunkBuilt(cx: number, cz: number, worldSeed: number, info: ChunkFaunaInfo): void {
    const seed = hash2i(cx, cz, worldSeed ^ 0xfa);
    const rng = new RNG(seed);
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;

    // ---- roaches: 2-4 hugging the floor somewhere in the chunk --------------
    const want = rng.int(2, 5); // 2..4
    for (let i = 0; i < want && this.room() > 0; i++) {
      const rx = x0 + rng.range(1.5, CHUNK_SIZE - 1.5);
      const rz = z0 + rng.range(1.5, CHUNK_SIZE - 1.5);
      this.roaches.push(new Roach(this.scene, rx, rz, hash2i(cx * 4 + i, cz * 4 + i, seed)));
    }

    // ---- dust devil: rare corridor weather ---------------------------------
    if (info.corridor && rng.chance(DUST_DEVIL_CHANCE) && this.room() > 0) {
      const dx = x0 + CHUNK_SIZE / 2 + rng.range(-6, 6);
      const dz = z0 + CHUNK_SIZE / 2 + rng.range(-6, 6);
      this.devils.push(new DustDevil(this.scene, dx, dz, hash2i(cx, cz, seed ^ 0xdd)));
    }

    // ---- moths: residents of working lights --------------------------------
    for (let i = 0; i < info.lights.length && this.room() > 0; i++) {
      const l = info.lights[i];
      if (!l.alive) continue;
      if (rng.chance(MOTH_CHANCE_PER_LIGHT)) {
        this.moths.push(new Moth(this.scene, l.x, l.z, hash2i(Math.round(l.x * 7), Math.round(l.z * 7), seed)));
      }
    }
  }

  update(
    dt: number,
    px: number,
    pz: number,
    pyaw: number,
    colliders: readonly Box2[],
    beam?: { on: boolean },
    fixtures?: ReadonlyArray<FixtureRef>,
  ): void {
    this.clock += dt;

    // alive-light keys: moths whose fixture dies (or its chunk unloads) leave with it
    let aliveKeys: Set<string> | null = null;
    if (fixtures) {
      aliveKeys = new Set<string>();
      for (const f of fixtures) if (f.alive) aliveKeys.add(f.x + ',' + f.z);
    }

    // ---- roaches ------------------------------------------------------------
    const bfx = -Math.sin(pyaw);
    const bfz = -Math.cos(pyaw);
    let nearestMoving = Infinity;
    let nearestPan = 0;
    for (let i = this.roaches.length - 1; i >= 0; i--) {
      const r = this.roaches[i];
      const dx = r.x - px;
      const dz = r.z - pz;
      const d = Math.hypot(dx, dz);
      if (d > ROACH_DESPAWN_DIST) {
        r.dispose();
        this.roaches.splice(i, 1);
        continue;
      }
      let lit = false;
      if (beam !== undefined && beam.on && d < BEAM_RANGE && d > 0.25) {
        lit = (bfx * (dx / d) + bfz * (dz / d)) > BEAM_DOT;
      }
      r.update(dt, colliders, lit);
      // skitter source tracking: only actually-running roaches make noise
      if (r.isRunning() && d < nearestMoving) {
        nearestMoving = d;
        // right vector for yaw is (cos yaw, -sin yaw); positive pan = right ear
        nearestPan = d > 0.01 ? (Math.cos(pyaw) * dx - Math.sin(pyaw) * dz) / d : 0;
      }
    }

    // ---- dust devils ---------------------------------------------------------
    for (let i = this.devils.length - 1; i >= 0; i--) {
      const v = this.devils[i];
      const d = Math.hypot(v.x - px, v.z - pz);
      if (d > FAR_DESPAWN_DIST) v.dead = true;
      v.update(dt, colliders);
      if (v.dead) {
        v.dispose();
        this.devils.splice(i, 1);
      }
    }

    // ---- moths ---------------------------------------------------------------
    for (let i = this.moths.length - 1; i >= 0; i--) {
      const m = this.moths[i];
      const d = Math.hypot(m.root.position.x - px, m.root.position.z - pz);
      if (d > FAR_DESPAWN_DIST || (aliveKeys !== null && !aliveKeys.has(m.fixtureKey))) {
        m.dispose();
        this.moths.splice(i, 1);
        continue;
      }
      m.update(dt);
    }

    // ---- distant skitter audio: quiet, throttled, movement-gated -------------
    if (nearestMoving < 14 && this.clock >= this.nextSkitterAt) {
      // inverse-square falloff, then squashed hard: these are far-away sounds
      const REF = 5;
      const rolloff = nearestMoving <= REF ? 1 : (REF / nearestMoving) * (REF / nearestMoving);
      this.fireSkitter(nearestPan, 0.045 * rolloff);
      this.nextSkitterAt = this.clock + 0.9 + this.rng.next() * 1.8;
    }
  }

  private fireSkitter(pan: number, volume: number): void {
    this.onSkitter?.(pan, volume);
    this.voice?.play(volume, pan);
  }

  reset(): void {
    for (const r of this.roaches) r.dispose();
    for (const v of this.devils) v.dispose();
    for (const m of this.moths) m.dispose();
    this.roaches.length = 0;
    this.devils.length = 0;
    this.moths.length = 0;
    this.voice = null;
  }
}


