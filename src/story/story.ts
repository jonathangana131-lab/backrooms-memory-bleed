/**
 * Story: expedition objectives, research beacon discoveries, threshold ending.
 * Beacons are deterministic per seed; discovered state is persisted.
 */
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Scene } from '@babylonjs/core/scene';
import { hash2i, RNG } from '../core/rng';
import { CELL } from '../world/constants';
import type { PropInstance } from '../world/architect';

export interface BeaconState {
  cx: number; cz: number;
  x: number; z: number;
  threshold: boolean;
  found: boolean;
}

const LORE: string[] = [
  'BEACON 7-C CONTACTED. "If you can read this, the space has already started copying you. Keep moving. Do not sleep on the carpet."',
  'LOG 31: We watched a corridor rebuild itself overnight. The wallpaper pattern matched a hospital none of us had ever visited. None of us ADMITTED visiting.',
  'LOG 44: It does not store memories. It REPLAYS them with errors, like a tape left in the sun. The errors are load-bearing now.',
  'LOG 52: Team B found a break room identical to theirs, down to the mug. The mug said a name nobody recognized. They drank from it anyway.',
  'LOG 60: Reconsolidation confirmed. The space remembers what YOU remember, badly, and it is starting to remember you back.',
  'LOG 67: Subject Marlow described a bedroom from her childhood. We never gave it the address. It built the room anyway, one floor below where she slept. The glow stars were correct. She never told anyone about the glow stars.',
  'LOG 73: Night guard reports monitors showing rooms that DO NOT EXIST YET. We reviewed the tapes. The rooms appear on camera roughly ninety minutes after he stops writing about them. He has agreed to keep writing.',
  'LOG 81: Communication attempt logged under Protocol R. We left written questions in occupied sectors. Replies arrive overnight, in the asker\u2019s own handwriting. Content analysis: mostly questions back. One reply was a floor plan of this camp.',
  'LOG 88: Two expedition members reunited at junction K-4 after nineteen days apart. Both privately report that the other felt RECONSTRUCTED. Neither will say which one they doubt. We have stopped asking.',
  'FINAL LOG: The Threshold only opens for someone the space finds INTERESTING. Try to stay interesting. - R.',
];

export class StorySystem {
  stage = 0; // 0 intro,1 first beacon,2 three beacons,3 threshold available,4 ended
  discoveries = 0;
  beacons = new Map<string, BeaconState>();
  private meshes = new Map<string, { mesh: Mesh; mat: StandardMaterial }>();
  endingTriggered = false;

  constructor(private scene: Scene, public seed: number) {}

  /** Deterministic beacon placement for a chunk. */
  beaconForChunk(cx: number, cz: number): BeaconState | null {
    const key = cx + ',' + cz;
    const existing = this.beacons.get(key);
    if (existing) return existing;
    if ((hash2i(cx, cz, this.seed ^ 316963681) % 23) !== 5) return null;
    const rng = new RNG(hash2i(cx, cz, this.seed ^ 0x77aa));
    const b: BeaconState = {
      cx, cz,
      x: (cx * 12 + 6 + rng.range(-2, 2)) * CELL,
      z: (cz * 12 + 6 + rng.range(-2, 2)) * CELL,
      threshold: false,
      found: false,
    };
    this.beacons.set(key, b);
    return b;
  }



  /** Guaranteed first beacon near spawn ring and the far threshold. */
  anchors(): { first: BeaconState; threshold: BeaconState } {
    const rng = new RNG(this.seed ^ 0xa11ce);
    const ang = rng.next() * Math.PI * 2;
    const mk = (dist: number, threshold: boolean): BeaconState => {
      const x = Math.cos(ang + (threshold ? 1.3 : 0)) * dist;
      const z = Math.sin(ang + (threshold ? 1.3 : 0)) * dist;
      const cx = Math.floor(x / (CELL * 12));
      const cz = Math.floor(z / (CELL * 12));
      const key = cx + ',' + cz;
      let b = this.beacons.get(key);
      if (!b) {
        b = { cx, cz, x: (cx * 12 + 6) * CELL, z: (cz * 12 + 6) * CELL, threshold, found: false };
        this.beacons.set(key, b);
      }
      return b;
    };
    return { first: mk(105, false), threshold: mk(255, true) };
  }

  /** Abandoned expedition camp around an unfound beacon. */
  campDecor(b: BeaconState): PropInstance[] {
    const rng = new RNG(hash2i(b.cx, b.cz, this.seed ^ 0xcafe));
    const out: PropInstance[] = [];
    const n = b.threshold ? 6 : 4;
    for (let i = 0; i < n; i++) {
      const ang = rng.next() * Math.PI * 2;
      const d = rng.range(1.0, 2.4);
      out.push({
        kind: rng.chance(0.75) ? 'crate' : 'cabinet',
        x: b.x + Math.cos(ang) * d,
        z: b.z + Math.sin(ang) * d,
        rot: rng.int(0, 4) as 0 | 1 | 2 | 3,
        variant: rng.int(0, 3),
      });
    }
    out.push({ kind: 'bench', x: b.x + rng.range(-3, 3), z: b.z + rng.range(-3, 3), rot: rng.int(0, 4) as 0 | 1 | 2 | 3, variant: 1 });
    out.push({ kind: 'stacked_chairs', x: b.x + rng.range(-2.5, 2.5), z: b.z + rng.range(-2.5, 2.5), rot: 0, variant: 2 });
    return out;
  }

  /** Materialize deterministic beacon defs for all chunks in radius. */
  ensureBeaconsAround(cx: number, cz: number, r: number): void {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        void this.beaconForChunk(cx + dx, cz + dz);
      }
    }
  }

  /** Ensure visuals exist for nearby unfound beacons; pulse them. */
  update(px: number, pz: number, time: number): void {
    const view = 90;
    for (const [key, b] of this.beacons) {
      const d = Math.hypot(b.x - px, b.z - pz);
      const have = this.meshes.has(key);
      if (!have && d < view && !b.found) {
        this.buildMesh(key, b);
      }
      const m = this.meshes.get(key);
      if (m) {
        if (d > view + 15 || b.found) {
          m.mesh.dispose();
          this.meshes.delete(key);
          continue;
        }
        const pulse = 0.65 + 0.35 * Math.sin(time * (b.threshold ? 1.4 : 2.6));
        m.mat.emissiveColor = b.threshold
          ? new Color3(0.9 * pulse, 0.9 * pulse, 0.85 * pulse)
          : new Color3(0.25 * pulse, 0.75 * pulse, 0.78 * pulse);
      }
    }
  }

  private buildMesh(key: string, b: BeaconState): void {
    const h = b.threshold ? 3.2 : 2.3;
    const pole = MeshBuilder.CreateBox('beaconPole', { width: 0.14, height: h, depth: 0.14 }, this.scene);
    pole.position.set(b.x, h / 2, b.z);
    const lamp = MeshBuilder.CreateBox('beaconLamp', { width: 0.34, height: 0.22, depth: 0.34 }, this.scene);
    lamp.position.set(b.x, h + 0.11, b.z);
    const mat = new StandardMaterial('beaconMat', this.scene);
    mat.emissiveColor = new Color3(0.3, 0.8, 0.8);
    mat.diffuseColor = new Color3(0.1, 0.12, 0.12);
    mat.disableLighting = true;
    lamp.material = mat;
    pole.material = mat;
    pole.isPickable = false;
    lamp.isPickable = false;
    // combine visually via one entry
    lamp.parent = pole;
    this.meshes.set(key, { mesh: pole, mat });
  }

  /** Returns lore text when the player interacts with a nearby beacon. */
  interact(px: number, pz: number): string | null {
    for (const [key, b] of this.beacons) {
      if (Math.hypot(b.x - px, b.z - pz) > 2.6 || b.found) continue;
      b.found = true;
      const m = this.meshes.get(key);
      if (m) { m.mesh.dispose(); this.meshes.delete(key); }


      if (b.threshold) {
        this.stage = 4;
        this.endingTriggered = true;
        return 'THE THRESHOLD ACCEPTS YOU.';
      }
      const lore = LORE[Math.min(this.discoveries, LORE.length - 1)];
      this.discoveries++;
      if (this.stage === 0) this.stage = 1;
      if (this.discoveries >= 3 && this.stage < 3) this.stage = 3;
      return lore;
    }
    return null;
  }

  /** Nearest unfound beacon distance from a position. */
  targetDistance(px: number, pz: number): number {
    let bd = Infinity;
    for (const b of this.beacons.values()) {
      if (b.found) continue;
      const d = Math.hypot(b.x - px, b.z - pz);
      if (d < bd) bd = d;
    }
    return bd;
  }

  objectiveText(px = 0, pz = 0): string {
    const hint = isFinite(this.targetDistance(px, pz)) ? ' signal ~' + Math.round(this.targetDistance(px, pz)) + 'm' : '';
    switch (this.stage) {
      case 0:
        return 'OBJECTIVE — A research beacon is transmitting somewhere out there. Follow the cyan light.' + hint;
      case 1:
      case 2:
        return 'OBJECTIVE — Find more research beacons (' + this.discoveries + '/3).' + hint;
      case 3:
        return 'OBJECTIVE — The Threshold is open. Reach the white light.' + hint;
      case 4:
        return 'EXPEDITION COMPLETE';
      default:
        return '';
    }
  }

  serialize(): { stage: number; discoveries: number; found: [number, number, boolean][] } {
    const found: [number, number, boolean][] = [];
    for (const b of this.beacons.values()) if (b.found) found.push([b.cx, b.cz, b.threshold]);
    return { stage: this.stage, discoveries: this.discoveries, found };
  }

  static deserialize(scene: Scene, seed: number, data: ReturnType<StorySystem['serialize']> | null): StorySystem {
    const s = new StorySystem(scene, seed);
    if (!data) return s;
    s.stage = data.stage ?? 0;
    s.discoveries = data.discoveries ?? 0;
    for (const [cx, cz, thr] of data.found ?? []) {
      const key = cx + ',' + cz;
      s.beacons.set(key, { cx, cz, x: (cx * 12 + 6) * CELL, z: (cz * 12 + 6) * CELL, threshold: thr, found: true });
    }
    return s;
  }

  clearMeshes(): void {
    for (const m of this.meshes.values()) m.mesh.dispose();
    this.meshes.clear();
  }
}


