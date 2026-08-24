/**
 * Reconstructed humans.
 *
 * The Backrooms rebuilds people from stolen information. Some watch,
 * some wander, some believe they still work here. None have faces.
 */
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { RNG } from '../core/rng';
import { moveCircle, type CircleBody } from '../world/collision';
import type { Box2 } from '../world/architect';

export type HumanType = 'watcher' | 'wanderer' | 'helper' | 'incomplete' | 'believer' | 'double';

/** Stream salt for the per-figure walk-phase init draw (determinism law). */
const WALK_PHASE_STREAM_SALT = 0x3a17a >>> 0;

function believerMat(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('believerMat') as StandardMaterial | null;
  if (existing) return existing;
  const m = new StandardMaterial('believerMat', scene);
  m.diffuseColor = new Color3(0.72, 0.66, 0.48);
  m.emissiveColor = new Color3(0.06, 0.055, 0.04);
  m.specularColor = new Color3(0.02, 0.02, 0.02);
  m.maxSimultaneousLights = 8;
  return m;
}

function humanMat(scene: Scene): StandardMaterial {
  const existing = scene.getMaterialByName('humanMat') as StandardMaterial | null;
  if (existing) return existing;
  const m = new StandardMaterial('humanMat', scene);
  m.diffuseColor = new Color3(0.62, 0.58, 0.52);
  m.emissiveColor = new Color3(0.055, 0.05, 0.045);
  m.specularColor = new Color3(0.02, 0.02, 0.02);
  m.maxSimultaneousLights = 8;
  return m;
}

export class HumanFigure {
  root: TransformNode;
  body: CircleBody & { y: number };
  private head: TransformNode;
  private walkPhase = 0;
  life = 0;
  private pauseUntil = 0;
  vanishAt = Infinity;
  said = false;
  saidCount = 0;
  lastSpokeAt = 0;
  private beamFreezeUntil = 0;
  private beamAvoidUntil = 0;
  /** fired once when the beam first freezes this figure */
  onBeamFrozen: (() => void) | null = null;
  isBeamFrozen(): boolean {
    return this.life < this.beamFreezeUntil && this.beamFreezeUntil > 0;
  }
  /** per-figure rng seeded by spawn */
  private rng: RNG;

  // --- idle-scan (watcher): slow left-right head sweep when not tracking ---
  private scanUntil = 0;
  private nextScanAt = 0;
  private scanPhase = 0;

  // --- curiosity (wanderer): stop near interesting props and face them ---
  /** interesting prop positions (batteries, signs); fed in by the manager */
  pointsOfInterest: ReadonlyArray<{ x: number; z: number }> = [];
  private visitedPoi = new Set<number>();
  private curiousUntil = 0;
  private curiousTarget: { x: number; z: number } | null = null;

  // --- work animation (believer): periodic crouch-and-pick-up ---
  private nextWorkAt = 0;
  private workStartedAt = -1;
  private workDip = 0;

  // --- twitch (incomplete): sudden head jerk decaying over ~200ms ---
  private nextTwitchAt = 0;
  private twitchStart = -1;
  private twitchAmp = 0;
  private twitchBaseY = 0;

  // --- mirroring (double): needs the player's previous position ---
  private prevPx = NaN;
  private prevPz = NaN;

  constructor(public type: HumanType, scene: Scene, x: number, z: number, seed: number) {
    this.rng = new RNG(seed);
    // walk phase gets its own persistent stream so the behavior stream's
    // draw sequence stays untouched (same-seed replays stay identical)
    this.walkPhase = new RNG((seed ^ WALK_PHASE_STREAM_SALT) >>> 0).next() * 6;
    this.body = { x, z, y: 0, radius: 0.3 };
    this.root = new TransformNode('human_' + type + '_' + Math.floor(x) + '_' + Math.floor(z), scene);
    const mat = humanMat(scene);
    const h = type === 'incomplete' ? 1.1 : 1.72;

    const torso = MeshBuilder.CreateBox('torso', { width: 0.34, depth: 0.2, height: h * 0.44 }, scene);
    torso.position.y = h * 0.55;
    torso.parent = this.root;
    const legs = MeshBuilder.CreateBox('legs', { width: 0.3, depth: 0.18, height: h * 0.42 }, scene);
    legs.position.y = h * 0.21;
    legs.parent = this.root;
    const headless = type === 'incomplete' && new RNG(seed ^ 0xdead).chance(0.4);
    const headMesh = MeshBuilder.CreateSphere('head', { diameter: type === 'incomplete' ? 0.16 : 0.21, segments: 6 }, scene);
    headMesh.position.y = h * 0.88;
    headMesh.parent = this.root;
    if (headless) headMesh.isVisible = false; // some reconstructions omit the head entirely
    for (const s of [-1, 1]) {
      const arm = MeshBuilder.CreateBox('arm', { width: 0.09, depth: 0.11, height: h * 0.4 }, scene);
      arm.position.set(s * 0.24, h * 0.56, 0);
      arm.parent = this.root;
    }
    // helper raises one arm, pointing
    if (type === 'helper') {
      const armPt = this.root.getChildMeshes()[2];
      if (armPt) { armPt.rotation.x = -Math.PI / 2.4; armPt.position.z += 0.14; }
    }
    for (const c of this.root.getChildMeshes()) {
      c.material = type === 'believer' ? believerMat(scene) : mat;
      c.isPickable = false;
    }
    this.head = headMesh;
    this.root.position.set(x, 0, z);
  }

  update(dt: number, px: number, pz: number, colliders: readonly Box2[], yawToPlayer: number, litByBeam = false): void {
    this.life += dt;
    if (litByBeam && this.beamFreezeUntil === 0) {
      // caught in the beam: freeze for a moment, then refuse to look at you
      this.beamFreezeUntil = this.life + 2.2;
      this.beamAvoidUntil = this.life + 8;
      this.onBeamFrozen?.();
    }
    const frozen = this.life < this.beamFreezeUntil;
    const avoiding = this.life < this.beamAvoidUntil;
    switch (this.type) {
      case 'watcher': {
        if (frozen) break; // holds perfectly still under the beam
        // body turns slowly; the head is already looking at you
        let dy = yawToPlayer - this.root.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        // after being lit it turns away from you for a while
        const target = avoiding ? yawToPlayer + Math.PI : yawToPlayer;
        let da = target - this.root.rotation.y;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        this.root.rotation.y += da * Math.min(1, dt * (avoiding ? 0.9 : 1.4));
        if (this.nextScanAt === 0) this.nextScanAt = this.life + this.rng.range(4, 9);
        if (!avoiding && this.life >= this.nextScanAt && this.life >= this.scanUntil) {
          // periodically loses interest and slowly scans the corridor instead
          this.scanUntil = this.life + this.rng.range(3, 6);
          this.nextScanAt = this.scanUntil + this.rng.range(5, 11);
        }
        if (!avoiding && this.life < this.scanUntil) {
          // idle scan: slow ±30° head sweep around wherever the body faces
          const center = this.root.rotation.y + Math.PI;
          this.scanPhase += dt * 0.9;
          this.head.rotation.y = center + Math.sin(this.scanPhase) * (Math.PI / 6);
        } else if (!avoiding) {
          let dh = yawToPlayer + Math.PI - this.head.rotation.y;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          this.head.rotation.y += dh * Math.min(1, dt * 6);
        } else {
          this.head.rotation.y *= 1 - Math.min(1, dt * 3);
        }
        break;
      }
      case 'wanderer': {
        // occasionally stops mid-corridor for a long moment
        if (this.pauseUntil > this.life) break;
        if (this.pauseUntil === 0 && this.rng.chance(dt * 0.02)) {
          this.pauseUntil = this.life + 4 + this.rng.next() * 8;
          break;
        }
        // curiosity: stops near interesting props (batteries, signs) to face them
        if (this.curiousUntil > this.life && this.curiousTarget) {
          const cyaw = Math.atan2(this.curiousTarget.x - this.body.x, this.curiousTarget.z - this.body.z);
          let dc = cyaw - this.root.rotation.y;
          while (dc > Math.PI) dc -= Math.PI * 2;
          while (dc < -Math.PI) dc += Math.PI * 2;
          this.root.rotation.y += dc * Math.min(1, dt * 3);
          break;
        }
        if (this.pointsOfInterest.length > 0 && !frozen) {
          for (let i = 0; i < this.pointsOfInterest.length; i++) {
            if (this.visitedPoi.has(i)) continue;
            const p = this.pointsOfInterest[i];
            if (Math.hypot(p.x - this.body.x, p.z - this.body.z) < 2.6) {
              this.visitedPoi.add(i); // each prop fascinates it only once
              this.curiousTarget = { x: p.x, z: p.z };
              this.curiousUntil = this.life + this.rng.range(3, 5);
              break;
            }
          }
          if (this.curiousUntil > this.life) break;
        }
        const sp = 0.85;
        const dx = Math.sin(this.root.rotation.y) * sp * dt;
        const dz = Math.cos(this.root.rotation.y) * sp * dt;
        const before = { x: this.body.x, z: this.body.z };
        moveCircle(this.body, dx, dz, colliders);
        if (Math.hypot(this.body.x - before.x, this.body.z - before.z) < sp * dt * 0.3) {
          this.root.rotation.y += Math.PI / 2 + this.rng.next() * Math.PI;
        }
        this.walkPhase += dt * sp * 3;
        break;
      }
      case 'helper': {
        this.root.rotation.y = yawToPlayer;
        break;
      }
      case 'believer': {
        // still doing their rounds; stops to face you like a colleague
        this.root.rotation.y = yawToPlayer;
        if (this.pauseUntil <= this.life && this.rng.chance(dt * 0.08)) {
          this.pauseUntil = this.life + 2 + this.rng.next() * 4;
          this.root.rotation.y += (this.rng.next() - 0.5) * 3;
        }
        // periodic crouch: pretending to pick something up (-0.1 dip over 0.5s, back over 0.5s)
        if (this.nextWorkAt === 0) this.nextWorkAt = this.life + this.rng.range(15, 25);
        if (this.workStartedAt < 0 && this.life >= this.nextWorkAt) {
          this.workStartedAt = this.life;
          this.nextWorkAt = this.life + this.rng.range(15, 25);
        }
        this.workDip = 0;
        if (this.workStartedAt >= 0) {
          const wt = this.life - this.workStartedAt;
          if (wt < 0.5) this.workDip = -0.1 * (wt / 0.5);
          else if (wt < 1.0) this.workDip = -0.1 * (1 - (wt - 0.5) / 0.5);
          else this.workStartedAt = -1;
        }
        if (this.pauseUntil > this.life || this.workStartedAt >= 0) break;
        const sp = 0.6;
        moveCircle(this.body, Math.sin(this.root.rotation.y) * sp * dt, Math.cos(this.root.rotation.y) * sp * dt, colliders);
        this.walkPhase += dt * sp * 3;
        break;
      }
      case 'incomplete': {
        // perfectly still... unless you light it. then it turns. slowly.
        if (litByBeam) {
          let dy = yawToPlayer - this.root.rotation.y;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          this.root.rotation.y += dy * Math.min(1, dt * 0.7);
        }
        // sudden head jerk every 5-12s, decaying back to rest over ~200ms
        if (this.nextTwitchAt === 0) this.nextTwitchAt = this.life + this.rng.range(5, 12);
        if (this.twitchStart < 0 && this.life >= this.nextTwitchAt) {
          this.twitchBaseY = this.head.rotation.y;
          this.twitchAmp = this.rng.range(-1.1, 1.1);
          if (Math.abs(this.twitchAmp) < 0.35) this.twitchAmp = (this.twitchAmp < 0 ? -1 : 1) * 0.35;
          this.twitchStart = this.life;
          this.nextTwitchAt = this.life + this.rng.range(5, 12);
        }
        if (this.twitchStart >= 0) {
          const tt = this.life - this.twitchStart;
          if (tt < 0.2) this.head.rotation.y = this.twitchBaseY + this.twitchAmp * (1 - tt / 0.2);
          else this.twitchStart = -1;
        }
        break;
      }
      case 'double': {
        // your torch stops it mid-stride; it waits in the dark between pools
        let dh = yawToPlayer + Math.PI - this.head.rotation.y;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        this.head.rotation.y += dh * Math.min(1, dt * 3);
        if (!litByBeam) {
          const sp = 0.9;
          // mirror your CURRENT movement like a reflection: forward stays
          // forward, lateral flips across the line between you and it
          let pvx = 0, pvz = 0;
          if (Number.isFinite(this.prevPx) && dt > 1e-5) {
            pvx = (px - this.prevPx) / dt;
            pvz = (pz - this.prevPz) / dt;
          }
          this.prevPx = px;
          this.prevPz = pz;
          const pSpeed = Math.hypot(pvx, pvz);
          if (pSpeed > 0.08) {
            const ux = Math.sin(yawToPlayer), uz = Math.cos(yawToPlayer); // double -> player
            const dot = pvx * ux + pvz * uz;
            let mx = pvx - 2 * dot * ux; // specular reflection across that line
            let mz = pvz - 2 * dot * uz;
            const ml = Math.hypot(mx, mz) || 1;
            const s = Math.min(sp, pSpeed);
            mx = (mx / ml) * s;
            mz = (mz / ml) * s;
            moveCircle(this.body, mx * dt, mz * dt, colliders);
            this.root.rotation.y = Math.atan2(mx, mz); // face its travel direction
          } else {
            // you stand still: it keeps patiently closing in along the old path
            let dy = yawToPlayer - this.root.rotation.y;
            while (dy > Math.PI) dy -= Math.PI * 2;
            while (dy < -Math.PI) dy += Math.PI * 2;
            this.root.rotation.y += dy * Math.min(1, dt * 2);
            moveCircle(this.body, Math.sin(this.root.rotation.y) * sp * dt, Math.cos(this.root.rotation.y) * sp * dt, colliders);
          }
          this.walkPhase += dt * sp * 3.2;
        }
        break;
      }
    }
    // subtle sway/bob for living feel
    const bob = this.type === 'wanderer' ? Math.sin(this.walkPhase * 2) * 0.02 : Math.sin(this.life * 0.7) * 0.006;
    this.head.rotation.z = Math.sin(this.life * 0.9 + this.walkPhase) * 0.03;
    this.root.position.set(this.body.x, bob + this.workDip, this.body.z);
  }

  dispose(): void {
    this.root.dispose(false, true);
  }
}


